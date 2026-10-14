import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { describeIngestHealth, readIngestHealth } from '#shared/ingest-health';
import type { SQL } from 'drizzle-orm';
import {
  testRunsCases,
  testCases,
  testSuites,
  testRuns,
  networkRequests,
  files,
  failureDiagnoses,
  failureDiagnosisVersions,
  failureClusters,
} from '../database/schema';
import type { FailureCluster } from '../database/schema';
import type { DiagnosisContextCoverage } from '~~/types/api';
import { stepLabel, orderedStepParams } from '@piwitests/core/step-analysis';
import { stepFailureRoles, type StepFailureRole } from '#shared/step-tree';
import { condenseErrorText, maskVolatile, stripAnsi } from '#shared/error-fingerprint';
import { DIAGNOSIS_SECTIONS } from '#shared/diagnosis-sections';
import { evidenceAbsenceReason } from '#shared/evidence-state';
import { resolveProjectStates } from '#shared/handlers/capabilities';
import { durationStats } from '#shared/utils/stats';
import { eligibleRunSql } from '#shared/run-eligibility';
import { computeRegressionContext } from './regression-context';
import { clusterSuspectLinesForChanges } from './suspect-lines';
import { normalizeGitUrl } from './scm/git-url';
import { inlineCasePayloads } from './case-payloads';
import { createScmProvider, detectScmProvider, resolveScmToken } from './scm';
import { LocalGitProvider } from './scm/local-git';
import { compareUrl, isPlainRevision } from '#shared/scm-urls';
import { PATCH_TRUNCATED_NOTE } from '#shared/patch';
import { suspectLinesContext, suspectLinesReasonText } from '#shared/suspect-lines';
import { MAX_RAW_DIFF_BYTES } from './scm/ScmProvider';
import type { ScmChanges, ChangedFile } from './scm/ScmProvider';
import type {
  BrowserConfig,
  ConsoleLogEntry,
  RunMetadata,
  ServerLogEntry,
  ServerSpanEntry,
  TestStepInfo,
  WebVitals,
} from './run-json-types';
import { resolveContextLimits } from './ai-context-limits';
import type { ContextLimits } from '#shared/ai-context-limits';
import { getCachedTraceSection, getTraceFailingActionSection, setCachedTraceSection } from './trace-parser';
import { getTraceCallStackFromBlob, getTraceNetworkBodyFromBlob, getTraceNetworkFromBlob } from './trace-evidence';
import {
  formatTraceCallStackSection,
  formatTraceNetworkSection,
  selectTraceNetworkRequests,
  type TraceNetworkBodyExcerpt,
} from './trace-insights';
import { getTraceDomSnapshot } from './dom-snapshot';
import { renderAppStateMarkdown, type PageStateLike } from '#shared/page-state';
import { getLastPassPageState, getFailureClues } from '#shared/handlers/test-cases';
import { getLocatorHealing } from './locator-healing';
import { findFixedBefore } from './cluster-memory';
import { healingNotApplicableMarkdown } from '#shared/locator-resolution';
import { getEnvironmentDiff } from './environment-diff';
import { renderEnvironmentDiffMarkdown } from '#shared/environment-diff';
import { selectCaseScreenshots } from './case-screenshots';
import { supportedImageMediaType } from '#shared/file-classify';
import { getOrComputeVisualDiff } from './visual-diff';
import { parseAriaCandidates, textSimilarity } from '#shared/locator-fingerprint';
import { isFailedStatus } from '#shared/utils/test-counts';
import type {
  BuildContextOptions,
  DiagnosisScope,
  SectionId,
  ContextSection,
  BuiltDiagnosisContext,
} from './ai-context.types';
import type { AiAttachedImage } from './ai-provider';
import { getStorage } from '../storage';
import type { DbClient } from '../database';

type ScmCoverage = NonNullable<DiagnosisContextCoverage['scm']>;

/** What the context says about suspect lines: the coverage metadata, or why the section is absent. */
interface SuspectLinesContext {
  coverage: DiagnosisContextCoverage['suspectLines'];
  absentReason: string | null;
}

// ── Section wrapping helper ─────────────────────────────────────────────────

function section(
  id: SectionId,
  title: string,
  content: string | null | undefined,
  items?: number,
): ContextSection | null {
  if (!content) return null;
  return {
    id,
    title,
    chars: content.length,
    truncated: content.includes('[truncated]'),
    markdown: content,
    ...(items !== undefined ? { items } : {}),
  };
}

/**
 * Sections that can only exist when a failure cluster is in scope. For an
 * execution-scope diagnosis with no cluster these are structurally impossible,
 * so the coverage block renders them "not applicable" rather than "absent" —
 * otherwise the model learns to under-confidence for evidence it never could see.
 */
/**
 * Fixed per-image vision-token estimate. Anthropic bills an image at roughly
 * (width × height) / 750 tokens; a typical Playwright screenshot lands near this
 * value, and it is vastly closer to reality than counting base64 chars as text.
 */
const IMAGE_TOKEN_ESTIMATE = 1600;

const CLUSTER_ONLY_SECTIONS = new Set<SectionId>([
  'clusterSummary',
  'sampleError',
  'affectedTests',
  'browserDistribution',
  'recurrenceFlakiness',
  'scmInvestigation',
  'suspectLines',
  'selectedCommits',
  'topSuspectedCommit',
  'priorDiagnosis',
  'previouslyFixed',
]);

/**
 * Fixed narrative order for one-pass reading: coverage (always first, inserted
 * by the assembler) → cluster context → errors → what happened (actions/steps/
 * page state) → runtime signals → history → what changed → prior assessment →
 * supporting artifacts. Sorting by this order also stabilizes output for prompt
 * caching across re-runs.
 */
const SECTION_ORDER: SectionId[] = [
  'clusterSummary',
  'sampleError',
  'executionError',
  'clues',
  'representativeExecution',
  'testSource',
  'sourceFiles',
  'traceCallStack',
  'failingAction',
  'failingSteps',
  'steps',
  'aiSteps',
  'ariaSnapshot',
  'domSnapshot',
  'screenshots',
  'visualDiff',
  'nearestAriaNames',
  'locatorHealing',
  'console',
  'networkRequests',
  'traceNetwork',
  'serverLogs',
  'serverTraces',
  'webVitals',
  'appState',
  'retryProgression',
  'baselineComparison',
  'environmentDiff',
  'recurrenceFlakiness',
  'browserDistribution',
  'affectedTests',
  'passedPeers',
  'suspectLines',
  'scmInvestigation',
  'topSuspectedCommit',
  'selectedCommits',
  'priorDiagnosis',
  'previouslyFixed',
  'runContext',
  'testAnnotations',
  'tracePointers',
  'artifacts',
];

/**
 * Build the "## Data Coverage" block: a compact present/absent/not-applicable map
 * of the evidence available for this diagnosis, prepended to the AI context so the
 * model can ground its confidence in what it could actually see. The expected
 * section list is shared with the UI via `#shared/diagnosis-sections` and the
 * applicable subset is scope-aware.
 */
function buildCoverageBlock(
  sections: ContextSection[],
  opts: { hasCluster: boolean; notApplicable?: Record<string, string>; absentReasons?: Record<string, string> },
): string {
  const byId = new Map<string, ContextSection>();
  for (const s of sections) if (!byId.has(s.id)) byId.set(s.id, s);
  const notApplicable = opts.notApplicable ?? {};
  const absentReasons = opts.absentReasons ?? {};

  const lines = [
    '## Data Coverage',
    'Evidence available for this diagnosis. Absent or truncated sections mean you are working with partial information — calibrate confidenceScore accordingly and do not assert what you could not see. Sections marked "not applicable" carry no signal for this scope; do not treat them as gaps.',
    '',
  ];
  for (const { id, label } of DIAGNOSIS_SECTIONS) {
    const s = byId.get(id);
    let state: string;
    if (s) {
      state = s.truncated ? 'present (truncated)' : 'present';
    } else if (notApplicable[id]) {
      state = `not applicable (${notApplicable[id]})`;
    } else if (!opts.hasCluster && CLUSTER_ONLY_SECTIONS.has(id as SectionId)) {
      state = 'not applicable (execution scope, no cluster)';
    } else if (absentReasons[id]) {
      state = `absent (${absentReasons[id]})`;
    } else {
      state = 'absent (no data)';
    }
    lines.push(`- [${id}] ${label}: ${state}`);
  }
  return lines.join('\n');
}

// ── SCM diff rendering ──────────────────────────────────────────────────────

/** "- path (status, +A -B)" line for a changed file. */
function formatChangedFileLine(f: ChangedFile): string {
  const stats = f.additions || f.deletions ? `, +${f.additions} -${f.deletions}` : '';
  return `- ${f.filename} (${f.status}${stats})`;
}

/**
 * Render changed-file patches into `--- file\n<patch>` blocks within a shared
 * character budget (mutated across calls so it can span multiple commits).
 * Returns the rendered blocks plus how many files were dropped once the budget
 * was exhausted.
 */
function renderBudgetedPatches(
  files: ChangedFile[],
  budget: { remaining: number },
): { patches: string[]; skipped: number } {
  const patches: string[] = [];
  let skipped = 0;
  for (const f of files) {
    if (!f.patch) continue;
    if (budget.remaining <= 0) {
      skipped++;
      continue;
    }
    const patch =
      f.patch.length > budget.remaining ? `${f.patch.slice(0, budget.remaining)}\n${PATCH_TRUNCATED_NOTE}` : f.patch;
    budget.remaining -= Math.min(f.patch.length, budget.remaining);
    patches.push(`--- ${f.filename}\n${patch}`);
  }
  return { patches, skipped };
}

/**
 * Render a "commits + changed files + budgeted patches" section for an SCM diff.
 * Shared by the last-green and manual-baseline paths.
 */
function renderChangedFiles(
  changes: ScmChanges,
  opts: { title: string; budget: number },
): { text: string; patchedFilesCount: number; patchesTruncated: boolean } {
  const lines: string[] = [opts.title];
  if (changes.commits.length > 0) {
    lines.push('Commits:');
    for (const c of changes.commits) lines.push(`- ${c.sha} ${c.message}`);
  }
  lines.push(`\nChanged files (${changes.files.length}):`);
  for (const f of changes.files) lines.push(formatChangedFileLine(f));

  let patchedFilesCount = 0;
  let patchesTruncated = false;
  if (changes.patchesOmitted) {
    lines.push(
      `\n> Note: diff omitted — raw diff exceeded size limit (${Math.round(MAX_RAW_DIFF_BYTES / 1024)} KB). File names and line counts above are complete; no patch content available.`,
    );
  } else {
    const budget = { remaining: opts.budget };
    const { patches, skipped } = renderBudgetedPatches(changes.files, budget);
    if (patches.length > 0) {
      lines.push(`\nPatches:\n\`\`\`diff\n${patches.join('\n\n')}\n\`\`\``);
      patchedFilesCount = patches.length;
      patchesTruncated = skipped > 0;
    }
    if (skipped > 0) {
      lines.push(`\n> Note: ${skipped} file patch${skipped > 1 ? 'es' : ''} omitted (context budget exhausted).`);
    }
  }
  return { text: lines.join('\n'), patchedFilesCount, patchesTruncated };
}

// ── Section builders ────────────────────────────────────────────────────────
// Each returns the markdown for one context section (or null to omit it).

async function clusterSummarySection(db: DbClient, cluster: FailureCluster): Promise<string> {
  // Resolve timestamps for first/last seen runs to add relative-time anchors —
  // "run #142" is meaningless to both the model and the human reading the preview.
  const runIds = [cluster.firstSeenRunId, cluster.lastSeenRunId].filter((id) => id != null);
  const runTimes = new Map<number, Date>();
  if (runIds.length > 0) {
    const rows = await db
      .select({ id: testRuns.id, startTime: testRuns.startTime })
      .from(testRuns)
      .where(inArray(testRuns.id, runIds));
    for (const r of rows) {
      if (r.startTime instanceof Date) runTimes.set(r.id, r.startTime);
    }
  }
  const firstWhen = runTimes.has(cluster.firstSeenRunId)
    ? ` (${relativeDays(runTimes.get(cluster.firstSeenRunId)!)})`
    : '';
  const lastWhen = runTimes.has(cluster.lastSeenRunId)
    ? ` (${relativeDays(runTimes.get(cluster.lastSeenRunId)!)})`
    : '';
  return `## Failure Cluster
- Signature: ${cluster.signature}
- Error type: ${cluster.errorType ?? 'unknown'}
- Selector: ${cluster.selector ?? 'none'}
- Triage status: ${cluster.status}
- Total occurrences: ${cluster.occurrences}
- First seen: run #${cluster.firstSeenRunId}${firstWhen}
- Last seen: run #${cluster.lastSeenRunId}${lastWhen}`;
}

function sampleErrorSection(cluster: FailureCluster, limits: ContextLimits): string | null {
  if (!cluster.sampleError) return null;
  const condensed = condenseErrorText(stripAnsi(cluster.sampleError), limits.sampleErrorChars);
  return `## Sample Raw Error\n\`\`\`\n${condensed}\n\`\`\``;
}

async function affectedTestsSection(
  db: DbClient,
  cluster: FailureCluster,
  limits: ContextLimits,
): Promise<string | null> {
  const affectedRows = await db
    .select({
      title: testCases.title,
      filePath: testCases.filePath,
      line: sql<number | null>`MAX(${testRunsCases.line})`,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.failureClusterId, cluster.id))
    .groupBy(testCases.id)
    .limit(limits.affectedTests + 1);

  if (affectedRows.length === 0) return null;

  const shown = affectedRows.slice(0, limits.affectedTests);
  const extra =
    affectedRows.length > limits.affectedTests ? `\n…and ${affectedRows.length - limits.affectedTests} more` : '';
  return `## Affected Tests\n${shown.map((t) => `- ${t.title} (${t.filePath}${t.line ? `:${t.line}` : ''})`).join('\n')}${extra}`;
}

async function browserDistributionSection(db: DbClient, cluster: FailureCluster): Promise<string | null> {
  const browserRows = await db
    .select({
      browser: testRunsCases.browser,
      count: sql<number>`COUNT(*)`.mapWith(Number),
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.failureClusterId, cluster.id))
    .groupBy(testRunsCases.browser);

  if (browserRows.length === 0) return null;

  const browserSummary = browserRows
    .map((r) => {
      const b = r.browser as BrowserConfig | null;
      const name = [b?.projectName, b?.browserName].filter(Boolean).join(' / ') || 'unknown';
      return `- ${name}: ${r.count} failure${r.count === 1 ? '' : 's'}`;
    })
    .join('\n');
  return `## Browser Distribution\n${browserSummary}`;
}

/** Shared select for an execution row + its test/run metadata. Filtered by the given `where`. */
async function loadExecutionRow(db: DbClient, where: SQL) {
  const repRows = await db
    .select({
      id: testRunsCases.id,
      testRunId: testRunsCases.testRunId,
      error: testRunsCases.error,
      browser: testRunsCases.browser,
      retries: testRunsCases.retries,
      duration: testRunsCases.duration,
      line: testRunsCases.line,
      column: testRunsCases.column,
      steps: testRunsCases.steps,
      consoleLogs: testRunsCases.consoleLogs,
      ariaSnapshot: testRunsCases.ariaSnapshot,
      testSource: testRunsCases.testSource,
      ariaSnapshotPayloadId: testRunsCases.ariaSnapshotPayloadId,
      testSourcePayloadId: testRunsCases.testSourcePayloadId,
      webVitals: testRunsCases.webVitals,
      pageState: testRunsCases.pageState,
      aiUsage: testRunsCases.aiUsage,
      evidenceSources: testRunsCases.evidenceSources,
      testAnnotations: testRunsCases.testAnnotations,
      workerIndex: testRunsCases.workerIndex,
      shardIndex: testRunsCases.shardIndex,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      startedAt: testRunsCases.startedAt,
      projectId: testCases.projectId,
      testTitle: testCases.title,
      testFilePath: testCases.filePath,
      testSuitePath: testCases.suitePath,
      flakyRootCause: testCases.flakyRootCause,
      suiteMode: testSuites.mode,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .leftJoin(testSuites, eq(testCases.suiteId, testSuites.id))
    .where(where)
    .orderBy(desc(testRunsCases.id))
    .limit(1);

  const repRow = repRows[0] ?? null;
  if (!repRow) return null;

  // ARIA snapshot / test source are content-addressed on new rows.
  const rep = await inlineCasePayloads(db, repRow);

  const [runRow, nrRows] = await Promise.all([
    db
      .select({
        environment: testRuns.environment,
        metadata: testRuns.metadata,
        isFullRun: testRuns.isFullRun,
        filterDetails: testRuns.filterDetails,
        startTime: testRuns.startTime,
      })
      .from(testRuns)
      .where(eq(testRuns.id, rep.testRunId))
      .limit(1),
    db.select().from(networkRequests).where(eq(networkRequests.testRunsCaseId, rep.id)),
  ]);

  const run = runRow[0] ?? null;

  return {
    ...rep,
    nrItems: nrRows,
    runEnvironment: run?.environment ?? null,
    runMetadata: (run?.metadata as RunMetadata | null) ?? null,
    runIsFullRun: run?.isFullRun ?? null,
    runFilterDetails: (run?.filterDetails as { grep?: string; grepInvert?: string } | null) ?? null,
    runStartTime: run?.startTime instanceof Date ? run.startTime : null,
  };
}

/** Latest run-case for this cluster — the diagnosis's main evidence in cluster scope. */
function loadRepresentativeExecution(db: DbClient, cluster: FailureCluster) {
  return loadExecutionRow(db, eq(testRunsCases.failureClusterId, cluster.id));
}

/** A specific run-case by id — the diagnosis's main evidence in execution scope. */
function loadExecutionById(db: DbClient, testRunsCaseId: number) {
  return loadExecutionRow(db, eq(testRunsCases.id, testRunsCaseId));
}

type RepresentativeRow = NonNullable<Awaited<ReturnType<typeof loadExecutionRow>>>;

/** Build a CI/run header string from the representative execution's run metadata. */
function ciRunHeaderLines(rep: RepresentativeRow): string[] {
  const lines: string[] = [];
  const meta = rep.runMetadata as RunMetadata | null;
  const env = rep.runEnvironment as Record<string, string> | null;

  if (meta?.scm?.commit) {
    const short = meta.scm.commit.slice(0, 7);
    lines.push(`- Commit: ${short}`);
  }
  if (meta?.scm?.branch) lines.push(`- Branch: ${meta.scm.branch}`);
  if (meta?.ci?.provider) lines.push(`- CI: ${meta.ci.provider}`);
  if (env?.workerIndex != null) lines.push(`- Worker: ${env.workerIndex}`);
  if (env?.os) lines.push(`- OS: ${env.os}`);
  if (env?.hostname) lines.push(`- Hostname: ${env.hostname}`);
  return lines;
}

/**
 * A step's params on one line, omitting `locator` (it is already the step's
 * label). Surfaces a navigation's full URL, an action's value/button and a
 * `test.step` author's own values (`{ user: 'admin' }`); null when the step
 * carried none worth printing.
 */
function stepParamsLine(step: TestStepInfo): string | null {
  const entries = orderedStepParams(step.params).filter(([key]) => key !== 'locator');
  if (entries.length === 0) return null;
  return `Parameters: ${entries.map(([key, value]) => `${key}=${value}`).join(', ')}`;
}

/** Where each failure role sorts in "Failed Steps": the failing chain first, then the rest in step order. */
const FAILED_STEP_RANK: Record<StepFailureRole, number> = { failing: 0, enclosing: 1, failed: 2, recovered: 2 };

/**
 * Extract steps that have an error attached: the step that failed the
 * test first, then the steps around it (same error, not repeated), then the
 * other errored steps in order — another error the test ended with, or one the
 * test caught and went on from, labeled so.
 */
export function failingStepsSection(rep: RepresentativeRow, limits: ContextLimits): string | null {
  const steps = (rep.steps as TestStepInfo[] | null) ?? [];
  const roles = stepFailureRoles(steps, rep.error);
  const errored = steps.flatMap((step, i) => {
    const role = roles[i];
    return step.error?.message && role ? [{ step, role }] : [];
  });
  if (errored.length === 0) return null;
  const ordered = [...errored].sort((a, b) => FAILED_STEP_RANK[a.role] - FAILED_STEP_RANK[b.role]);
  const out = ordered.map(({ step, role }) => {
    const head = `- [${step.category ?? 'step'}] ${stepLabel(step)}`;
    if (role === 'enclosing') return `${head} (around the failing step, same error)`;
    const note = role === 'recovered' ? ' (caught, the test continued)' : '';
    const params = stepParamsLine(step);
    const paramLine = params ? `\n  ${params}` : '';
    return `${head}${note}${paramLine}\n\`\`\`\n${condenseErrorText(step.error!.message!, limits.sampleErrorChars)}\n\`\`\``;
  });
  return `### Failed Steps\n${out.join('\n')}`;
}

/** Runtime test annotations (@fixme/@flaky/@slow …) declared on the test. */
function testAnnotationsSection(rep: RepresentativeRow): string | null {
  const ann = rep.testAnnotations as Array<{ type?: string; description?: string }> | null;
  if (!ann || ann.length === 0) return null;
  const lines = ann.filter((a) => a?.type).map((a) => `- @${a.type}${a.description ? `: ${a.description}` : ''}`);
  if (lines.length === 0) return null;
  return `## Test Annotations\nMarks declared on the test — treat known @fixme/@flaky/@skip as established context, not new findings:\n${lines.join('\n')}`;
}

/**
 * Run-level context that shapes interpretation: partial/filtered run, parallel
 * worker/shard (race hint), describe-block path, and any pre-classified flaky
 * root cause. All from data already stored — no extra collection.
 */
export function runContextSection(rep: RepresentativeRow): string | null {
  const lines: string[] = [];

  if (rep.runIsFullRun === 0) {
    const fd = rep.runFilterDetails;
    const filt = fd?.grep ? ` (grep: ${fd.grep})` : fd?.grepInvert ? ` (grepInvert: ${fd.grepInvert})` : '';
    lines.push(
      `- Partial/filtered run${filt} — not the full suite; missing peers may be due to filtering, not passing`,
    );
  }

  const sp = rep.testSuitePath;
  if (sp) lines.push(`- Describe path: ${sp.split('\x1f').join(' › ')}`);

  if (rep.workerIndex != null) {
    const shard = rep.shardIndex != null ? `, shard ${rep.shardIndex}` : '';
    lines.push(
      `- Parallel worker #${rep.workerIndex}${shard} — consider a race if peers on the same worker also failed`,
    );
  }

  if (rep.flakyRootCause) {
    lines.push(`- Pre-classified flaky root cause (heuristic): ${rep.flakyRootCause}`);
  }

  // What ingest left out of the run: a step or console line absent here may have been dropped, not skipped.
  const ingestNotes = describeIngestHealth(readIngestHealth(rep.runMetadata));
  if (ingestNotes.length > 0) {
    lines.push(
      `- Stored incomplete — absent steps, console lines or evidence may have been left out at ingest, not missing from the test: ${ingestNotes.join('; ')}`,
    );
  }

  if (lines.length === 0) return null;
  return `## Run Context\n${lines.join('\n')}`;
}

function countConsoleErrors(logs: ConsoleLogEntry[] | null): number {
  if (!Array.isArray(logs)) return 0;
  return logs.filter((l) => l?.type === 'error').length;
}

function relativeDays(d: Date): string {
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/** Failing-vs-passing deltas for the web vitals we collect. */
function compareVitals(fail: WebVitals | null, pass: WebVitals | null): string[] {
  if (!fail || !pass) return [];
  const pairs: Array<[string, number | null | undefined, number | null | undefined]> = [
    ['LCP', fail.vitals?.lcp, pass.vitals?.lcp],
    ['INP', fail.vitals?.inp, pass.vitals?.inp],
    ['FCP', fail.paint?.firstContentfulPaint, pass.paint?.firstContentfulPaint],
    ['DOMContentLoaded', fail.navigation?.domContentLoaded, pass.navigation?.domContentLoaded],
  ];
  const out: string[] = [];
  for (const [name, f, p] of pairs) {
    if (typeof f === 'number' && typeof p === 'number') {
      const delta = Math.round(f - p);
      out.push(
        `- ${name}: failing ${Math.round(f)}ms vs passing ${Math.round(p)}ms (${delta >= 0 ? '+' : ''}${delta}ms)`,
      );
    }
  }
  // CLS is unitless — compared separately from the ms-based pairs.
  const failCls = fail.vitals?.cls;
  const passCls = pass.vitals?.cls;
  if (typeof failCls === 'number' && typeof passCls === 'number' && failCls !== passCls) {
    const delta = Math.round((failCls - passCls) * 10000) / 10000;
    out.push(`- CLS: failing ${failCls} vs passing ${passCls} (${delta >= 0 ? '+' : ''}${delta})`);
  }
  return out;
}

/**
 * Compare the failing execution to the same test's recent passing runs:
 * duration vs baseline, web-vitals deltas, console-error delta, how far the
 * run got (steps executed), and whether the test has passed since the
 * cluster's last seen run on that run's branch (already-green reconciliation).
 * Only runs eligible as a baseline count as a pass: a lab arm, a bisect step or
 * a reproduction does not. All from data already stored — no extra collection.
 */
export async function baselineComparisonSection(
  db: DbClient,
  rep: RepresentativeRow,
  clusterLastSeenRunId?: number,
): Promise<{ section: string | null; alreadyGreen: boolean }> {
  if (rep.testCaseId == null) return { section: null, alreadyGreen: false };

  const passings = await db
    .select({
      duration: testRunsCases.duration,
      webVitals: testRunsCases.webVitals,
      consoleLogs: testRunsCases.consoleLogs,
      steps: testRunsCases.steps,
      runId: testRunsCases.testRunId,
      startTime: testRuns.startTime,
      branch: testRuns.branch,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(
      and(eq(testRunsCases.testCaseId, rep.testCaseId), eq(testRunsCases.status, 'passed'), eligibleRunSql('baseline')),
    )
    .orderBy(desc(testRuns.startTime))
    .limit(20);

  if (passings.length === 0) return { section: null, alreadyGreen: false };

  const last = passings[0]!;
  const lines: string[] = [];

  // A pass after the cluster's last seen run, on that run's branch.
  const [lastSeen] =
    clusterLastSeenRunId != null
      ? await db
          .select({ startTime: testRuns.startTime, branch: testRuns.branch })
          .from(testRuns)
          .where(eq(testRuns.id, clusterLastSeenRunId))
      : [];
  const newerPass = lastSeen
    ? passings.find((p) => p.startTime > lastSeen.startTime && p.branch === lastSeen.branch)
    : undefined;
  const alreadyGreen = newerPass !== undefined;
  if (newerPass) {
    const when = newerPass.startTime instanceof Date ? relativeDays(newerPass.startTime) : null;
    lines.push(
      `⚠️ This test has PASSED since the failure (run #${newerPass.runId}, after failing run #${clusterLastSeenRunId}${newerPass.branch ? ` on ${newerPass.branch}` : ''}). The cluster may already be resolved; diagnose the historical failure, or re-triage as fixed.`,
    );
    if (when) lines.push(`- Last passing run: #${newerPass.runId} (${when})`);
  }

  const when = last.startTime instanceof Date ? relativeDays(last.startTime) : null;
  if (!alreadyGreen) {
    lines.push(`- Last passed: run #${last.runId}${when ? ` (${when})` : ''}`);
  }

  const stats = durationStats(passings.map((p) => p.duration));
  if (stats && rep.duration != null) {
    const ratio = stats.avg > 0 ? rep.duration / stats.avg : 0;
    const ratioStr = ratio >= 1.5 ? ` — ${ratio.toFixed(1)}× the passing average` : '';
    lines.push(`- Duration: failing ${rep.duration}ms vs passing avg ${stats.avg}ms / p90 ${stats.p90}ms${ratioStr}`);
  }

  lines.push(...compareVitals(rep.webVitals as WebVitals | null, last.webVitals as WebVitals | null));

  const failErrors = countConsoleErrors(rep.consoleLogs as ConsoleLogEntry[] | null);
  const passErrors = countConsoleErrors(last.consoleLogs as ConsoleLogEntry[] | null);
  if (failErrors !== passErrors) {
    lines.push(`- Console errors: ${failErrors} in the failing run vs ${passErrors} when it last passed`);
  }

  const failSteps = Array.isArray(rep.steps) ? rep.steps.length : null;
  const passSteps = Array.isArray(last.steps) ? last.steps.length : null;
  if (failSteps != null && passSteps != null && failSteps < passSteps) {
    lines.push(`- Steps executed: ${failSteps} (stopped early) vs ${passSteps} when passing`);
  }

  if (lines.length === 0) return { section: null, alreadyGreen };
  return {
    section: `## Compared to Last Pass\nSame test, failing execution vs its recent passing runs:\n${lines.join('\n')}`,
    alreadyGreen,
  };
}

/**
 * App state at test end (URL, storage keys, cookie flags — never values),
 * with a diff against the last passing execution's captured state when one
 * exists. A vanished auth cookie or a missing storage key is a classic
 * "logged-out mid-test" smoking gun.
 */
async function appStateSection(
  db: DbClient,
  rep: RepresentativeRow,
): Promise<{ section: string | null; coverage: DiagnosisContextCoverage['appState'] }> {
  const failing = rep.pageState as PageStateLike | null;
  if (!failing) return { section: null, coverage: null };

  const baseline =
    rep.testCaseId != null
      ? ((await getLastPassPageState(db, {
          testCaseId: rep.testCaseId,
          browserName: rep.browserName,
        })) as PageStateLike | null)
      : null;

  const markdown = renderAppStateMarkdown(failing, baseline);
  if (!markdown) return { section: null, coverage: null };
  return { section: markdown, coverage: { hasBaseline: baseline != null } };
}

/**
 * Environment diff vs the last passing execution: whitelisted run/browser
 * metadata keys that changed between the failing execution and the same
 * test's most recent pass. "No differences" is positive evidence (rules out
 * environment drift), so the section still renders with zero changed keys.
 */
async function environmentDiffSection(
  db: DbClient,
  rep: RepresentativeRow,
): Promise<{ section: string | null; coverage: DiagnosisContextCoverage['environmentDiff'] }> {
  const result = await getEnvironmentDiff(db, rep.id);
  const markdown = renderEnvironmentDiffMarkdown(result);
  if (!markdown || !result.baseline) return { section: null, coverage: null };
  return {
    section: markdown,
    coverage: {
      changedKeys: (result.entries ?? []).filter((e) => !e.informational).length,
      baselineRunId: result.baseline.runId,
    },
  };
}

/**
 * Deterministic clues for the representative execution: the rule-based
 * correlations `buildFailureClues` finds over the same evidence, rendered as
 * ranked lines each carrying the `[section]` citation of the evidence it came
 * from — so the model reads them as findings to confirm or refute, not as
 * conclusions, and can follow each back to its source.
 */
async function cluesSection(db: DbClient, rep: RepresentativeRow, limits: ContextLimits): Promise<string | null> {
  const { clues, story } = await getFailureClues(db, rep.id, { slowRequestMs: limits.slowRequestMs });
  if (clues.length === 0) return null;
  const lines = clues.map((clue) => {
    const cites = clue.citations.map((c) => `[${c.section}]`).join('');
    return `- [${clue.strength}] ${clue.title} — ${clue.detail} ${cites}`.trimEnd();
  });
  // When the clues chain into a story, lead with its one-sentence summary so the
  // model reads the correlation before the individual findings.
  const storyLine = story ? `**Most likely:** ${story.sentence} [${story.strength}]\n\n` : '';
  return `## Clues\n${storyLine}Deterministic, rule-based correlations found in the evidence below. Treat each as a hypothesis to confirm or refute against its cited section, not as a conclusion:\n${lines.join('\n')}`;
}

/**
 * Per-attempt error progression for the failing test in its run. Each retry is
 * already stored as its own row (dedup key includes `retries`), so this needs no
 * extra collection. The progression discriminates a deterministic bug (same
 * error every attempt) from flakiness (passes on retry) or a race (differing
 * errors).
 */
async function retryProgressionSection(db: DbClient, rep: RepresentativeRow): Promise<string | null> {
  if (rep.testCaseId == null) return null;

  const conds = [eq(testRunsCases.testRunId, rep.testRunId), eq(testRunsCases.testCaseId, rep.testCaseId)];
  if (rep.browserName) conds.push(eq(testRunsCases.browserName, rep.browserName));

  const attempts = await db
    .select({ retries: testRunsCases.retries, status: testRunsCases.status, error: testRunsCases.error })
    .from(testRunsCases)
    .where(and(...conds))
    .orderBy(testRunsCases.retries);

  if (attempts.length <= 1) return null;

  const firstLine = (e: string | null) =>
    e
      ? (stripAnsi(e)
          .split('\n')
          .find((l) => l.trim()) ?? '')
      : '';
  const lines = attempts.map((a) => {
    const head = a.error ? firstLine(a.error).slice(0, 200) : '(no error)';
    return `- Attempt ${a.retries ?? 0} — ${a.status}: ${head}`;
  });

  const failHeads = attempts.filter((a) => a.error).map((a) => firstLine(a.error));
  const passed = attempts.some((a) => a.status === 'passed');
  const allSameError = failHeads.length > 1 && failHeads.every((h) => h === failHeads[0]);
  let insight: string;
  if (passed) {
    insight = `The test passed on retry — an intermittent/flaky failure${allSameError ? ' (the same error on each failing attempt)' : ''}.`;
  } else if (allSameError) {
    insight = 'Every attempt failed with the same error — points to a deterministic bug, not flakiness.';
  } else {
    insight = 'Attempts failed with differing errors — suggests an unstable environment or a race condition.';
  }
  return `## Retry Progression\n${insight}\n${lines.join('\n')}`;
}

/** Tests in the same file that passed in the representative execution's run. */
async function passedPeersSection(
  db: DbClient,
  rep: RepresentativeRow,
  limits: ContextLimits,
): Promise<{ section: string | null; notApplicableReason: string | null }> {
  const testFilePath = rep.testFilePath;
  if (!testFilePath) return { section: null, notApplicableReason: null };

  // Detect serial mode from the suite's stored parallel mode, not from the suite title substring.
  const serialMode = rep.suiteMode === 'serial';

  if (serialMode) {
    // Check if peers exist but were skipped (serial mode — one failure skips the rest)
    const skippedPeers = await db
      .select({ id: testRunsCases.id })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
      .where(
        and(
          eq(testRunsCases.testRunId, rep.testRunId),
          eq(testRunsCases.status, 'skipped'),
          eq(testCases.filePath, testFilePath),
        ),
      )
      .limit(1);

    if (skippedPeers.length > 0) {
      return {
        section: null,
        notApplicableReason: 'peers skipped (serial mode) — not a signal',
      };
    }
  }

  const peers = await db
    .select({ title: testCases.title })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(
      and(
        eq(testRunsCases.testRunId, rep.testRunId),
        eq(testRunsCases.status, 'passed'),
        eq(testCases.filePath, testFilePath),
      ),
    )
    .limit(limits.maxPassedPeers + 1);

  if (peers.length === 0) return { section: null, notApplicableReason: null };
  const shown = peers.slice(0, limits.maxPassedPeers);
  const extra = peers.length > limits.maxPassedPeers ? `\n…and ${peers.length - limits.maxPassedPeers} more` : '';
  return {
    section: `## Passed Peers\n${shown.map((t) => `- ${t.title}`).join('\n')}${extra}`,
    notApplicableReason: null,
  };
}

/** Trace file URLs for the representative execution. */
async function tracePointersSection(db: DbClient, rep: RepresentativeRow): Promise<string | null> {
  const traceFiles = await db
    .select({ path: files.path, label: files.label })
    .from(files)
    .where(and(eq(files.testRunsCaseId, rep.id), eq(files.type, 'trace')))
    .limit(5);
  if (traceFiles.length === 0) return null;
  const lines = traceFiles.map((f) => `- ${f.label || 'Trace'}: /api/files/${f.path}`);
  return `## Trace Files\n${lines.join('\n')}`;
}

/** Parse the Playwright trace ZIP for the failing action context. */
async function failingActionSection(
  db: DbClient,
  rep: RepresentativeRow,
  limits: ContextLimits,
): Promise<string | null> {
  if (limits.maxTraceActions <= 0) return null;

  const blobPath = await resolveTraceBlobPath(db, rep.id);
  if (!blobPath) return null;

  return getTraceFailingActionSection(db, blobPath, limits);
}

/** Path of the execution's stored (slim) trace blob, or null when no trace was uploaded. */
async function resolveTraceBlobPath(db: DbClient, testRunsCaseId: number): Promise<string | null> {
  const traceFiles = await db
    .select({ path: files.path })
    .from(files)
    .where(and(eq(files.testRunsCaseId, testRunsCaseId), eq(files.type, 'trace')))
    .limit(1);
  return traceFiles[0]?.path || null;
}

/**
 * Failure-time DOM snapshot rendered from the stored trace ZIP — richer than
 * the flat ARIA snapshot (real tags, ids, classes, hidden elements) at zero
 * capture cost. Returns coverage alongside the section.
 */
async function domSnapshotSection(
  db: DbClient,
  rep: RepresentativeRow,
  limits: ContextLimits,
): Promise<{ section: string | null; coverage: DiagnosisContextCoverage['domSnapshot'] }> {
  if (limits.domSnapshotChars <= 0) return { section: null, coverage: null };

  const blobPath = await resolveTraceBlobPath(db, rep.id);
  if (!blobPath) return { section: null, coverage: null };

  const result = await getTraceDomSnapshot(blobPath, limits.domSnapshotChars);
  if (result.status !== 'ok' || !result.html) return { section: null, coverage: null };

  const origin = result.snapshotName ? ` (trace snapshot \`${result.snapshotName}\`)` : '';
  const markdown = `## DOM Snapshot (failure time, from trace)\nSanitized HTML of the page as Playwright recorded it around the failing action${origin} — input values, handlers and script bodies removed:\n\`\`\`html\n${result.html}${result.truncated ? '\n[truncated]' : ''}\n\`\`\``;
  return {
    section: markdown,
    coverage: { chars: result.html.length, ...(result.snapshotName ? { snapshotName: result.snapshotName } : {}) },
  };
}

const TRACE_SECTION_CACHE_TTL_MS = 3_600_000;
/** Failed-response body excerpts appended to the trace network section. */
const TRACE_NET_BODY_EXCERPTS = 2;
const TRACE_NET_BODY_EXCERPT_CHARS = 500;

/**
 * Full call stack of the failing action from the trace's stacks index, each
 * in-project frame with a window of its embedded source (real code, not just
 * the reporter's 4-frame capture). Cached like the failing-action section —
 * the blob is immutable, so the parse result is too.
 */
async function traceCallStackSection(
  db: DbClient,
  rep: RepresentativeRow,
  limits: ContextLimits,
): Promise<{ section: string | null; coverage: DiagnosisContextCoverage['traceCallStack'] }> {
  if (limits.traceStackFrames <= 0) return { section: null, coverage: null };

  const blobPath = await resolveTraceBlobPath(db, rep.id);
  if (!blobPath) return { section: null, coverage: null };

  const cacheKey = `stack:${blobPath}:${limits.traceStackFrames}`;
  const cached = await getCachedTraceSection(db, cacheKey, TRACE_SECTION_CACHE_TTL_MS);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      // Malformed cache entry — recompute below.
    }
  }

  const result = await getTraceCallStackFromBlob(blobPath, rep.testFilePath ?? null);
  const formatted = formatTraceCallStackSection(result, limits.traceStackFrames);
  if (!formatted) return { section: null, coverage: null };

  const value = { section: formatted.markdown, coverage: formatted.coverage };
  setCachedTraceSection(db, cacheKey, JSON.stringify(value)).catch(() => {});
  return value;
}

/**
 * Every request from the trace's HAR-like network stream — unlike the
 * fixture-captured `networkRequests` section this covers all resource types
 * with sizes and failure-window correlation, prioritizing failed /
 * during-failure / slow requests, plus short masked body excerpts for failed
 * textual responses.
 */
async function traceNetworkSection(
  db: DbClient,
  rep: RepresentativeRow,
  limits: ContextLimits,
): Promise<{ section: string | null; coverage: DiagnosisContextCoverage['traceNetwork'] }> {
  if (limits.traceNetworkRequests <= 0) return { section: null, coverage: null };

  const blobPath = await resolveTraceBlobPath(db, rep.id);
  if (!blobPath) return { section: null, coverage: null };

  const cacheKey = `net:${blobPath}:${limits.traceNetworkRequests}`;
  const cached = await getCachedTraceSection(db, cacheKey, TRACE_SECTION_CACHE_TTL_MS);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      // Malformed cache entry — recompute below.
    }
  }

  const result = await getTraceNetworkFromBlob(blobPath);
  const picked = selectTraceNetworkRequests(result, limits.traceNetworkRequests, limits.slowRequestMs);

  // Failed textual responses often carry the actual server error — quote a bit.
  const bodyExcerpts: TraceNetworkBodyExcerpt[] = [];
  for (const r of picked.filter((p) => p.failed && p.bodySha1).slice(0, TRACE_NET_BODY_EXCERPTS)) {
    const body = await getTraceNetworkBodyFromBlob(blobPath, r.bodySha1!);
    if (body.status === 'ok' && body.content) {
      bodyExcerpts.push({
        label: `Response body of failed ${r.method} ${r.url} (excerpt)`,
        content: body.content.slice(0, TRACE_NET_BODY_EXCERPT_CHARS),
      });
    }
  }

  const formatted = formatTraceNetworkSection(result, picked, bodyExcerpts);
  if (!formatted) return { section: null, coverage: null };

  const value = { section: formatted.markdown, coverage: formatted.coverage };
  setCachedTraceSection(db, cacheKey, JSON.stringify(value)).catch(() => {});
  return value;
}

function formatFileSize(n: number | null): string {
  if (n == null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/**
 * Pointers to the execution's captured artifacts (video, HAR, custom
 * attachments). Already uploaded — surfaced as links so the diagnosis knows they
 * exist and a human can inspect them. Not inlined (videos/HAR can be large).
 */
async function artifactsSection(db: DbClient, rep: RepresentativeRow): Promise<string | null> {
  const rows = await db
    .select({ subtype: files.subtype, label: files.label, path: files.path, size: files.size })
    .from(files)
    .where(and(eq(files.testRunsCaseId, rep.id), eq(files.type, 'attachment')))
    .limit(15);
  if (rows.length === 0) return null;
  const lines = rows.map((f) => {
    const name = f.subtype || 'attachment';
    const ct = f.label ? ` (${f.label})` : '';
    const sz = f.size != null ? ` — ${formatFileSize(f.size)}` : '';
    return `- ${name}${ct}${sz}: /api/files/${f.path}`;
  });
  return `## Attachments & Artifacts\nFiles captured for this execution (video, HAR, custom artifacts) — available for inspection, not inlined:\n${lines.join('\n')}`;
}

/**
 * Extract the "Page snapshot" section from a Playwright `error-context.md`
 * body. Playwright (1.53 through at least 1.61) writes it as an h1 —
 * `# Page snapshot` — followed by a ```yaml fence; h2 is tolerated for other
 * generators. Returns the snapshot YAML (fence contents when fenced), or null
 * when no section is found. Exported for unit testing.
 */
export function extractPageSnapshotSection(text: string): string | null {
  const snapshotMatch = text.match(
    /(?:^|\n)#{1,2} Page snapshot\s*\n(```(?:ya?ml)?\s*\n[\s\S]*?\n```|[\s\S]*?)(?=\n#{1,2} |\n---\n|$)/,
  );
  if (!snapshotMatch) return null;
  let snapshot = snapshotMatch[1]!.trim();
  const fenceMatch = snapshot.match(/^```(?:ya?ml)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch) snapshot = fenceMatch[1]!;
  return snapshot || null;
}

/**
 * When Playwright attaches an error context (automatically for failed tests
 * since ~1.53), it contains a ref-annotated ARIA snapshot under `# Page
 * snapshot` that carries the full DOM hierarchy with `[ref=eXX]` /
 * `[cursor=pointer]` / `[active]` annotations. This is richer than the stored
 * flat snapshot and works retroactively — the file is already uploaded, it
 * just wasn't read. The attachment is stored under Playwright's attachment
 * *name* (`error-context`), not its on-disk file name (`error-context.md`).
 *
 * Returns the extracted snapshot YAML block (without the heading), or null
 * when no error-context attachment exists or parsing fails.
 */
async function resolveErrorContextAria(db: DbClient, rep: RepresentativeRow): Promise<string | null> {
  const row = await db
    .select({ path: files.path })
    .from(files)
    .where(and(eq(files.testRunsCaseId, rep.id), eq(files.type, 'attachment'), eq(files.subtype, 'error-context')))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (!row) return null;

  try {
    const storage = getStorage();
    const buf = await storage.readFile(row.path);
    return extractPageSnapshotSection(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/** Auto-resolve screenshots for the representative execution. */
async function resolveScreenshots(
  db: DbClient,
  rep: RepresentativeRow,
  limits: ContextLimits,
): Promise<AiAttachedImage[]> {
  if (limits.maxImages <= 0) return [];
  // The page the test failed on first when it is known, so a low image limit keeps it.
  const screenshotRows = await selectCaseScreenshots(db, rep.id, limits.maxImages);

  if (screenshotRows.length === 0) return [];

  const storage = getStorage();
  const images: AiAttachedImage[] = [];

  for (const f of screenshotRows) {
    if (images.length >= limits.maxImages) break;
    const mediaType = supportedImageMediaType(f);
    if (!mediaType) continue;
    try {
      const buf = await storage.readFile(f.path);
      images.push({
        // `subtype` is the Playwright attachment name; `label` is its content type.
        name: f.subtype || f.path.split('/').pop() || 'screenshot',
        mediaType,
        data: buf.toString('base64'),
      });
    } catch {
      // skip inaccessible files
    }
  }

  return images;
}

/**
 * The ids of the tests that have failed into a cluster. Passed executions carry
 * no cluster id, so retry passes are found through these tests.
 */
function clusterTestCaseIds(db: DbClient, clusterId: number) {
  return db
    .selectDistinct({ id: testRunsCases.testCaseId })
    .from(testRunsCases)
    .where(eq(testRunsCases.failureClusterId, clusterId));
}

/**
 * Recurrence pattern + flakiness analysis for the cluster, over the executions
 * of its tests in the project's 30 most recent runs. A run is affected when it
 * holds a failure in the cluster or a retry pass of one of its tests.
 */
export async function recurrenceFlakinessSection(db: DbClient, cluster: FailureCluster): Promise<string | null> {
  const rows = await db
    .select({
      runId: testRunsCases.testRunId,
      status: testRunsCases.status,
      retries: testRunsCases.retries,
      clusterId: testRunsCases.failureClusterId,
    })
    .from(testRunsCases)
    .where(
      and(
        inArray(testRunsCases.testCaseId, clusterTestCaseIds(db, cluster.id)),
        inArray(
          testRunsCases.testRunId,
          db
            .select({ id: testRuns.id })
            .from(testRuns)
            .where(eq(testRuns.projectId, cluster.projectId))
            .orderBy(desc(testRuns.startTime))
            .limit(30),
        ),
      ),
    );
  const recentRuns = rows.filter((r) => r.clusterId === cluster.id || (r.status === 'passed' && (r.retries ?? 0) > 0));

  if (recentRuns.length === 0) return null;

  // Group by run
  const byRun = new Map<number, { total: number; failed: number; retried: number; passOnRetry: boolean }>();
  for (const r of recentRuns) {
    let g = byRun.get(r.runId);
    if (!g) {
      g = { total: 0, failed: 0, retried: 0, passOnRetry: false };
      byRun.set(r.runId, g);
    }
    g.total++;
    if (isFailedStatus(r.status) || r.status === 'interrupted') g.failed++;
    if ((r.retries ?? 0) > 0) g.retried++;
    if ((r.retries ?? 0) > 0 && r.status === 'passed') g.passOnRetry = true;
  }

  const affectedRuns = byRun.size;
  let retryPassCount = 0;
  for (const g of byRun.values()) if (g.passOnRetry) retryPassCount++;

  const pattern =
    retryPassCount > 0 && retryPassCount >= affectedRuns / 3
      ? 'intermittent'
      : retryPassCount === 0 && affectedRuns > 1
        ? 'persistent'
        : 'unknown';

  const lines: string[] = ['## Recurrence & Flakiness'];
  lines.push(`- Affected runs: ${affectedRuns}, total occurrences: ${recentRuns.length}`);
  lines.push(`- Retry-passes: ${retryPassCount} of ${affectedRuns} runs`);
  lines.push(
    `- Pattern: ${pattern}${pattern === 'intermittent' ? ' — affects some runs, some pass on retry' : pattern === 'persistent' ? ' — every run affected' : ''}`,
  );

  // Per-run breakdown (compact)
  const runBreakdown: string[] = [];
  for (const [runId, g] of byRun) {
    const passOnRetry = g.passOnRetry ? ' (pass-on-retry)' : '';
    runBreakdown.push(`  - run #${runId}: ${g.total} case(s), ${g.failed} failed, ${g.retried} retried${passOnRetry}`);
  }
  if (runBreakdown.length > 20) {
    lines.push('Recent runs:');
    lines.push(...runBreakdown.slice(0, 20));
    lines.push(`  …and ${runBreakdown.length - 20} more`);
  } else if (runBreakdown.length > 0) {
    lines.push('Recent runs:');
    lines.push(...runBreakdown);
  }

  return lines.join('\n');
}

/**
 * The cluster's last completed diagnosis: the stored row when it is completed,
 * otherwise the newest completed version snapshotted before a re-run reset it.
 */
async function lastCompletedDiagnosis(db: DbClient, clusterId: number) {
  const [current] = await db
    .select({
      status: failureDiagnoses.status,
      category: failureDiagnoses.category,
      confidence: failureDiagnoses.confidence,
      summary: failureDiagnoses.summary,
      rootCause: failureDiagnoses.rootCause,
      feedback: failureDiagnoses.feedback,
      feedbackNote: failureDiagnoses.feedbackNote,
    })
    .from(failureDiagnoses)
    .where(and(eq(failureDiagnoses.clusterId, clusterId), eq(failureDiagnoses.scope, 'cluster')))
    .limit(1);
  if (current?.status === 'completed') return current;

  const [version] = await db
    .select({
      status: failureDiagnosisVersions.status,
      category: failureDiagnosisVersions.category,
      confidence: failureDiagnosisVersions.confidence,
      summary: failureDiagnosisVersions.summary,
      rootCause: failureDiagnosisVersions.rootCause,
      feedback: failureDiagnosisVersions.feedback,
      feedbackNote: failureDiagnosisVersions.feedbackNote,
    })
    .from(failureDiagnosisVersions)
    .where(
      and(
        eq(failureDiagnosisVersions.clusterId, clusterId),
        eq(failureDiagnosisVersions.scope, 'cluster'),
        eq(failureDiagnosisVersions.status, 'completed'),
      ),
    )
    .orderBy(desc(failureDiagnosisVersions.createdAt), desc(failureDiagnosisVersions.id))
    .limit(1);
  return version ?? null;
}

/** Prior diagnosis + triage note + user feedback. */
async function priorDiagnosisSection(db: DbClient, cluster: FailureCluster): Promise<string | null> {
  const d = await lastCompletedDiagnosis(db, cluster.id);
  if (!d) return null;

  const lines: string[] = ['## Prior Assessment (from last diagnosis)'];
  if (d.category) lines.push(`- Previous category: ${d.category}`);
  if (d.confidence) lines.push(`- Previous confidence: ${d.confidence}`);
  if (d.summary) lines.push(`- Previous summary: ${d.summary}`);
  if (d.rootCause) lines.push(`- Previous root cause: ${d.rootCause}`);

  if (cluster.triageNote) {
    lines.push(`- Triage note: ${cluster.triageNote}`);
  }

  // Feedback loop: when the user marked the prior diagnosis unhelpful,
  // warn the model not to repeat the same assessment without new evidence.
  if (d.feedback === 'down') {
    lines.push('');
    lines.push(
      `**User feedback: the previous diagnosis was marked unhelpful**` +
        (d.feedbackNote ? ` — note: "${d.feedbackNote}"` : '') +
        `. Do not repeat this assessment without new evidence.`,
    );
  }

  lines.push('');
  lines.push('> The user is re-diagnosing. Either reaffirm this assessment with new evidence or revise it.');

  return lines.join('\n');
}

/**
 * The single closest resolved cluster this one resembles, with the resolving
 * commit and the note — so the model can say "this was fixed before by …"
 * instead of re-deriving a known fix. Capped tight; the top match is the signal.
 */
async function previouslyFixedSection(db: DbClient, cluster: FailureCluster): Promise<string | null> {
  const matches = await findFixedBefore(db, cluster).catch(() => []);
  const top = matches[0];
  if (!top) return null;

  const lines: string[] = ['## Previously Fixed Similar Failure'];
  lines.push(
    `A resolved cluster closely resembles this one (${top.reason}). Consider whether the same fix applies before proposing a new one.`,
  );
  const where = [
    `cluster #${top.clusterId} "${top.title}"`,
    top.fixCommitShort ? `fixed in ${top.fixCommitShort}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  lines.push(`- ${where}`);
  if (top.diagnosisTitle) lines.push(`- Prior diagnosis: ${top.diagnosisTitle}`);
  if (top.triageNote) lines.push(`- Triage note: ${top.triageNote.replace(/\s+/g, ' ').trim()}`);

  return lines.join('\n').slice(0, 600);
}

// ── Content-aware ARIA snapshot truncation ───────────────────────────────────

interface AriaBlock {
  startLine: number;
  endLine: number;
  role: string;
  name: string;
  charCount: number;
  isContent: boolean;
}

/**
 * Content-aware ARIA snapshot truncation: prioritizes the content region
 * (`main`, else the largest non-nav `document`/`region` subtree) and
 * gives repetitive landmarks (`navigation`/`list` with many siblings) a
 * small fixed budget, collapsing the remainder. Always keeps at least the
 * role headers of dropped regions so the model knows they existed.
 */
export function selectAriaForBudget(snapshot: string, budget: number): string {
  if (snapshot.length <= budget) return snapshot;

  const lines = snapshot.split('\n');

  // Identify top-level blocks (lines starting with `- ` at indent 0)
  const blocks: AriaBlock[] = [];
  let blockStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;
    if (indent === 0 && trimmed.startsWith('- ')) {
      if (blockStart >= 0) {
        blocks.push(extractBlock(lines, blockStart, i - 1));
      }
      blockStart = i;
    }
  }
  if (blockStart >= 0) {
    blocks.push(extractBlock(lines, blockStart, lines.length - 1));
  }

  if (blocks.length === 0) {
    return snapshot.slice(0, budget);
  }

  // Classify blocks
  for (const block of blocks) {
    const firstLine = lines[block.startLine] ?? '';
    const roleMatch = firstLine.match(/\[role=(\w+)\]/) || firstLine.match(/^-\s*(\w+)(?=\s|["])/);
    block.role = roleMatch ? (roleMatch[1] ?? '').toLowerCase() : '';
    block.charCount = lines.slice(block.startLine, block.endLine + 1).join('\n').length;
    block.isContent = block.role === 'main' || (block.role === 'region' && !block.role.includes('nav'));
  }

  // Find content block and nav/list blocks
  const contentBlock = blocks.find((b) => b.isContent) || blocks.reduce((a, b) => (a.charCount >= b.charCount ? a : b));
  const navBlocks = blocks.filter((b) => b.role === 'navigation' || b.role === 'list');

  // Budget allocation: content gets 70%, nav gets a shared 20%, rest 10%
  const contentBudget = Math.floor(budget * 0.7);
  const navBudget = Math.floor(budget * 0.2);
  const otherBudget = budget - contentBudget - navBudget;

  const resultLines: string[] = [];
  let remaining = budget;

  for (const block of blocks) {
    const blockText = lines.slice(block.startLine, block.endLine + 1).join('\n');
    let lineBudget: number;

    if (block === contentBlock) {
      lineBudget = contentBudget;
    } else if (navBlocks.includes(block)) {
      lineBudget = Math.floor(navBudget / navBlocks.length);
    } else {
      lineBudget = Math.floor(otherBudget / (blocks.length - 1 - navBlocks.length) || otherBudget);
    }

    if (blockText.length <= lineBudget) {
      resultLines.push(blockText);
      remaining -= blockText.length;
    } else {
      // Collapse the block: keep header + collapse long sibling runs
      const collapsed = collapseAriaBlock(lines, block, Math.max(lineBudget, 80));
      resultLines.push(collapsed);
      remaining -= collapsed.length;
    }
  }

  const result = resultLines.join('\n');
  return result.length <= budget ? result : result.slice(0, budget) + '\n[truncated]';
}

function extractBlock(lines: string[], start: number, end: number): AriaBlock {
  const firstLine = lines[start] ?? '';
  const nameMatch = firstLine.match(/"([^"]+)"/);
  return {
    startLine: start,
    endLine: end,
    role: '',
    name: nameMatch ? (nameMatch[1] ?? '') : '',
    charCount: 0,
    isContent: false,
  };
}

/**
 * Collapse an ARIA block: keep the header line, then condense long sibling
 * runs (listitems, links) to first K + elision marker.
 */
function collapseAriaBlock(lines: string[], block: AriaBlock, budget: number): string {
  const headerLine = lines[block.startLine] ?? '';
  const childLines = lines.slice(block.startLine + 1, block.endLine + 1);

  // Count sibling groups by indentation
  const indentCounts = new Map<number, number>();
  let prevIndent = -1;
  let sameIndentCount = 0;
  let maxIndent = 0;
  for (const l of childLines) {
    const trimmed = l.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = l.length - trimmed.length;
    if (indent > maxIndent) maxIndent = indent;
    if (indent === prevIndent) {
      sameIndentCount++;
    } else {
      if (sameIndentCount > 5) {
        indentCounts.set(prevIndent, Math.max(indentCounts.get(prevIndent) ?? 0, sameIndentCount));
      }
      sameIndentCount = 1;
      prevIndent = indent;
    }
  }
  if (sameIndentCount > 5) {
    indentCounts.set(prevIndent, Math.max(indentCounts.get(prevIndent) ?? 0, sameIndentCount));
  }

  // Collapse: keep header + first few items per deep indent level, elide rest
  const collapsed: string[] = [headerLine];
  const seenPerIndent = new Map<number, number>();
  const keptLines: string[] = [];

  // Determine the deepest indent level with many siblings
  const problemIndent = maxIndent;

  for (const l of childLines) {
    const trimmed = l.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = l.length - trimmed.length;

    if (indent === problemIndent && (indentCounts.get(indent) ?? 0) > 5) {
      const seen = seenPerIndent.get(indent) ?? 0;
      if (seen >= 3) {
        // Skip this line; we'll add one elision marker
        continue;
      }
      seenPerIndent.set(indent, seen + 1);
      keptLines.push(l);
    } else {
      keptLines.push(l);
    }
  }

  collapsed.push(...keptLines);

  // If we collapsed any, add elision
  const totalAtProblemIndent = childLines.filter((l) => {
    const t = l.trimStart();
    return l.length - l.trimStart().length === problemIndent && t && !t.startsWith('#');
  }).length;
  const keptAtProblemIndent = keptLines.filter((l) => l.length - l.trimStart().length === problemIndent).length;
  if (keptAtProblemIndent < totalAtProblemIndent) {
    collapsed.push(
      `  ${'  '.repeat(problemIndent > 0 ? Math.floor(problemIndent / 2) : 0)}- … (${totalAtProblemIndent - keptAtProblemIndent} more items elided)`,
    );
  }

  let result = collapsed.join('\n');
  if (result.length > budget) {
    result = result.slice(0, budget) + '\n[truncated]';
  }
  return result;
}

/** Parse a `getByRole`-style locator from an error message. */
function parseLocatorFromError(
  error: string,
): { role?: string; name?: string; exact?: boolean; method?: string } | null {
  // Match: getByRole('heading', { name: 'Users', exact: true })
  const roleMatch = error.match(/getByRole\(\s*'(\w+)'\s*(?:,\s*\{[^}]*name:\s*'([^']*)'([^}]*)\})?\s*\)/);
  if (roleMatch) {
    const exact = roleMatch[3]?.includes('exact: true') || false;
    return { role: roleMatch[1], name: roleMatch[2], exact, method: 'getByRole' };
  }
  // Match: getByText('some text')
  const textMatch = error.match(/getBy(Text|Label|Placeholder|Title|AltText)\(\s*['"]([^'"]+)['"]\s*\)/);
  if (textMatch) {
    return { method: `getBy${textMatch[1]!}`, name: textMatch[2], exact: false };
  }
  return null;
}

/**
 * Nearest accessible-name hint for locator failures.
 * When the failing error contains a role/name locator, parse the stored ARIA
 * snapshot and surface the closest candidates. Parsing and similarity reuse
 * the shared healing helpers (`parseAriaCandidates` / `textSimilarity`) so
 * this section agrees with the locator-healing pipeline.
 */
function nearestAriaNamesSection(rep: RepresentativeRow): string | null {
  if (!rep.error && !rep.ariaSnapshot) return null;
  const error = rep.error?.trim() || '';
  const snapshot = rep.ariaSnapshot?.trim() || '';
  if (!error || !snapshot) return null;

  const locator = parseLocatorFromError(error);
  if (!locator) return null;

  const entries = parseAriaCandidates(snapshot).filter(
    (e): e is { role: string; name: string; level: number | null } => e.name != null,
  );
  if (entries.length === 0) return null;

  // Filter entries matching the locator's role
  const sameRole = locator.role ? entries.filter((e) => e.role === locator.role) : entries;

  if (sameRole.length === 0 || !locator.name) return null;

  // Score by token similarity
  const scored = sameRole.map((e) => ({
    ...e,
    score: textSimilarity(locator.name, e.name),
  }));
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 5).filter((e) => e.score > 0 || e.name);
  if (top.length === 0) return null;

  const lines: string[] = ['### Nearest matching elements (from ARIA)'];
  const requested =
    locator.method === 'getByRole'
      ? `getByRole('${locator.role ?? ''}', { name: '${locator.name}'${locator.exact ? ', exact: true' : ''} })`
      : `${locator.method}('${locator.name}')`;
  lines.push(`Requested: ${requested}`);
  for (const e of top) {
    const note =
      e.score >= 1
        ? ''
        : e.score > 0.3
          ? ` — close match (score: ${e.score.toFixed(2)})`
          : ` — partial match (score: ${e.score.toFixed(2)})`;
    const exactHint = locator.exact && e.name !== locator.name ? ' — exact:false would match' : '';
    lines.push(`Present:   ${e.role} "${e.name}"${exactHint}${note}`);
  }

  return lines.join('\n');
}

/**
 * Alternative locators for the failing action, sourced from prior passing runs
 * (highest confidence — captured against the real DOM) or the current ARIA
 * snapshot. Surfaces pre-validated locator suggestions so the model can
 * recommend a concrete, grounded fix instead of fabricating a locator.
 *
 * Returns the section text plus structured coverage for the UI status line.
 */
async function locatorHealingSection(
  db: DbClient,
  rep: RepresentativeRow,
): Promise<{
  section: string | null;
  coverage: NonNullable<DiagnosisContextCoverage['locatorHealing']> | null;
}> {
  if (!rep.error) return { section: null, coverage: null };

  const healing = await getLocatorHealing(db, rep.id);
  const alternatives =
    healing.fromDiffRename ?? healing.fromElementMatch ?? healing.fromPriorSuccess ?? healing.fromAriaSnapshot ?? [];

  // The gate rejected healing (the locator resolved, a navigation failed, no
  // locator): tell the model so, rather than leaving it to guess a selector.
  const notApplicable = healingNotApplicableMarkdown(healing);
  if (notApplicable) {
    return {
      section: healing.failingLocator ? notApplicable : null,
      coverage: healing.failingLocator ? { source: healing.source, alternativesCount: 0 } : null,
    };
  }

  if (alternatives.length === 0) {
    // No alternatives — only report coverage when we actually recognized a
    // failing locator (so the UI can show "none found" rather than "n/a").
    return {
      section: null,
      coverage: healing.failingLocator ? { source: healing.source, alternativesCount: 0 } : null,
    };
  }

  const lines: string[] = ['## Alternative Locators (Locator Healing)'];
  if (healing.failingLocator) {
    const argsStr = Object.entries(healing.failingLocator.args)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ');
    lines.push(`Failing locator: ${healing.failingLocator.method}(${argsStr})`);
  }
  const sourceLabel =
    healing.source === 'diff-rename'
      ? `the run's own diff renamed "${healing.diffRename?.before ?? ''}" to "${healing.diffRename?.after ?? ''}" in ${healing.diffRename?.file ?? 'the application'}; the same locator with the new text`
      : healing.source === 'prior-run'
        ? 'captured against the real DOM in a prior passing run'
        : healing.source === 'element-match'
          ? "the locator's element appears renamed/moved — these are fresh locators for its current identity on the failing page"
          : healing.source === 'fingerprint'
            ? 'matched by locator fingerprint from a prior passing run'
            : healing.source === 'cross-test'
              ? 'the same locator was captured against the real DOM by another test in this project'
              : 'derived from the current ARIA snapshot';
  lines.push(`Source: ${healing.source} (${sourceLabel})`);
  if (healing.capturedAt) {
    lines.push(`Captured: ${healing.capturedAt}`);
  }
  if (healing.priorNameMayBeStale) {
    lines.push(
      "CAUTION: the element's captured accessible name no longer appears on the failing page. " +
        'Name-based alternatives below (and the failing locator itself) probably no longer match — ' +
        'do NOT suggest reusing the failing locator; prefer structural/attribute alternatives or the failing-page candidates.',
    );
  }

  // Surface the single convention-preserving recommendation so the model picks
  // the same minimal, idiomatic fix the dashboard highlights — not just the
  // highest-stability locator regardless of the developer's original style.
  const rec = healing.recommendation;
  if (rec?.recommended) {
    const style = rec.preservesConvention
      ? 'keeps the original locator style — a minimal, idiomatic edit'
      : 'the most stable available (the original style had no stable alternative)';
    lines.push('');
    lines.push(
      `Recommended fix (use in suggestedFix.code): \`${rec.recommended.locator}\` (score ${rec.recommended.score}) — ${style}.`,
    );
    if (rec.hasDurableAlternative && rec.durable) {
      lines.push(
        `Sturdier alternative if a different locator style is acceptable: \`${rec.durable.locator}\` (score ${rec.durable.score}).`,
      );
    }
    if (rec.suggestAddTestId) {
      lines.push(
        'All alternatives score below 50 — recommend adding a stable data-testid attribute to this element in the application as the durable fix.',
      );
    }
    lines.push('');
  }

  lines.push('Top alternatives, ranked by stability score:');
  for (const alt of alternatives.slice(0, 5)) {
    lines.push(`- \`${alt.locator}\` (score ${alt.score})`);
  }

  // In the stale case the ARIA supplement rides alongside the stored list —
  // these are the elements actually present on the failing page.
  if (healing.priorNameMayBeStale && healing.fromPriorSuccess?.length && healing.fromAriaSnapshot?.length) {
    lines.push('Candidates from the failing page (ARIA snapshot):');
    for (const alt of healing.fromAriaSnapshot.slice(0, 3)) {
      lines.push(`- \`${alt.locator}\``);
    }
  }

  return {
    section: lines.join('\n'),
    coverage: { source: healing.source, alternativesCount: alternatives.length },
  };
}

/**
 * Header + error/source/steps/console/network/server-logs/web-vitals/ARIA
 * sub-sections from one execution, each tagged with its `SectionId`, so the
 * assembler places each piece of evidence by id, not by position.
 */
export function representativeExecutionSections(
  rep: RepresentativeRow,
  cluster: FailureCluster | null,
  limits: ContextLimits,
): Array<{ id: SectionId; markdown: string }> {
  const out: Array<{ id: SectionId; markdown: string }> = [];

  const browser = rep.browser as BrowserConfig | null;
  const browserStr = [browser?.projectName, browser?.browserName].filter(Boolean).join(' / ');
  const location = rep.line ? `${rep.testFilePath}:${rep.line}${rep.column ? `:${rep.column}` : ''}` : rep.testFilePath;

  const runWhen = (rep as any).runStartTime instanceof Date ? ` (${relativeDays((rep as any).runStartTime)})` : '';

  const headerLines: string[] = [
    `## Representative Execution (run #${rep.testRunId}${runWhen})`,
    `- Test: ${rep.testTitle}`,
    `- Location: ${location}`,
    `- Browser: ${browserStr || 'unknown'}`,
    `- Retries: ${rep.retries ?? 0}`,
    `- Duration: ${rep.duration != null ? `${rep.duration}ms` : 'unknown'}`,
  ];

  // CI/env/OS metadata
  headerLines.push(...ciRunHeaderLines(rep));

  out.push({ id: 'representativeExecution', markdown: headerLines.join('\n') });

  // Direct error from this execution. Normalized comparison (masking volatile
  // tokens like timestamps/durations/ids that differ between runs of the same
  // root cause) avoids ~20 KB of near-duplicate stack frames that the naive
  // strict-equality check misses.
  if (rep.error) {
    const clean = stripAnsi(rep.error);
    const normalizedRep = maskVolatile(clean);
    const normalizedCluster = cluster?.sampleError ? maskVolatile(stripAnsi(cluster.sampleError)) : null;
    if (normalizedRep !== normalizedCluster) {
      const condensed = condenseErrorText(clean, limits.sampleErrorChars);
      out.push({
        id: 'executionError',
        markdown: `### Execution Error\n\`\`\`\n${condensed}\n\`\`\``,
      });
    }
  }

  // Test source — keep failing test body full, truncate surrounding
  if (rep.testSource) {
    let source = rep.testSource;
    const isTruncated = source.length > limits.testSourceChars;
    // Heuristic: try to keep the test block anchored by "test(" or "it("
    if (isTruncated) {
      const testPattern = /^\s*(test|it)\s*\(/m;
      const testMatch = source.match(testPattern);
      if (testMatch && testMatch.index !== undefined) {
        const fromTest = source.slice(testMatch.index);
        if (fromTest.length <= limits.testSourceChars) {
          source = fromTest;
        } else {
          source = source.slice(0, limits.testSourceChars);
        }
      } else {
        source = source.slice(0, limits.testSourceChars);
      }
    }
    out.push({
      id: 'testSource',
      markdown: `### Test Source\n\`\`\`typescript\n${source}${isTruncated ? '\n[truncated]' : ''}\n\`\`\``,
    });
  }

  // Steps — failed steps are annotated inline so the narrative flow
  // ("it did A, B, C, then D failed") is readable in one pass; an error the
  // test caught is marked as such, never as the failure.
  const steps = (rep.steps as TestStepInfo[] | null) ?? [];
  if (steps.length > 0) {
    const roles = stepFailureRoles(steps, rep.error);
    const first = Math.max(0, steps.length - limits.steps);
    const shown = steps.slice(first);
    out.push({
      id: 'steps',
      markdown: `### Steps (last ${shown.length})\n${shown
        .map((s, i) => {
          const role = roles[first + i];
          const failed = s.failed && role !== 'recovered';
          const prefix = failed ? '✗ ' : '- ';
          const suffix = role === 'recovered' ? ' (error caught, the test continued)' : failed ? ' ← FAILED' : '';
          const dur = s.duration != null ? ` (${s.duration}ms)` : '';
          const params = stepParamsLine(s);
          const paramLine = params ? `\n    ${params}` : '';
          return `${prefix}[${s.category ?? 'step'}] ${stepLabel(s)}${dur}${suffix}${paramLine}`;
        })
        .join('\n')}`,
    });
  }

  // AI-step intents: the natural-language prompts this test's replayed AI-step
  // locators were compiled from. The intent states what the test *means* to
  // interact with, so a failing locator can be reasoned about in those terms
  // (a rename/restructure of the intended element) instead of selector terms.
  const aiIntents = (
    ((rep.aiUsage as { intents?: Array<{ template?: unknown; locator?: unknown; kind?: unknown }> } | null)?.intents ??
      []) as Array<{ template?: unknown; locator?: unknown; kind?: unknown }>
  ).filter((i) => typeof i?.template === 'string' && typeof i?.locator === 'string');
  if (aiIntents.length > 0 && limits.aiStepIntents > 0) {
    const shownIntents = aiIntents.slice(0, limits.aiStepIntents);
    const extra = aiIntents.length > shownIntents.length ? `\n…and ${aiIntents.length - shownIntents.length} more` : '';
    out.push({
      id: 'aiSteps',
      markdown: `### AI Steps (natural-language intents)\nThese locators were compiled once from natural-language prompts (Piwi AI steps) and replayed deterministically. Each line states what the test *means* to interact with. If the failing locator is one of these, reason about the intent — the intended element may have been renamed or restructured — and phrase the root cause in those terms:\n${shownIntents
        .map((i) => `- "${i.template}" → \`${i.locator}\`${i.kind === 'run' ? ' (flow step)' : ''}`)
        .join('\n')}${extra}`,
    });
  }

  // Console — dedupe consecutive identical lines (SPA test failures
  // routinely repeat one error dozens of times, eating the window).
  const consoleLogs = (rep.consoleLogs as ConsoleLogEntry[] | null) ?? [];
  const windowLogs = consoleLogs.slice(-limits.maxConsoleWindow);
  if (windowLogs.length > 0) {
    const condensed: string[] = [];
    let repeatCount = 1;
    for (let i = 0; i < windowLogs.length; i++) {
      const cur = windowLogs[i]!;
      const prev = i > 0 ? windowLogs[i - 1]! : null;
      if (prev && prev.type === cur.type && prev.text === cur.text) {
        repeatCount++;
        continue;
      }
      if (repeatCount > 1 && i > 0) {
        condensed[condensed.length - 1] += ` (×${repeatCount})`;
      }
      repeatCount = 1;
      condensed.push(`[${cur.type}] ${cur.text.slice(0, limits.consoleEntryChars)}`);
    }
    if (repeatCount > 1) {
      condensed[condensed.length - 1] += ` (×${repeatCount})`;
    }
    out.push({
      id: 'console',
      markdown: `### Console (last ${windowLogs.length} entries, deduped)\n${condensed.join('\n')}`,
    });
  }

  // Network — correlate with the failure when timing data allows
  const nrItems = (rep as any).nrItems ?? [];
  const networkLines: string[] = [];
  // Time anchor: the case's startedAt and the request's stored startTime are
  // both Unix epoch milliseconds, so their difference is already the ms offset
  // from test start.
  const failureAnchor = rep.startedAt ?? 0;
  const failedReqs = nrItems.filter((r: any) => r.status >= 400 || r.status === 0).slice(0, limits.networkRequests);
  const slowReqs = nrItems
    .filter((r: any) => r.status >= 200 && r.status < 400 && r.duration != null && r.duration > limits.slowRequestMs)
    .slice(0, limits.networkRequests);
  for (const r of failedReqs) {
    const offsetMs = r.startTime != null && failureAnchor ? Math.round(r.startTime - failureAnchor) : null;
    const timing = offsetMs != null && offsetMs >= 0 ? ` (t+${offsetMs}ms)` : '';
    networkLines.push(
      `- [failed] ${r.method} ${r.url} → ${r.status}${r.duration != null ? ` (${r.duration}ms)` : ''}${timing}`,
    );
  }
  for (const r of slowReqs)
    networkLines.push(`- [slow] ${r.method} ${r.url} → ${r.status}${r.duration != null ? ` (${r.duration}ms)` : ''}`);
  if (networkLines.length > 0) {
    out.push({ id: 'networkRequests', markdown: `### Network Requests\n${networkLines.join('\n')}` });
  }

  // Backend server logs (aggregated from X-Piwi-Logs headers across all requests)
  if (limits.serverLogEntries > 0) {
    const allServerLogs: ServerLogEntry[] = [];
    for (const req of nrItems) {
      const logs = (req as any).serverLogs;
      if (Array.isArray(logs)) {
        for (const log of logs) allServerLogs.push(log as ServerLogEntry);
      }
    }
    allServerLogs.sort((a, b) => a.timestamp - b.timestamp);
    const shownServerLogs = allServerLogs.slice(0, limits.serverLogEntries);
    if (shownServerLogs.length > 0) {
      const lines: string[] = [];
      for (const l of shownServerLogs) {
        const prefix = l.category ? `[${l.level}] [${l.category}] ` : `[${l.level}] `;
        lines.push(prefix + l.message.slice(0, limits.serverLogEntryChars));
        if (l.stack) {
          for (const frame of l.stack.split('\n')) {
            lines.push(`  ${frame}`);
          }
        }
      }
      out.push({ id: 'serverLogs', markdown: `### Backend Server Logs\n${lines.join('\n')}` });
    }
  }

  // Server-side spans (aggregated from X-Piwi-Trace headers across all requests)
  if (limits.serverTraceSpans > 0) {
    const spanLines: string[] = [];
    let shown = 0;
    for (const req of nrItems) {
      const spans = (req as any).serverTraces as ServerSpanEntry[] | undefined;
      if (!Array.isArray(spans) || spans.length === 0) continue;
      // Root span (no parent) first, then children in start order — a readable
      // per-request tree for the model.
      const sorted = [...spans].sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0) || a.startMs - b.startMs);
      for (const s of sorted) {
        if (shown >= limits.serverTraceSpans) break;
        const indent = s.parentId ? '  ' : '';
        const kind = s.kind ? `[${s.kind}] ` : '';
        const err = s.status === 'error' ? ' [error]' : '';
        spanLines.push(`${indent}- ${kind}${s.name} (${s.durMs}ms)${err}`);
        shown++;
      }
      if (shown >= limits.serverTraceSpans) break;
    }
    if (spanLines.length > 0) {
      out.push({ id: 'serverTraces', markdown: `### Server Traces\n${spanLines.join('\n')}` });
    }
  }

  // Web vitals
  const webVitals = rep.webVitals as WebVitals | null;
  if (webVitals && (webVitals.navigation || webVitals.paint || webVitals.vitals)) {
    const lines: string[] = [];
    const nav = webVitals.navigation;
    const paint = webVitals.paint;
    const vitals = webVitals.vitals;
    if (nav?.domContentLoaded != null) lines.push(`- DOMContentLoaded: ${nav.domContentLoaded}ms`);
    if (nav?.loadComplete != null) lines.push(`- Load complete: ${nav.loadComplete}ms`);
    if (paint?.firstContentfulPaint != null) lines.push(`- FCP: ${paint.firstContentfulPaint}ms`);
    if (vitals?.lcp != null) lines.push(`- LCP: ${vitals.lcp}ms`);
    if (vitals?.cls != null) lines.push(`- CLS: ${vitals.cls}`);
    if (vitals?.inp != null) lines.push(`- INP: ${vitals.inp}ms`);
    if (lines.length > 0) out.push({ id: 'webVitals', markdown: `### Web Vitals\n${lines.join('\n')}` });
  }

  // ARIA snapshot (content-aware truncation)
  if (rep.ariaSnapshot) {
    const truncated = selectAriaForBudget(rep.ariaSnapshot, limits.ariaSnapshotChars);
    out.push({
      id: 'ariaSnapshot',
      markdown: `### ARIA Snapshot (page state at failure)\n\`\`\`yaml\n${truncated}${truncated.length < rep.ariaSnapshot.length ? '\n[truncated]' : ''}\n\`\`\``,
    });
  }

  return out;
}

/** Titles of the sections the SCM investigation files. */
const SCM_SECTION_TITLES: Partial<Record<SectionId, string>> = {
  scmInvestigation: 'SCM Investigation',
  suspectLines: 'Changed Lines the Failing Tests Executed',
  topSuspectedCommit: 'Top Suspected Commit',
};

/** Human-readable section titles keyed by the ids emitted by `representativeExecutionSections`. */
const REP_SECTION_TITLES: Partial<Record<SectionId, string>> = {
  representativeExecution: 'Representative Execution',
  executionError: 'Execution Error',
  testSource: 'Test Source',
  steps: 'Steps',
  aiSteps: 'AI Steps',
  console: 'Console',
  networkRequests: 'Network Requests',
  serverLogs: 'Backend Server Logs',
  serverTraces: 'Server Traces',
  webVitals: 'Web Vitals',
  ariaSnapshot: 'ARIA Snapshot',
};

export async function retryBehaviorSection(db: DbClient, cluster: FailureCluster): Promise<string | null> {
  const retryPassRows = await db
    .select({ count: testRunsCases.id })
    .from(testRunsCases)
    .where(
      and(
        inArray(testRunsCases.testCaseId, clusterTestCaseIds(db, cluster.id)),
        eq(testRunsCases.testRunId, cluster.lastSeenRunId),
        eq(testRunsCases.status, 'passed'),
        sql`${testRunsCases.retries} > 0`,
      ),
    )
    .limit(1);

  if (retryPassRows.length === 0) return null;
  return `## Retry Behavior\nAt least one test in this cluster passed on retry in the last seen run (suggests flakiness).`;
}

/**
 * Signals about the failing test used to score how likely a changed file caused
 * the failure. Kept ecosystem-agnostic — no assumptions about a specific repo
 * layout — so scoring works for any user's repository.
 */
export interface RelevanceSignals {
  testFilePath?: string | null;
  testTitle?: string | null;
  ariaSnapshot?: string | null;
  /** Failing test source, when in context — enables import-based scoring. */
  testSource?: string | null;
  /** Raw failing error text — enables locator-literal matching against patch contents. */
  errorText?: string | null;
  /** Test case id — used for per-test last-passing baseline fallback when no project-green run exists. */
  testCaseId?: number | null;
}

/** Split a string into lowercase alphanumeric tokens of length ≥ 3. */
function relevanceTokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** Extract the module specifiers from `import ... from '…'` / `require('…')`. */
function extractImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:from|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Extract the string literals the failing test was locating, from the error
 * text's call log — `getByText('Run trend')`, `locator('.card')`,
 * `getByRole('button', { name: 'Pay' })`. These are the highest-precision
 * search keys for the SCM diff: a changed line containing one of them is very
 * likely the causal change. Deduped, ≥ 3 chars, capped at 10. Exported for
 * unit testing.
 */
export function extractLocatorLiterals(errorText: string): string[] {
  const clean = stripAnsi(errorText);
  const out = new Set<string>();
  const patterns = [
    /getBy[A-Za-z]+\(\s*['"]([^'"\n]{3,100})['"]/g,
    /\blocator\(\s*['"]([^'"\n]{3,100})['"]/g,
    /\bname:\s*['"]([^'"\n]{3,100})['"]/g,
  ];
  for (const re of patterns) {
    for (const m of clean.matchAll(re)) {
      if (m[1]) out.add(m[1]);
      if (out.size >= 10) return [...out];
    }
  }
  return [...out];
}

/**
 * Find the first locator literal that appears in a changed file's patch.
 * A hit on a removed (`-`) line is the smoking gun — the text the test expects
 * was just renamed or deleted — and is preferred over a hit anywhere else in
 * the patch. Exported for unit testing.
 */
export function findLiteralInPatch(
  patch: string | null | undefined,
  literals: string[],
): { literal: string; removed: boolean } | null {
  if (!patch || literals.length === 0) return null;
  const removedText = patch
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .join('\n');
  let plainHit: { literal: string; removed: boolean } | null = null;
  for (const lit of literals) {
    if (removedText.includes(lit)) return { literal: lit, removed: true };
    if (!plainHit && patch.includes(lit)) plainHit = { literal: lit, removed: false };
  }
  return plainHit;
}

/** Basename without directory or extension, lowercased. */
function fileStem(path: string): string {
  return (path.replace(/\\/g, '/').split('/').pop() ?? path).replace(/\.\w+$/, '').toLowerCase();
}

/**
 * Score a changed file by relevance to the failing test using generic,
 * repo-layout-independent signals. Higher score = more likely to be the cause.
 * Exported for unit testing.
 */
export function scoreChangedFile(
  filename: string,
  signals: RelevanceSignals,
  /** Precomputed locator-literal hit in this file's patch (see `findLiteralInPatch`). */
  patchMatch?: { literal: string; removed: boolean } | null,
): number {
  let score = 0;
  const fnLower = filename.toLowerCase().replace(/\\/g, '/');
  const stem = fileStem(filename);

  // Smoking gun: a changed line contains a string literal the failing test was
  // locating. A removed line is the strongest form — the text the test expects
  // was just renamed away. Outranks every filename-based signal.
  if (patchMatch) score += patchMatch.removed ? 8 : 6;

  // Strongest signal: the failing test imports this file (by basename match).
  if (signals.testSource) {
    for (const spec of extractImportSpecifiers(signals.testSource)) {
      if (fileStem(spec) && fileStem(spec) === stem) {
        score += 5;
        break;
      }
    }
  }

  // The changed file IS the test file, or shares its base name.
  if (signals.testFilePath) {
    const tfLower = signals.testFilePath.toLowerCase().replace(/\\/g, '/');
    if (fnLower === tfLower) score += 4;
    const testBase = fileStem(signals.testFilePath).replace(/\.(spec|test)$/, '');
    if (testBase && stem.includes(testBase)) score += 2;
  }

  // Token overlap between the file name and the test title / ARIA page state.
  const haystack = new Set<string>();
  if (signals.testTitle) for (const t of relevanceTokens(signals.testTitle)) haystack.add(t);
  if (signals.ariaSnapshot) for (const t of relevanceTokens(signals.ariaSnapshot)) haystack.add(t);
  if (haystack.size > 0) {
    for (const t of relevanceTokens(stem)) if (haystack.has(t)) score += 1;
  }

  // Prefer source files over config/lockfiles/docs (generic across ecosystems).
  if (/(^|\/)(src|lib|app|packages|components|pages|server|api|routes)\//.test(fnLower)) score += 1;
  if (/\.(lock|md|txt|ya?ml|toml|cfg|ini)$/.test(fnLower) || /(^|\/)package(-lock)?\.json$/.test(fnLower)) {
    score -= 1;
  }

  return score;
}

interface ScoredFile {
  file: ChangedFile;
  score: number;
  /** Locator literal from the failing error found in this file's patch, if any. */
  literalMatch: { literal: string; removed: boolean } | null;
}

function scoreFilesByRelevance(files: ChangedFile[], signals: RelevanceSignals): ScoredFile[] {
  const literals = signals.errorText ? extractLocatorLiterals(signals.errorText) : [];
  return files
    .map((f) => {
      const literalMatch = findLiteralInPatch(f.patch, literals);
      return { file: f, score: scoreChangedFile(f.filename, signals, literalMatch), literalMatch };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The genuinely most-suspect change: the highest-relevance-scored changed file
 * paired with the newest commit in the range (as the entry point to inspect).
 * Returns null when nothing scored above zero — a wrong-but-confident hint is
 * worse than none.
 */
function getTopSuspectedChange(
  scored: ScoredFile[],
  commits: Array<{ sha: string; message: string }>,
): {
  file: string;
  score: number;
  literalMatch: { literal: string; removed: boolean } | null;
  recentCommit: { sha: string; message: string } | null;
} | null {
  const topFile = scored[0];
  // Only show a file as "most relevant" when the signal is genuine — a score
  // of ≤ 2 means the file happened to share a generic path prefix or one common
  // word; a wrong-but-confident hint is worse than none.
  if (!topFile || topFile.score <= 2) return null;
  return {
    file: topFile.file.filename,
    score: topFile.score,
    literalMatch: topFile.literalMatch,
    recentCommit: commits[0] ?? null,
  };
}

/** Render the "Top Suspected Change" section honestly: the scored file, then the newest commit. */
function formatTopSuspectedChange(top: NonNullable<ReturnType<typeof getTopSuspectedChange>>): string {
  const lines = [
    `### Top Suspected Change`,
    `- Most relevant changed file: \`${top.file}\` (relevance score ${top.score})`,
  ];
  if (top.literalMatch) {
    lines.push(
      top.literalMatch.removed
        ? `- Why: the diff removes a line containing the test's target text "${top.literalMatch.literal}" — likely renamed or deleted`
        : `- Why: the diff touches a line containing the test's target text "${top.literalMatch.literal}"`,
    );
  }
  if (top.recentCommit) {
    lines.push(`- Most recent commit in range: \`${top.recentCommit.sha.slice(0, 7)}\` (${top.recentCommit.message})`);
  }
  return lines.join('\n');
}

type ScmProviderInstance = NonNullable<Awaited<ReturnType<typeof createScmProvider>>>;

type SourceFilesCoverage = NonNullable<DiagnosisContextCoverage['sourceFiles']>;

interface SourceFilesResult {
  text: string | null;
  files: Array<{ path: string; content: string }>;
  coverage: SourceFilesCoverage | null;
}

/** True when a path is repo-relative (not absolute POSIX or Windows). */
function isRepoRelativePath(p: string): boolean {
  return !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p);
}

/** Resolve an import specifier against a repo-relative source file's directory. Exported for unit testing. */
export function resolveImportPath(fromRepoRelPath: string, spec: string): string {
  const dir = fromRepoRelPath.replace(/\\/g, '/').split('/').slice(0, -1);
  const stack = [...dir];
  for (const part of spec.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.vue'];

/**
 * Candidate on-disk paths for a resolved, extension-less import (TS resolution
 * order + index files). When the path already has a code extension, it is the
 * only candidate. Exported for unit testing.
 */
export function candidateFilePaths(resolved: string): string[] {
  if (CODE_EXTENSIONS.some((e) => resolved.endsWith(e))) return [resolved];
  const out: string[] = [];
  for (const e of CODE_EXTENSIONS) out.push(resolved + e);
  for (const e of CODE_EXTENSIONS) out.push(`${resolved}/index${e}`);
  return out;
}

/** Number lines `NNNN | text` (same format as the reporter snippet) so hunk headers can be computed. */
function numberSourceLines(text: string): string {
  return text
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
    .join('\n');
}

/** Best-effort repo-relative form of the failing test file (uses the SCM tree when the path is absolute). */
async function resolveRepoRelativeTestPath(
  provider: ScmProviderInstance,
  ref: string,
  testFilePath: string,
): Promise<string | null> {
  const norm = testFilePath.replace(/\\/g, '/');
  if (isRepoRelativePath(norm)) return norm.replace(/^\.\//, '');
  const tree = await provider.fetchTree(ref).catch(() => null);
  if (!tree) return null;
  let best: string | null = null;
  for (const entry of tree) {
    if (norm === entry || norm.endsWith('/' + entry)) {
      if (!best || entry.length > best.length) best = entry;
    }
  }
  return best;
}

/**
 * Fetch full content of the most-suspect changed files and the failing test's
 * local import closure at the commit under test — the grounding that lets the
 * model write a patch against code it has actually seen (and that we can then
 * validate). Never throws; degrades to an empty result on any SCM failure.
 */
async function buildSourceFiles(
  provider: ScmProviderInstance,
  ref: string,
  scored: ScoredFile[],
  signals: RelevanceSignals,
  limits: ContextLimits,
): Promise<SourceFilesResult> {
  const empty: SourceFilesResult = { text: null, files: [], coverage: null };
  if (limits.maxSourceFiles <= 0 || !ref) return empty;

  try {
    // Each target is an ordered candidate list; the first candidate that resolves wins.
    const targets: string[][] = [];
    const seen = new Set<string>();
    const addTarget = (candidates: string[]) => {
      const key = candidates[0]!;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(candidates);
    };

    // 1. Top suspect changed files (repo-relative filenames straight from SCM).
    for (const s of scored) {
      if (s.score <= 0) break; // sorted desc — stop at the first non-signal file
      addTarget([s.file.filename]);
      if (targets.length >= limits.maxSourceFiles) break;
    }

    // 2. Failing test's local (relative) import closure, one hop.
    if (targets.length < limits.maxSourceFiles && signals.testFilePath && signals.testSource) {
      const repoTestPath = await resolveRepoRelativeTestPath(provider, ref, signals.testFilePath);
      if (repoTestPath) {
        for (const spec of extractImportSpecifiers(signals.testSource)) {
          if (!spec.startsWith('.')) continue; // only in-repo relative imports
          addTarget(candidateFilePaths(resolveImportPath(repoTestPath, spec)));
        }
      }
    }

    // Clip to sourceFileChars at fetch time so the stored content is exactly
    // what the model is shown — patch validation must run against that, not the
    // full fetched file. A clip counts as truncation for coverage.
    const files: Array<{ path: string; content: string; truncated: boolean }> = [];
    for (const candidates of targets) {
      if (files.length >= limits.maxSourceFiles) break;
      for (const path of candidates) {
        const fetched = await provider.fetchFileAtRef(path, ref).catch(() => null);
        if (fetched) {
          const clipped = fetched.content.length > limits.sourceFileChars;
          files.push({
            path: fetched.path,
            content: clipped ? fetched.content.slice(0, limits.sourceFileChars) : fetched.content,
            truncated: clipped || fetched.truncated,
          });
          break; // first resolving candidate for this target
        }
      }
    }

    if (files.length === 0) return empty;

    const blocks = files.map(
      (f) => `### ${f.path}\n\`\`\`\n${numberSourceLines(f.content)}${f.truncated ? '\n[truncated]' : ''}\n\`\`\``,
    );
    const text =
      '## Source Files (full content at the failing commit)\n' +
      "Full current content of the most-suspect changed files and the failing test's local imports, " +
      'at the commit under test. Line numbers are included so a patch can compute correct hunk headers. ' +
      'Only propose a patch for lines you can quote from these files.\n\n' +
      blocks.join('\n\n');

    return {
      text,
      files: files.map((f) => ({ path: f.path, content: f.content })),
      coverage: { count: files.length, paths: files.map((f) => f.path), truncated: files.some((f) => f.truncated) },
    };
  } catch {
    return empty;
  }
}

/** One section of the SCM investigation, with the id it is filed under. */
interface ScmSection {
  id: SectionId;
  markdown: string;
}

/**
 * "What changed since last green run" + the actual SCM diff (or a manual-baseline
 * diff when there is no last green run), with the changed lines the cluster's
 * failing tests executed when they recorded coverage. Tracks SCM coverage for
 * the UI status line.
 */
async function scmInvestigationSections(
  db: DbClient,
  cluster: FailureCluster,
  opts: BuildContextOptions,
  limits: ContextLimits,
  /** Signals about the failing test, used for changed-file relevance scoring. */
  signals: RelevanceSignals,
): Promise<{
  sections: ScmSection[];
  coverage: ScmCoverage | null;
  scmChanges: ScmChanges | null;
  topSuspectedCommit: string | null;
  sourceFiles: SourceFilesResult;
  suspectLines: SuspectLinesContext;
}> {
  const sections: ScmSection[] = [];
  let sourceFilesResult: SourceFilesResult = { text: null, files: [], coverage: null };
  const scmCov: ScmCoverage = {
    hasLastGreen: false,
    hasCommitRange: false,
    baseCommitUsed: null,
    provider: null,
    commitsCount: 0,
    filesCount: 0,
    patchedFilesCount: 0,
    patchesOmitted: false,
    patchesTruncated: false,
    baselineKind: undefined,
    error: null,
  };
  let scmReached = false;
  let scmChanges: ScmChanges | null = null;
  let suspectLines: SuspectLinesContext = { coverage: null, absentReason: 'no SCM diff to join with coverage' };

  // The range compared, whether or not a provider can read it: the page links it
  // on the host and offers the local `git log` when the diff cannot be fetched.
  // A pinned baseline is free text, so the link and the command are built only
  // from revisions that are plain SHAs or ref names.
  const setRange = (repositoryUrl: string | null, fromSha: string, toSha: string) => {
    const usable = isPlainRevision(fromSha) && isPlainRevision(toSha);
    scmCov.repositoryUrl = repositoryUrl;
    scmCov.range = { from: fromSha.slice(0, 7), to: toSha.slice(0, 7) };
    scmCov.compareUrl = usable && repositoryUrl ? compareUrl(repositoryUrl, fromSha, toSha) : null;
    scmCov.gitCommand = usable ? `git log --oneline ${fromSha}..${toSha}` : null;
  };
  scmCov.hasToken = (await resolveScmToken(db, cluster.projectId).catch(() => null)) != null;

  /**
   * Fetch the changes of `fromSha..toSha` and add them: the changed lines the
   * failing tests executed, then every changed file with its patch (the files
   * of those lines first), the top suspected change and the full source of the
   * most suspect files at `toSha`.
   */
  const readDiff = async (repositoryUrl: string, fromSha: string, toSha: string, title: string) => {
    try {
      const provider = await createScmProvider(repositoryUrl, db, cluster.projectId);
      scmCov.localGit = provider instanceof LocalGitProvider;
      const changes = provider ? await provider.fetchChanges(fromSha, toSha) : null;
      if (!changes || (changes.commits.length === 0 && changes.files.length === 0)) return;
      // Score and sort files by relevance, then render with budget
      const scored = scoreFilesByRelevance(changes.files, signals);
      changes.files = scored.map((s) => s.file);
      scmChanges = changes;
      scmCov.filesCount = changes.files.length;
      scmCov.commitsCount = changes.commits.length;
      scmCov.patchesOmitted = Boolean(changes.patchesOmitted);

      const suspects = await clusterSuspectLinesForChanges(db, cluster.id, changes, { from: fromSha, to: toSha }).catch(
        () => null,
      );
      if (suspects?.available) {
        const context = suspectLinesContext(suspects, changes.files, { from: fromSha, to: toSha });
        changes.files = context.files;
        sections.push({ id: 'suspectLines', markdown: context.markdown });
        suspectLines = { coverage: context.coverage, absentReason: null };
      } else if (suspects?.reason) {
        suspectLines = { coverage: null, absentReason: suspectLinesReasonText(suspects.reason) };
      }

      const rendered = renderChangedFiles(changes, { title, budget: limits.scmPatchBudget });
      scmCov.patchedFilesCount = rendered.patchedFilesCount;
      scmCov.patchesTruncated = rendered.patchesTruncated;
      sections.push({ id: 'scmInvestigation', markdown: rendered.text });

      // Surface the most-suspect changed file (by relevance) + newest commit
      const top = getTopSuspectedChange(scored, changes.commits);
      if (top) sections.push({ id: 'topSuspectedCommit', markdown: formatTopSuspectedChange(top) });

      // Full source of the suspect files + test imports at the failing commit.
      if (provider) sourceFilesResult = await buildSourceFiles(provider, toSha, scored, signals, limits);
    } catch (fetchErr) {
      scmCov.error = (fetchErr instanceof Error ? fetchErr.message : String(fetchErr)).slice(0, 300);
    }
  };

  const result = () => ({
    sections,
    coverage: scmReached ? scmCov : null,
    scmChanges,
    topSuspectedCommit: null,
    sourceFiles: sourceFilesResult,
    suspectLines,
  });

  // Anchor the diff at firstSeenRunId (the earliest run where the failure appeared) so the
  // causal window [lastGreenCommit .. firstBadCommit] is as tight as possible.
  const firstSeenRunRows = await db
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      status: testRuns.status,
      startTime: testRuns.startTime,
      environment: testRuns.environment,
      metadata: testRuns.metadata,
    })
    .from(testRuns)
    .where(eq(testRuns.id, cluster.firstSeenRunId));

  if (!firstSeenRunRows[0]) return result();

  try {
    const regression = await computeRegressionContext(db, firstSeenRunRows[0]);
    scmReached = true;
    const baseCommitOverride = opts.baseCommit?.trim() || undefined;

    if (regression.hasGreen) {
      scmCov.hasLastGreen = true;
      scmCov.hasCommitRange = Boolean(regression.commitRange);
      scmCov.baselineKind = baseCommitOverride ? 'manual' : 'run-green';

      const lines: string[] = [
        `## What Changed Since Last Green Run`,
        `- Last green run: #${regression.lastGreenRunId} (${regression.lastGreenRunAt.toISOString()})`,
        `- Baseline: ${regression.baselineNote}`,
        `- New failures in this run: ${regression.newFailures}`,
      ];
      if (regression.commitRange) {
        const fromShort = baseCommitOverride ? baseCommitOverride.slice(0, 7) : regression.commitRange.fromShort;
        lines.push(`- Commit range: ${fromShort}..${regression.commitRange.toShort}`);
        if (baseCommitOverride) lines.push(`- Note: baseline overridden by user to ${baseCommitOverride}`);
        lines.push(`- Git command: \`git log ${fromShort}..${regression.commitRange.toShort}\``);
      }
      if (regression.metadataDiff.length > 0) {
        lines.push(`- Changed metadata:`);
        for (const d of regression.metadataDiff) {
          lines.push(`  - ${d.label}: ${d.before ?? 'none'} → ${d.after ?? 'none'}`);
        }
      }
      sections.push({ id: 'scmInvestigation', markdown: lines.join('\n') });

      if (regression.commitRange) {
        setRange(
          regression.commitRange.repositoryUrl,
          baseCommitOverride ?? regression.commitRange.fromSha,
          regression.commitRange.toSha,
        );
      } else if (regression.lastGreenCommit && regression.lastGreenCommit === regression.currentCommit) {
        // The last passing run tested the same commit: an empty range, which says
        // the change is not in the code.
        scmCov.range = { from: regression.currentCommit.slice(0, 7), to: regression.currentCommit.slice(0, 7) };
      }

      // Fetch actual changed files from SCM API
      if (regression.commitRange?.repositoryUrl) {
        scmCov.provider = detectScmProvider(regression.commitRange.repositoryUrl);
        if (baseCommitOverride) scmCov.baseCommitUsed = baseCommitOverride;
        await readDiff(
          regression.commitRange.repositoryUrl,
          baseCommitOverride ?? regression.commitRange.fromSha,
          regression.commitRange.toSha,
          '## Changed Files Since Last Green Run',
        );
      }
    } else if (baseCommitOverride) {
      // No last green run — user provided a manual baseline commit; try to fetch diff anyway
      const currMeta = firstSeenRunRows[0].metadata as RunMetadata | null;
      const currentCommit: string | null = currMeta?.scm?.commit ?? null;
      const remoteUrl: string | null = currMeta?.scm?.remoteUrl ?? null;
      const repositoryUrl = normalizeGitUrl(remoteUrl);

      scmCov.hasCommitRange = Boolean(currentCommit && repositoryUrl);
      if (currentCommit) {
        scmCov.baselineKind = 'manual';
        scmCov.baseCommitUsed = baseCommitOverride;
        setRange(repositoryUrl, baseCommitOverride, currentCommit);
      }

      if (currentCommit && repositoryUrl) {
        scmCov.provider = detectScmProvider(repositoryUrl);
        scmCov.baseCommitUsed = baseCommitOverride;
        scmCov.baselineKind = 'manual';

        const fromShort = baseCommitOverride.slice(0, 7);
        const toShort = currentCommit.slice(0, 7);
        sections.push({
          id: 'scmInvestigation',
          markdown: [
            `## What Changed (Manual Baseline)`,
            `- Baseline commit (user-provided): ${baseCommitOverride}`,
            `- Current commit: ${toShort}`,
            `- No previous passing run found; using manual baseline`,
            `- Git command: \`git log ${fromShort}..${toShort}\``,
          ].join('\n'),
        });

        await readDiff(repositoryUrl, baseCommitOverride, currentCommit, '## Changed Files (Manual Baseline)');
      } else {
        sections.push({
          id: 'scmInvestigation',
          markdown: [
            `## What Changed (Manual Baseline)`,
            `> Note: baseline commit provided (${baseCommitOverride}) but could not determine current commit or repository URL from run metadata.`,
          ].join('\n'),
        });
      }
    } else if (signals.testCaseId) {
      // No project-wide green run and no manual override — fall back to the last run where
      // this specific test case passed. Gives a tighter causal window than "no SCM data."
      const lastPassRows = await db
        .select({ testRunId: testRunsCases.testRunId })
        .from(testRunsCases)
        .where(and(eq(testRunsCases.testCaseId, signals.testCaseId), eq(testRunsCases.status, 'passed')))
        .orderBy(desc(testRunsCases.id))
        .limit(1);

      if (lastPassRows[0]) {
        const [lastPassRun] = await db
          .select({ metadata: testRuns.metadata })
          .from(testRuns)
          .where(eq(testRuns.id, lastPassRows[0].testRunId))
          .limit(1);

        const lastPassMeta = (lastPassRun?.metadata as RunMetadata | null) ?? null;
        const lastPassCommit: string | null = lastPassMeta?.scm?.commit ?? null;
        const currMeta = firstSeenRunRows[0].metadata as RunMetadata | null;
        const currentCommit: string | null = currMeta?.scm?.commit ?? null;
        const remoteUrl: string | null = currMeta?.scm?.remoteUrl ?? lastPassMeta?.scm?.remoteUrl ?? null;
        const repositoryUrl = normalizeGitUrl(remoteUrl);

        if (lastPassCommit && currentCommit) {
          scmCov.baselineKind = 'test-green';
          if (lastPassCommit !== currentCommit) setRange(repositoryUrl, lastPassCommit, currentCommit);
          else scmCov.range = { from: currentCommit.slice(0, 7), to: currentCommit.slice(0, 7) };
        }
        if (lastPassCommit && currentCommit && repositoryUrl && lastPassCommit !== currentCommit) {
          scmCov.baselineKind = 'test-green';
          scmCov.hasCommitRange = true;
          scmCov.baseCommitUsed = lastPassCommit;
          scmCov.provider = detectScmProvider(repositoryUrl);

          const fromShort = lastPassCommit.slice(0, 7);
          const toShort = currentCommit.slice(0, 7);
          sections.push({
            id: 'scmInvestigation',
            markdown: [
              `## What Changed (Per-Test Baseline)`,
              `- Last passing run for this test: run #${lastPassRows[0].testRunId}`,
              `- No project-wide green run found; using per-test last-pass as baseline`,
              `- Commit range: ${fromShort}..${toShort}`,
              `- Git command: \`git log ${fromShort}..${toShort}\``,
            ].join('\n'),
          });

          await readDiff(repositoryUrl, lastPassCommit, currentCommit, '## Changed Files (Per-Test Baseline)');
        }
      }
    }
  } catch {
    // omit section if regression context fails
  }

  return result();
}

/** Diffs for commits the user explicitly picked, sharing one patch budget. */
async function selectedCommitsSection(
  db: DbClient,
  cluster: FailureCluster,
  opts: BuildContextOptions,
  limits: ContextLimits,
): Promise<string | null> {
  if (!opts.selectedCommitShas?.length) return null;
  try {
    const [runForUrl] = await db
      .select({ metadata: testRuns.metadata })
      .from(testRuns)
      .where(eq(testRuns.id, cluster.lastSeenRunId));
    const meta = runForUrl?.metadata as RunMetadata | null;
    const repoUrl = normalizeGitUrl(meta?.scm?.remoteUrl ?? null);
    if (!repoUrl) return null;

    const provider = await createScmProvider(repoUrl, db, cluster.projectId);
    if (!provider) return null;

    const commitLines: string[] = ['## Commits Manually Selected for Context'];
    // Shared budget so the total patch size across all selected commits is capped.
    const budget = { remaining: limits.scmPatchBudget };
    for (const sha of opts.selectedCommitShas.slice(0, 10)) {
      try {
        const commitDiff = await provider.fetchCommitDiff(sha);
        if (commitDiff?.files.length) {
          commitLines.push(`\n### ${sha.slice(0, 7)}`);
          commitLines.push(`Changed files (${commitDiff.files.length}):`);
          for (const f of commitDiff.files) commitLines.push(formatChangedFileLine(f));
          const { patches } = renderBudgetedPatches(commitDiff.files, budget);
          if (patches.length) {
            commitLines.push(`\nPatches:\n\`\`\`diff\n${patches.join('\n\n')}\n\`\`\``);
          }
        }
      } catch {
        /* skip individual commit on error */
      }
    }
    return commitLines.length > 1 ? commitLines.join('\n') : null;
  } catch {
    /* skip entire block on error */
    return null;
  }
}

/**
 * Assemble the full markdown context sent to the AI for a failure cluster.
 * Returns the rendered text, SCM coverage (for the UI status line) and the raw
 * SCM changes (so the UI can render the diff without re-fetching).
 * @deprecated Use `buildDiagnosisContext` instead for scope-aware, sectioned output.
 */
export async function buildClusterDiagnosisContext(
  db: DbClient,
  cluster: FailureCluster,
  opts?: BuildContextOptions,
): Promise<{
  text: string;
  coverage: DiagnosisContextCoverage;
  scmChanges: ScmChanges | null;
  images?: AiAttachedImage[];
}> {
  const result = await buildDiagnosisContext(db, { kind: 'cluster', clusterId: cluster.id, ...opts });
  return { text: result.text, coverage: result.coverage, scmChanges: result.scmChanges, images: result.images };
}

// ── Scope-aware diagnosis context builder ────────────────────────────────────

/**
 * Build the full diagnosis context. Scope-aware:
 * - `cluster` scope: evidence from a failure cluster.
 * - `execution` scope: evidence from a single test-runs-case, with optional cluster context.
 *
 * Returns a structured `BuiltDiagnosisContext` with sectioned markdown, coverage,
 * auto-resolved images, and a token estimate.
 */
export async function buildDiagnosisContext(
  db: DbClient,
  opts: DiagnosisScope & BuildContextOptions,
): Promise<BuiltDiagnosisContext> {
  const limits = await resolveContextLimits(db);
  const contextSections: ContextSection[] = [];
  let coverage: DiagnosisContextCoverage = { scm: null };
  let scmChanges: ScmChanges | null = null;
  let images: AiAttachedImage[] | undefined;
  let sourceFilesOut: BuiltDiagnosisContext['sourceFiles'];
  let clusterInfo: BuiltDiagnosisContext['cluster'];
  let suspectLinesAbsentReason: string | null = null;

  const push = (cs: ContextSection | null | undefined) => {
    if (cs) contextSections.push(cs);
  };

  // Resolve the failure cluster: required in cluster scope, optional context in
  // execution scope (only when the caller passes a clusterId).
  const clusterId = opts.clusterId;
  const cluster =
    clusterId != null
      ? await db
          .select()
          .from(failureClusters)
          .where(eq(failureClusters.id, clusterId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : null;

  if (opts.kind === 'cluster' && !cluster) {
    throw new Error(`Failure cluster ${opts.clusterId} not found`);
  }

  if (cluster) {
    clusterInfo = {
      id: cluster.id,
      signature: cluster.signature,
      occurrences: cluster.occurrences,
      pattern: 'unknown',
    };

    // Cluster-level summary sections.
    push(section('clusterSummary', 'Failure Cluster', await clusterSummarySection(db, cluster)));
    push(section('sampleError', 'Sample Raw Error', sampleErrorSection(cluster, limits)));
    push(section('affectedTests', 'Affected Tests', await affectedTestsSection(db, cluster, limits), undefined));
    push(section('browserDistribution', 'Browser Distribution', await browserDistributionSection(db, cluster)));
  }

  // The representative/target execution: latest in the cluster (cluster scope) or
  // the specific run-case (execution scope).
  const rep =
    opts.kind === 'cluster'
      ? cluster
        ? await loadRepresentativeExecution(db, cluster)
        : null
      : await loadExecutionById(db, opts.executionId);

  if (rep) {
    // When Playwright attaches an error-context.md (ref-annotated page snapshot
    // with DOM hierarchy), prefer it over the stored flat snapshot. It is already
    // uploaded — this just reads it.
    const errorContextAria = await resolveErrorContextAria(db, rep);
    if (errorContextAria) {
      rep.ariaSnapshot = errorContextAria;
    }

    // Self-labeling per-execution sections (error/source/steps/console/network/
    // server-logs/web-vitals/ARIA) — pushed by their own id, no positional guessing.
    for (const s of representativeExecutionSections(rep, cluster, limits)) {
      push(section(s.id, REP_SECTION_TITLES[s.id] ?? s.id, s.markdown));
    }

    // Deterministic clues — placed right after the errors so the model reads
    // them as evidence to confirm or refute, each with its [section] citation.
    push(section('clues', 'Clues', await cluesSection(db, rep, limits)));

    // Failing steps
    push(section('failingSteps', 'Failed Steps', failingStepsSection(rep, limits)));

    // Run context (partial run, parallelism, describe path, flaky class)
    push(section('runContext', 'Run Context', runContextSection(rep)));

    // Test annotations (@fixme/@flaky/@slow …)
    push(section('testAnnotations', 'Test Annotations', testAnnotationsSection(rep)));

    // Passed peers (with serial-mode detection)
    const peersResult = await passedPeersSection(db, rep, limits);
    if (peersResult.notApplicableReason) {
      coverage = {
        ...coverage,
        notApplicable: { ...coverage.notApplicable, passedPeers: peersResult.notApplicableReason },
      };
    } else {
      push(section('passedPeers', 'Passed Peers', peersResult.section));
    }

    // Alternative locators from prior success / ARIA snapshot — computed here
    // so the nearest-ARIA hint below can be skipped when healing already
    // surfaces grounded alternatives (the two would duplicate evidence).
    const healing = await locatorHealingSection(db, rep);

    // Nearest accessible-name hint for locator failures
    if (!healing.section) {
      push(section('nearestAriaNames', 'Nearest Matching ARIA Names', nearestAriaNamesSection(rep)));
    }

    // Compared to last pass (duration/vitals/console/steps deltas) + already-green check
    const baselineResult = await baselineComparisonSection(db, rep, cluster?.lastSeenRunId);
    push(section('baselineComparison', 'Compared to Last Pass', baselineResult.section));
    if (baselineResult.alreadyGreen) {
      coverage = { ...coverage, alreadyGreen: true };
    }

    // App state at test end (+ diff vs the last pass when captured there too)
    const appStateResult = await appStateSection(db, rep);
    push(section('appState', 'App State', appStateResult.section));
    coverage = { ...coverage, appState: appStateResult.coverage };

    // Environment diff vs last pass (whitelisted run/browser metadata keys)
    const envDiffResult = await environmentDiffSection(db, rep);
    push(section('environmentDiff', 'Environment Diff vs Last Pass', envDiffResult.section));
    coverage = { ...coverage, environmentDiff: envDiffResult.coverage };

    // Retry progression (per-attempt error evolution)
    push(section('retryProgression', 'Retry Progression', await retryProgressionSection(db, rep)));

    // Recurrence & flakiness (cluster-scoped), with the retry-behavior one-liner
    // folded into this section.
    if (cluster) {
      let flakinessText = await recurrenceFlakinessSection(db, cluster);
      const retryText = await retryBehaviorSection(db, cluster);
      if (retryText) flakinessText = flakinessText ? `${flakinessText}\n\n${retryText}` : retryText;
      push(section('recurrenceFlakiness', 'Recurrence & Flakiness', flakinessText));

      if (flakinessText && clusterInfo) {
        if (flakinessText.includes('intermittent')) clusterInfo.pattern = 'intermittent';
        else if (flakinessText.includes('persistent')) clusterInfo.pattern = 'persistent';
      }
    }

    // Trace pointers
    push(section('tracePointers', 'Trace Files', await tracePointersSection(db, rep)));

    // Failing action from trace parsing
    push(section('failingAction', 'Failing Action (from Trace)', await failingActionSection(db, rep, limits)));

    // Failure-time DOM snapshot rendered from the same trace blob
    const domSnapResult = await domSnapshotSection(db, rep, limits);
    push(section('domSnapshot', 'DOM Snapshot (from Trace)', domSnapResult.section));
    coverage = { ...coverage, domSnapshot: domSnapResult.coverage };

    // Full call stack (stacks index + embedded sources) from the same trace blob
    const traceStackResult = await traceCallStackSection(db, rep, limits);
    push(section('traceCallStack', 'Full Call Stack (from Trace)', traceStackResult.section));
    coverage = { ...coverage, traceCallStack: traceStackResult.coverage };

    // Every request from the trace's HAR-like network stream
    const traceNetworkResult = await traceNetworkSection(db, rep, limits);
    push(section('traceNetwork', 'Network Activity (from Trace)', traceNetworkResult.section));
    coverage = { ...coverage, traceNetwork: traceNetworkResult.coverage };

    // Alternative locators from prior success / ARIA snapshot (computed above,
    // before the nearest-ARIA hint)
    push(section('locatorHealing', 'Alternative Locators (Locator Healing)', healing.section));
    if (healing.coverage) {
      coverage = { ...coverage, locatorHealing: healing.coverage };
    }

    // Attachments & artifacts (video, HAR, custom files) — pointers only
    push(section('artifacts', 'Attachments & Artifacts', await artifactsSection(db, rep)));

    // Auto-resolve screenshots. `chars` reflects the markdown reference only;
    // the base64 image payload is billed as vision tokens, estimated separately.
    images = await resolveScreenshots(db, rep, limits);
    if (images.length > 0) {
      for (const img of images) {
        const markdown = `![${img.name}](/api/files/screenshot)`;
        contextSections.push({
          id: 'screenshots',
          title: `Screenshot: ${img.name}`,
          chars: markdown.length,
          truncated: false,
          markdown,
        });
      }
    }

    // Visual diff vs the last passing screenshot — lazily computed and cached.
    // Only meaningful for a failing execution with screenshots on both sides.
    if (rep.error) {
      const visualDiff = await getOrComputeVisualDiff(db, rep.id).catch(() => ({ status: 'error' as const }));
      if (visualDiff.status === 'ok' && 'diff' in visualDiff && visualDiff.diff) {
        const d = visualDiff.diff;
        const pct = (d.changedPixelRatio * 100).toFixed(2);
        const mismatchNote = d.dimensionMismatch
          ? '\n- ⚠️ The screenshots have different dimensions (viewport change?) — compared on a padded union canvas, so the ratio is inflated and unreliable.'
          : '';
        const baselineNote = d.baselineNote ? ` — ${d.baselineNote}` : '';
        const md = `## Visual Diff vs Last Pass\nPixel comparison of the failing screenshot against the same test's last passing screenshot (run #${d.baselineRunId}${baselineNote}):\n- Changed pixels: ${d.changedPixels} of ${d.width * d.height} (${pct}%)${mismatchNote}\n- The diff overlay (red = changed pixels) is attached as image "visual-diff".`;
        push(section('visualDiff', 'Visual Diff vs Last Pass', md));
        coverage = {
          ...coverage,
          visualDiff: { changedPixelRatio: d.changedPixelRatio, dimensionMismatch: d.dimensionMismatch },
        };
        if (images.length < limits.maxImages) {
          try {
            const overlay = await getStorage().readFile(d.path);
            images.push({ name: 'visual-diff', mediaType: 'image/png', data: overlay.toString('base64') });
          } catch {
            // The metric section stands on its own when the overlay is unreadable.
          }
        }
      }
    }

    // SCM investigation (network fetch, cluster-scoped) — skippable for the lean research pass
    if (cluster && !opts.skipScm) {
      const scm = await scmInvestigationSections(db, cluster, opts, limits, {
        testFilePath: rep.testFilePath,
        testTitle: rep.testTitle,
        ariaSnapshot: rep.ariaSnapshot,
        testSource: rep.testSource,
        errorText: rep.error ?? cluster.sampleError,
        testCaseId: rep.testCaseId,
      });
      // One section per id: the range and its changed files are one SCM investigation.
      const scmParts = new Map<SectionId, string[]>();
      for (const s of scm.sections) scmParts.set(s.id, [...(scmParts.get(s.id) ?? []), s.markdown]);
      for (const [id, parts] of scmParts) push(section(id, SCM_SECTION_TITLES[id] ?? id, parts.join('\n\n')));
      coverage = { ...coverage, scm: scm.coverage, suspectLines: scm.suspectLines.coverage };
      suspectLinesAbsentReason = scm.suspectLines.absentReason;
      scmChanges = scm.scmChanges;

      // Full source files (suspect changed files + test imports) — grounds patch suggestions.
      if (scm.sourceFiles.text) push(section('sourceFiles', 'Source Files', scm.sourceFiles.text));
      if (scm.sourceFiles.coverage) coverage = { ...coverage, sourceFiles: scm.sourceFiles.coverage };
      if (scm.sourceFiles.files.length > 0) sourceFilesOut = scm.sourceFiles.files;

      // Selected commits (network fetch)
      push(
        section(
          'selectedCommits',
          'Manually Selected Commits',
          await selectedCommitsSection(db, cluster, opts, limits),
        ),
      );
    }
  }

  // Prior diagnosis + triage note (cluster-scoped)
  if (cluster) {
    push(section('priorDiagnosis', 'Prior Assessment', await priorDiagnosisSection(db, cluster)));
    // A previously fixed similar failure — the resolved cluster this one most
    // resembles, so the model can reuse a known fix rather than re-derive it.
    push(section('previouslyFixed', 'Previously Fixed Similar Failure', await previouslyFixedSection(db, cluster)));
  }

  // Build absent-section reasons for sections where we know *why* data is
  // missing — helps the model stop speculating and tells the human which
  // reporter/dashboard setting would buy better evidence.
  const absentReasons: Record<string, string> = {};
  const sectionIds = new Set(contextSections.map((s) => s.id));
  if (!sectionIds.has('testSource')) {
    absentReasons.testSource =
      'not captured by the reporter — requires a recent reporter version and the test file to be readable at run time';
  }
  if (!sectionIds.has('failingAction')) {
    absentReasons.failingAction = 'no trace files found — enable trace recording in Playwright config';
  }
  if (!sectionIds.has('traceCallStack')) {
    absentReasons.traceCallStack =
      'no trace with a stacks index — record traces (trace: "retain-on-failure"; the test runner embeds sources by default) to include the full call stack';
  }
  if (!sectionIds.has('traceNetwork')) {
    absentReasons.traceNetwork =
      'no trace network stream — enable trace recording in Playwright config to include every request the page made';
  }
  if (!sectionIds.has('suspectLines') && cluster) {
    absentReasons.suspectLines = suspectLinesAbsentReason ?? 'no SCM diff to join with coverage';
  }
  if (!sectionIds.has('scmInvestigation') && cluster) {
    const scmError = coverage.scm?.error;
    absentReasons.scmInvestigation = scmError
      ? `SCM diff fetch failed: ${scmError}`
      : 'no SCM diff available — check repository URL in project settings or configure a SCM token';
  }
  // The capture fixtures were active for this execution when any fixture-produced
  // field is present that was not itself recovered from the trace. The humans'
  // empty cards read the same signal via `resolveEvidenceState`, so the model and
  // the reader get the same reason for a blank section.
  const evidenceSrc = (rep?.evidenceSources as { console?: string; network?: string; aria?: string } | null) ?? {};
  const fixturesActive =
    (sectionIds.has('console') && evidenceSrc.console !== 'trace') ||
    (sectionIds.has('networkRequests') && evidenceSrc.network !== 'trace') ||
    sectionIds.has('appState') ||
    sectionIds.has('webVitals') ||
    (Boolean(rep?.ariaSnapshot) && evidenceSrc.aria !== 'trace') ||
    Boolean(rep?.aiUsage);

  // Resolved capability states for the execution's project, so a source a team
  // declined reads "declined for this project" rather than "not captured".
  const projectId = cluster?.projectId ?? rep?.projectId ?? null;
  const capabilityStates = projectId != null ? await resolveProjectStates(db, projectId) : null;
  const fixturesState = capabilityStates?.fixtures;
  const backendLogsState = capabilityStates?.['backend-logs'];

  if (!sectionIds.has('console')) {
    absentReasons.console = evidenceAbsenceReason('console', {
      hasData: false,
      fixturesActive,
      capability: fixturesState,
    })!;
  }
  if (!sectionIds.has('networkRequests')) {
    absentReasons.networkRequests = evidenceAbsenceReason('network', {
      hasData: false,
      fixturesActive,
      capability: fixturesState,
    })!;
  }
  if (!sectionIds.has('serverTraces')) {
    absentReasons.serverTraces = evidenceAbsenceReason('backendLogs', {
      hasData: false,
      fixturesActive,
      capability: backendLogsState,
    })!;
  }
  if (!sectionIds.has('serverLogs')) {
    absentReasons.serverLogs = evidenceAbsenceReason('backendLogs', {
      hasData: false,
      fixturesActive,
      capability: backendLogsState,
    })!;
  }
  if (!sectionIds.has('webVitals')) {
    absentReasons.webVitals = evidenceAbsenceReason('webVitals', {
      hasData: false,
      fixturesActive,
      capability: fixturesState,
    })!;
  }
  if (!sectionIds.has('environmentDiff')) {
    absentReasons.environmentDiff = 'no passing baseline execution recorded for this test to compare against';
  }
  if (!sectionIds.has('visualDiff')) {
    absentReasons.visualDiff =
      'no comparable screenshots — requires a screenshot on both the failing execution and a passing baseline run';
  }
  if (!sectionIds.has('domSnapshot')) {
    absentReasons.domSnapshot =
      'no DOM snapshot — requires an uploaded trace containing frame snapshots (enable trace recording and uploadTraces)';
  }
  if (!sectionIds.has('appState')) {
    absentReasons.appState = evidenceAbsenceReason('appState', {
      hasData: false,
      fixturesActive,
      capability: fixturesState,
    })!;
  }

  const coverageBlock = buildCoverageBlock(contextSections, {
    hasCluster: Boolean(cluster),
    notApplicable: coverage.notApplicable,
    absentReasons,
  });

  // Sort sections into a fixed narrative order — stable across re-runs
  // (makes prompt caching effective) and optimised for one-pass reading.
  const orderMap = new Map(SECTION_ORDER.map((id, i) => [id, i]));
  contextSections.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));

  const text = [coverageBlock, ...contextSections.map((s) => s.markdown).filter(Boolean)].join('\n\n');
  const textChars = contextSections.reduce((sum, s) => sum + s.chars, 0) + coverageBlock.length;

  // Images are billed as vision tokens (fixed per-image estimate), not as the
  // base64 text length — counting the base64 as text over-estimates by ~100×.
  const imageTokenEstimate = (images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
  const textTokenEstimate = Math.ceil(textChars / 4);

  return {
    scope:
      opts.kind === 'cluster'
        ? { kind: 'cluster', clusterId: opts.clusterId }
        : { kind: 'execution', executionId: opts.executionId },
    text,
    sections: contextSections,
    coverage,
    scmChanges,
    images,
    sourceFiles: sourceFilesOut,
    tokenEstimate: textTokenEstimate + imageTokenEstimate,
    textTokenEstimate,
    imageTokenEstimate,
    cluster: clusterInfo,
  };
}
