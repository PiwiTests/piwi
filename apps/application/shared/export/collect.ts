/**
 * Assembles an `ExportBundle` from the handlers that already back the detail
 * pages, so an export shows exactly what the dashboard shows.
 *
 * Pure data — no storage reads. Asset bytes are fetched later by whichever side
 * is generating the file (see `ExportAssetReader`).
 */
import { testTextLabel } from '#shared/utils/test-label';
import type { DrizzleDB } from '#shared/handlers/db';
import { getTestRunCase, getTestRunCaseTraces } from '#shared/handlers/test-cases';
import { getFailureCluster, getClusterDiagnosis, getExecutionDiagnosis } from '#shared/handlers/failure-clusters';
import { getFailureGroups, getTestRun } from '#shared/handlers/test-runs';
import { classifyEvidenceFile, contentTypeForPath } from '#shared/file-classify';
import { finalAttempts, flakyFinalAttempts, isFailedStatus } from '#shared/utils/test-counts';
import { stripAnsi } from '#shared/error-fingerprint';
import type { ExportAsset, ExportBundle, ExportCase, ExportRunGroup, ExportRunTest } from './types';

export interface CollectOptions {
  /** Member cases carrying full evidence; the rest are listed only. */
  maxCases: number;
  sourceUrl?: string | null;
  piwiVersion?: string | null;
}

/** A filesystem-safe, readable folder name for one case inside a ZIP. */
export function caseSlug(title: string, executionId: number): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'case'}-${executionId}`;
}

function assetsForCase(
  detail: Record<string, any>,
  traces: Record<string, any>[],
  slug: string,
): { assets: ExportAsset[] } {
  const assets: ExportAsset[] = [];

  for (const att of (detail.attachments ?? []) as Record<string, any>[]) {
    if (!att?.path) continue;
    const kind = classifyEvidenceFile({
      type: 'attachment',
      subtype: att.name ?? null,
      label: att.contentType ?? null,
      path: att.path,
    });
    const name = String(att.name || att.path.split('/').pop() || 'attachment');
    assets.push({
      storagePath: att.path,
      zipPath: `evidence/${slug}/${kind === 'attachment' ? 'attachments' : `${kind}s`}/${fileNameOf(att.path, name)}`,
      kind,
      name,
      contentType: contentTypeForPath(att.path, att.contentType),
      size: att.size ?? null,
    });
  }

  for (const trace of traces) {
    if (!trace?.filePath) continue;
    assets.push({
      storagePath: trace.filePath,
      zipPath: `evidence/${slug}/traces/${fileNameOf(trace.filePath, 'trace.zip')}`,
      kind: 'trace',
      name: fileNameOf(trace.filePath, 'trace.zip'),
      contentType: 'application/zip',
      size: trace.size ?? null,
    });
  }

  return { assets };
}

function fileNameOf(storagePath: string, fallback: string): string {
  const raw = storagePath.split('/').pop() || fallback;
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function collectCase(db: DrizzleDB, executionId: number): Promise<ExportCase | null> {
  const detail = (await getTestRunCase(db, executionId)) as Record<string, any> | null;
  if (!detail) return null;

  const [traces, diagnosis] = await Promise.all([
    getTestRunCaseTraces(db, executionId) as Promise<Record<string, any>[]>,
    getExecutionDiagnosis(db, executionId).catch(() => null),
  ]);

  const title =
    typeof detail.title === 'string'
      ? testTextLabel({
          title: detail.title,
          displayTitle: detail.displayTitle as string | null | undefined,
          externalId: detail.externalId as string | null | undefined,
        })
      : `Execution ${executionId}`;
  const slug = caseSlug(title, executionId);
  const { assets } = assetsForCase(detail, traces, slug);

  return {
    executionId,
    testCaseId: detail.testCaseId ?? null,
    title,
    filePath: detail.filePath ?? null,
    location: detail.location ?? null,
    status: String(detail.status ?? 'unknown'),
    slug,
    detail,
    traces,
    diagnosis: (diagnosis as Record<string, any> | null) ?? null,
    assets,
  };
}

export async function collectExecutionBundle(
  db: DrizzleDB,
  executionId: number,
  opts: CollectOptions,
): Promise<ExportBundle | null> {
  const exportCase = await collectCase(db, executionId);
  if (!exportCase) return null;

  const project = (exportCase.detail.testRun as Record<string, any> | undefined)?.project ?? null;

  return {
    kind: 'execution',
    generatedAt: new Date().toISOString(),
    piwiVersion: opts.piwiVersion ?? null,
    sourceUrl: opts.sourceUrl ?? null,
    title: exportCase.title,
    project: project ? { id: project.id, name: project.name, label: project.label ?? null } : null,
    cluster: null,
    cases: [exportCase],
    truncatedCases: [],
    omitted: [],
  };
}

export async function collectClusterBundle(
  db: DrizzleDB,
  clusterId: number,
  opts: CollectOptions,
): Promise<ExportBundle | null> {
  const cluster = (await getFailureCluster(db, clusterId, { affectedTestsLimit: null })) as Record<string, any> | null;
  if (!cluster) return null;

  const { diagnosis } = await getClusterDiagnosis(db, clusterId);

  const members = (cluster.affectedTestCases ?? []) as Record<string, any>[];
  const expanded = members.slice(0, Math.max(1, opts.maxCases));
  const truncated = members.slice(expanded.length);

  const collected = await Promise.all(
    expanded.filter((m) => m.recentTestRunsCaseId != null).map((m) => collectCase(db, Number(m.recentTestRunsCaseId))),
  );
  const cases = collected.filter((c): c is ExportCase => c !== null);

  return {
    kind: 'cluster',
    generatedAt: new Date().toISOString(),
    piwiVersion: opts.piwiVersion ?? null,
    sourceUrl: opts.sourceUrl ?? null,
    title: String(cluster.title || cluster.signature || `Failure cluster ${clusterId}`),
    project: cluster.project
      ? { id: cluster.project.id, name: cluster.project.name, label: cluster.project.label ?? null }
      : null,
    cluster: { ...cluster, diagnosis: diagnosis ?? cluster.diagnosis ?? null },
    cases,
    truncatedCases: truncated.map((m) => ({
      testCaseId: Number(m.testCaseId),
      title: String(m.title ?? ''),
      filePath: m.filePath ?? null,
    })),
    omitted: [],
  };
}

/** Whether a test's outcome in a run is a failure: failed, timed out or interrupted. */
function isFailingOutcome(status: string): boolean {
  return isFailedStatus(status) || status === 'interrupted';
}

/** The run fields an export states, and nothing else of the run row (no local paths, tokens or storage). */
function exportRunDetail(run: Record<string, any>): Record<string, unknown> {
  const scm = (run.metadata?.scm ?? {}) as Record<string, any>;
  const ci = (run.metadata?.ci ?? {}) as Record<string, any>;
  return {
    id: run.id,
    label: run.label ?? null,
    status: run.status,
    branch: run.branch ?? null,
    environment: run.environment ?? null,
    commit: run.commit ?? null,
    origin: run.origin ?? null,
    isFullRun: run.isFullRun,
    startTime: run.startTime ?? null,
    duration: run.duration ?? null,
    totalTests: run.totalTests ?? 0,
    passedTests: run.passedTests ?? 0,
    failedTests: run.failedTests ?? 0,
    flakyTests: run.flakyTests ?? 0,
    skippedTests: run.skippedTests ?? 0,
    didNotRunTests: run.didNotRunTests ?? 0,
    shardTotal: run.shardTotal ?? null,
    playwrightVersion: run.playwrightVersion ?? null,
    metadata: {
      scm: { commit: scm.commit, commitMessage: scm.commitMessage, author: scm.author, branch: scm.branch },
      ci: {
        provider: ci.provider,
        buildNumber: ci.buildNumber,
        runNumber: ci.runNumber,
        pipelineId: ci.pipelineId,
        buildUrl: ci.buildUrl,
      },
    },
  };
}

/**
 * A whole run, as the run page lists it: its row, every test result once (the final attempt of each repetition of a
 * test, per test case and browser), its failures grouped by the failure cluster of each failing result (the most
 * failures first, then the failures no cluster holds), and the failing results in detail in that order, up to
 * `maxCases`.
 */
export async function collectRunBundle(
  db: DrizzleDB,
  runId: number,
  opts: CollectOptions,
): Promise<ExportBundle | null> {
  const run = (await getTestRun(db, runId)) as Record<string, any> | null;
  if (!run) return null;

  type AttemptRow = Record<string, any> & {
    testCaseId: number;
    repeatEachIndex: number | null;
    status: string;
    browserName: string | null;
  };
  const rows = ((run.testCases ?? []) as Record<string, any>[]).map((tc): AttemptRow => ({
    ...tc,
    testCaseId: Number(tc.testCaseId),
    repeatEachIndex: tc.repeatEachIndex ?? null,
    status: String(tc.status ?? 'unknown'),
    browserName: (tc.browserName ?? tc.browser?.projectName ?? null) as string | null,
  }));
  const final = finalAttempts(rows);
  const flaky = flakyFinalAttempts(rows);
  const repeated = final.some((tc) => (tc.repeatEachIndex ?? 0) > 0);
  const tests: ExportRunTest[] = final
    .map((tc) => {
      const error = typeof tc.error === 'string' ? stripAnsi(tc.error).trim() : '';
      return {
        executionId: Number(tc.executionId),
        testCaseId: tc.testCaseId,
        title: testTextLabel({
          title: String(tc.title ?? ''),
          displayTitle: tc.displayTitle,
          externalId: tc.externalId,
        }),
        suitePath: Array.isArray(tc.suitePath) ? (tc.suitePath as unknown[]).map(String) : [],
        filePath: tc.filePath ?? null,
        location: tc.location ?? tc.filePath ?? null,
        browser: tc.browserName,
        repetition: repeated ? (tc.repeatEachIndex ?? 0) + 1 : null,
        status: tc.status,
        flaky: flaky.has(tc),
        retries: Number(tc.retries ?? 0),
        duration: tc.duration == null ? null : Number(tc.duration),
        error: error ? error.split('\n')[0]!.slice(0, 300) : null,
        failureClusterId: tc.failureClusterId == null ? null : Number(tc.failureClusterId),
      };
    })
    .sort(
      (a, b) =>
        String(a.filePath ?? '').localeCompare(String(b.filePath ?? '')) ||
        [...a.suitePath, a.title].join(' ').localeCompare([...b.suitePath, b.title].join(' ')) ||
        String(a.browser ?? '').localeCompare(String(b.browser ?? '')) ||
        (a.repetition ?? 0) - (b.repetition ?? 0),
    );

  // Each failing result under its own failure cluster, the clusters with the most failures first.
  const failing = tests.filter((t) => isFailingOutcome(t.status));
  const members = new Map<number, number[]>();
  for (const t of failing) {
    if (t.failureClusterId == null) continue;
    members.set(t.failureClusterId, [...(members.get(t.failureClusterId) ?? []), t.executionId]);
  }
  const known = new Map(
    ((await getFailureGroups(db, runId)) as Record<string, any>[]).map((g) => [Number(g.clusterId), g]),
  );
  const groups: ExportRunGroup[] = [...members.entries()]
    .sort(([, a], [, b]) => b.length - a.length)
    .map(([clusterId, executionIds]) => {
      const g = known.get(clusterId);
      return {
        clusterId,
        title: String(g?.title || g?.signature || `Failure cluster ${clusterId}`),
        status: String(g?.status ?? 'open'),
        isNew: Boolean(g?.isNew),
        executionIds,
        diagnosis: g?.diagnosis?.status === 'completed' && g.diagnosis.summary ? String(g.diagnosis.summary) : null,
      };
    });

  const order = [
    ...groups.flatMap((g) => g.executionIds),
    ...failing.filter((t) => t.failureClusterId == null).map((t) => t.executionId),
  ];
  const byId = new Map(failing.map((t) => [t.executionId, t]));
  const ranked = order.map((id) => byId.get(id)!).filter(Boolean);
  const expanded = ranked.slice(0, Math.max(0, opts.maxCases));
  const collected = await Promise.all(expanded.map((t) => collectCase(db, t.executionId)));
  const cases = collected.filter((c): c is ExportCase => c !== null);
  const included = new Set(cases.map((c) => c.executionId));

  const project = run.project as Record<string, any> | undefined;
  return {
    kind: 'run',
    generatedAt: new Date().toISOString(),
    piwiVersion: opts.piwiVersion ?? null,
    sourceUrl: opts.sourceUrl ?? null,
    title: run.label ? `Run #${runId} · ${run.label}` : `Run #${runId}`,
    project: project ? { id: project.id, name: project.name, label: project.label ?? null } : null,
    cluster: null,
    run: { detail: exportRunDetail(run), tests, groups },
    cases,
    truncatedCases: ranked
      .filter((t) => !included.has(t.executionId))
      .map((t) => ({ testCaseId: t.testCaseId, title: t.title, filePath: t.filePath, browser: t.browser })),
    omitted: [],
  };
}
