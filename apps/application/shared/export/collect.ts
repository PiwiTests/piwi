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
import { isFailedStatus, testOutcomes } from '#shared/utils/test-counts';
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

/**
 * A whole run: its row, every test once (the attempt that decided its outcome, per test case and browser), its
 * failures grouped by root cause as the run page groups them, and the failing tests in detail, the largest group
 * first, up to `maxCases`.
 */
export async function collectRunBundle(
  db: DrizzleDB,
  runId: number,
  opts: CollectOptions,
): Promise<ExportBundle | null> {
  const run = (await getTestRun(db, runId)) as Record<string, any> | null;
  if (!run) return null;
  const { testCases: attempts = [], suites: _suites, links: _links, project, ...detail } = run;

  type AttemptRow = Record<string, any> & {
    testCaseId: number;
    repeatEachIndex: number | null;
    status: string;
    browserName: string | null;
  };
  const rows = (attempts as Record<string, any>[]).map((tc): AttemptRow => ({
    ...tc,
    testCaseId: Number(tc.testCaseId),
    repeatEachIndex: tc.repeatEachIndex ?? null,
    status: String(tc.status ?? 'unknown'),
    browserName: (tc.browserName ?? tc.browser?.projectName ?? null) as string | null,
  }));
  const tests: ExportRunTest[] = testOutcomes(rows)
    .map((tc) => ({
      executionId: Number(tc.executionId),
      testCaseId: Number(tc.testCaseId),
      title: testTextLabel({ title: String(tc.title ?? ''), displayTitle: tc.displayTitle, externalId: tc.externalId }),
      suitePath: Array.isArray(tc.suitePath) ? (tc.suitePath as unknown[]).map(String) : [],
      filePath: tc.filePath ?? null,
      location: tc.location ?? tc.filePath ?? null,
      browser: tc.browserName,
      status: String(tc.status ?? 'unknown'),
      flaky: tc.status === 'passed' && Number(tc.retries ?? 0) > 0,
      retries: Number(tc.retries ?? 0),
      duration: tc.duration == null ? null : Number(tc.duration),
      error: typeof tc.error === 'string' && tc.error.trim() ? tc.error.trim().split('\n')[0]!.slice(0, 300) : null,
      failureClusterId: tc.failureClusterId == null ? null : Number(tc.failureClusterId),
    }))
    .sort(
      (a, b) =>
        String(a.filePath ?? '').localeCompare(String(b.filePath ?? '')) ||
        [...a.suitePath, a.title].join(' ').localeCompare([...b.suitePath, b.title].join(' ')) ||
        String(a.browser ?? '').localeCompare(String(b.browser ?? '')),
    );

  const failing = tests.filter((t) => isFailingOutcome(t.status));
  const groups: ExportRunGroup[] = ((await getFailureGroups(db, runId)) as Record<string, any>[]).map((g) => ({
    clusterId: Number(g.clusterId),
    title: String(g.title || g.signature || `Failure cluster ${g.clusterId}`),
    status: String(g.status ?? 'open'),
    isNew: Boolean(g.isNew),
    flaky: Boolean(g.flaky),
    testCaseIds: ((g.cases ?? []) as Record<string, any>[]).map((c) => Number(c.testCaseId)),
    diagnosis: g.diagnosis?.status === 'completed' && g.diagnosis.summary ? String(g.diagnosis.summary) : null,
  }));

  // The failing tests in the order the groups list them, then those no group holds.
  const order = new Map<number, number>();
  groups.forEach((g, gi) => g.testCaseIds.forEach((id, i) => order.set(id, gi * 100_000 + i)));
  const rank = (t: ExportRunTest) => order.get(t.testCaseId) ?? Number.MAX_SAFE_INTEGER;
  const ranked = [...failing].sort((a, b) => rank(a) - rank(b));
  const expanded = ranked.slice(0, Math.max(0, opts.maxCases));
  const collected = await Promise.all(expanded.map((t) => collectCase(db, t.executionId)));
  const cases = collected.filter((c): c is ExportCase => c !== null);
  const included = new Set(cases.map((c) => c.executionId));

  return {
    kind: 'run',
    generatedAt: new Date().toISOString(),
    piwiVersion: opts.piwiVersion ?? null,
    sourceUrl: opts.sourceUrl ?? null,
    title: run.label ? `Run #${runId} · ${run.label}` : `Run #${runId}`,
    project: project ? { id: project.id, name: project.name, label: project.label ?? null } : null,
    cluster: null,
    run: { detail, tests, groups },
    cases,
    truncatedCases: ranked
      .filter((t) => !included.has(t.executionId))
      .map((t) => ({ testCaseId: t.testCaseId, title: t.title, filePath: t.filePath })),
    omitted: [],
  };
}
