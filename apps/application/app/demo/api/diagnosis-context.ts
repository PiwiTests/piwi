/**
 * Demo-mode AI diagnosis context builder.
 *
 * The real dashboard assembles a rich, evidence-grounded context from a live
 * database, object storage (screenshots/traces) and a SCM provider before it asks
 * the model to diagnose a failure. The demo has none of those services, so this
 * module reconstructs an equivalent context from the in-browser seed database plus
 * the canned SCM history in `app/demo/demo-scm.ts`.
 *
 * The output shape matches the server's `?format=json` context response
 * (`{ text, sections, coverage, scmChanges, tokenEstimate, imageTokenEstimate }`)
 * so the "Context sent to AI" modal, the data-coverage map, and the SCM
 * investigation panel render exactly as they do against a real server.
 *
 * The per-section markdown here is intentionally demo-specific — the server's
 * formatters are coupled to server-only row loaders and storage — but the section
 * *ids* and coverage semantics are shared via `#shared/diagnosis-sections`, so the
 * two stay aligned. This is the "implementation fundamentally differs" carve-out to
 * the no-duplication rule (AGENTS.md): both sides read the same schema, but only the
 * server can reach storage and the network.
 */

import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { getAppSetting } from '~~/server/utils/app-settings';
import { buildDiagnosisSystemPrompt } from '~~/server/utils/ai-system-prompt';
import { buildPromptPreview } from '#shared/ai-prompt-preview';
import { DIAGNOSIS_JSON_SCHEMA } from '#shared/ai-diagnosis';
import {
  failureClusters,
  failureDiagnoses,
  testRuns,
  testRunsCases,
  testCases,
  networkRequests,
  files,
  projects,
} from '../../../server/database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { DIAGNOSIS_SECTIONS } from '#shared/diagnosis-sections';
import { getLocatorHealing } from '~~/server/utils/locator-healing';
import { healingNotApplicableMarkdown } from '#shared/locator-resolution';
import { getEnvironmentDiff } from '~~/server/utils/environment-diff';
import { renderEnvironmentDiffMarkdown } from '#shared/environment-diff';
import { apiGetDemoDomSnapshot } from './dom-snapshot';
import { apiGetDemoTraceStacks, apiGetDemoTraceNetwork, apiGetDemoTraceNetworkBody } from './trace-insights';
import {
  formatTraceCallStackSection,
  formatTraceNetworkSection,
  selectTraceNetworkRequests,
  type TraceNetworkBodyExcerpt,
} from '~~/server/utils/trace-insights';
import { DEFAULT_CONTEXT_LIMITS } from '#shared/ai-context-limits';
import type { TraceCallStackResponse, TraceNetworkResponse } from '~~/types/api';
import { renderAppStateMarkdown, type PageStateLike } from '#shared/page-state';
import { getLastPassPageState } from '#shared/handlers/test-cases';
import type { ContextSection, DiagnosisContextCoverage, ScmChanges } from '~~/types/api';
import { getDemoScmProject, getDemoChangesSince, getDemoChangesForShas } from '../demo-scm';

// ── Section plumbing ────────────────────────────────────────────────────────

export type { ContextSection };

function section(id: string, title: string, markdown: string | null, items?: number): ContextSection | null {
  if (!markdown) return null;
  return {
    id,
    title,
    chars: markdown.length,
    truncated: markdown.includes('[truncated]'),
    markdown,
    ...(items !== undefined ? { items } : {}),
  };
}

/** Narrative order — mirrors the server's SECTION_ORDER for a one-pass read. */
const SECTION_ORDER = [
  'clusterSummary',
  'sampleError',
  'executionError',
  'representativeExecution',
  'testSource',
  'sourceFiles',
  'traceCallStack',
  'failingSteps',
  'steps',
  'ariaSnapshot',
  'domSnapshot',
  'screenshots',
  'visualDiff',
  'locatorHealing',
  'console',
  'networkRequests',
  'traceNetwork',
  'serverLogs',
  'webVitals',
  'appState',
  'environmentDiff',
  'recurrenceFlakiness',
  'browserDistribution',
  'affectedTests',
  'scmInvestigation',
  'topSuspectedCommit',
  'selectedCommits',
  'priorDiagnosis',
  'runContext',
  'testAnnotations',
];

// ── DB shapes ───────────────────────────────────────────────────────────────

interface RepRow {
  id: number;
  runId: number;
  testCaseId: number | null;
  browserName: string | null;
  status: string;
  duration: number | null;
  error: string | null;
  steps: Array<{ title: string; duration: number; category: string }> | null;
  consoleLogs: Array<{ type: string; text: string }> | null;
  webVitals: {
    navigation?: Record<string, number>;
    paint?: Record<string, number>;
    vitals?: Record<string, number | null>;
  } | null;
  pageState: import('#shared/page-state').PageStateLike | null;
  ariaSnapshot: string | null;
  browser: { projectName?: string; browserName?: string } | null;
  testAnnotations: Array<{ type: string; description?: string }> | null;
  slowestStep: string | null;
  slowestStepDuration: number | null;
  title: string;
  filePath: string;
  line: number | null;
  column: number | null;
  runStatus: string;
  isFullRun: number | null;
  metadata: { ci?: Record<string, string>; scm?: Record<string, string> } | null;
  startTime: number | null;
}

/** Load the most-recent failing execution in a cluster (the representative). */
async function loadClusterRep(db: DrizzleDB, clusterId: number): Promise<RepRow | null> {
  const rows = await db
    .select({
      id: testRunsCases.id,
      runId: testRunsCases.testRunId,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      error: testRunsCases.error,
      steps: testRunsCases.steps,
      consoleLogs: testRunsCases.consoleLogs,
      webVitals: testRunsCases.webVitals,
      pageState: testRunsCases.pageState,
      ariaSnapshot: testRunsCases.ariaSnapshot,
      browser: testRunsCases.browser,
      testAnnotations: testRunsCases.testAnnotations,
      slowestStep: testRunsCases.slowestStep,
      slowestStepDuration: testRunsCases.slowestStepDuration,
      title: testCases.title,
      filePath: testCases.filePath,
      line: testRunsCases.line,
      column: testRunsCases.column,
      runStatus: testRuns.status,
      isFullRun: testRuns.isFullRun,
      metadata: testRuns.metadata,
      startTime: testRuns.startTime,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(testRunsCases.failureClusterId, clusterId))
    .orderBy(desc(testRunsCases.testRunId))
    .limit(1);
  return (rows[0] as RepRow | undefined) ?? null;
}

async function loadExecutionRep(db: DrizzleDB, testRunsCaseId: number): Promise<RepRow | null> {
  const rows = await db
    .select({
      id: testRunsCases.id,
      runId: testRunsCases.testRunId,
      testCaseId: testRunsCases.testCaseId,
      browserName: testRunsCases.browserName,
      status: testRunsCases.status,
      duration: testRunsCases.duration,
      error: testRunsCases.error,
      steps: testRunsCases.steps,
      consoleLogs: testRunsCases.consoleLogs,
      webVitals: testRunsCases.webVitals,
      pageState: testRunsCases.pageState,
      ariaSnapshot: testRunsCases.ariaSnapshot,
      browser: testRunsCases.browser,
      testAnnotations: testRunsCases.testAnnotations,
      slowestStep: testRunsCases.slowestStep,
      slowestStepDuration: testRunsCases.slowestStepDuration,
      title: testCases.title,
      filePath: testCases.filePath,
      line: testRunsCases.line,
      column: testRunsCases.column,
      runStatus: testRuns.status,
      isFullRun: testRuns.isFullRun,
      metadata: testRuns.metadata,
      startTime: testRuns.startTime,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(testRunsCases.id, testRunsCaseId))
    .limit(1);
  return (rows[0] as RepRow | undefined) ?? null;
}

// ── Structured evidence (also consumed by the streaming diagnosis) ───────────

export interface ClusterEvidence {
  cluster: typeof failureClusters.$inferSelect;
  rep: RepRow | null;
  affectedTests: Array<{ title: string; filePath: string; count: number }>;
  browsers: Array<{ name: string; count: number }>;
  occurrences: number;
  runsInProject: number;
  failedRuns: number;
  failureRatePct: number;
  firstBuild: string | null;
  lastBuild: string | null;
  /** The representative execution's slowest request at or over the slow-request threshold. */
  slowRequest: { method: string; url: string; duration: number } | null;
}

export async function collectClusterEvidence(db: DrizzleDB, clusterId: number): Promise<ClusterEvidence | null> {
  const [cluster] = await db.select().from(failureClusters).where(eq(failureClusters.id, clusterId));
  if (!cluster) return null;

  const rep = await loadClusterRep(db, clusterId);

  const affectedRows = await db
    .select({
      title: testCases.title,
      filePath: testCases.filePath,
      count: sql<number>`count(${testRunsCases.id})`,
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.failureClusterId, clusterId))
    .groupBy(testCases.id, testCases.title, testCases.filePath)
    .orderBy(desc(sql`count(${testRunsCases.id})`));

  const browserRows = await db
    .select({
      name: sql<string>`json_extract(${testRunsCases.browser}, '$.projectName')`,
      count: sql<number>`count(${testRunsCases.id})`,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.failureClusterId, clusterId))
    .groupBy(sql`json_extract(${testRunsCases.browser}, '$.projectName')`)
    .orderBy(desc(sql`count(${testRunsCases.id})`));

  const [{ runsInProject } = { runsInProject: 0 }] = await db
    .select({ runsInProject: sql<number>`count(*)` })
    .from(testRuns)
    .where(eq(testRuns.projectId, cluster.projectId));

  const failedRunRows = await db
    .select({ runId: testRunsCases.testRunId })
    .from(testRunsCases)
    .where(eq(testRunsCases.failureClusterId, clusterId))
    .groupBy(testRunsCases.testRunId);
  const failedRuns = failedRunRows.length;

  // Build numbers of the first and last runs the cluster was seen in.
  const buildFor = async (runId: number | null): Promise<string | null> => {
    if (!runId) return null;
    const [row] = await db.select({ metadata: testRuns.metadata }).from(testRuns).where(eq(testRuns.id, runId));
    const meta = row?.metadata as { ci?: { buildNumber?: string } } | null;
    return meta?.ci?.buildNumber ?? null;
  };
  const [firstBuild, lastBuild] = await Promise.all([
    buildFor(cluster.firstSeenRunId),
    buildFor(cluster.lastSeenRunId),
  ]);

  const [slowRequest = null] = rep
    ? await db
        .select({ method: networkRequests.method, url: networkRequests.url, duration: networkRequests.duration })
        .from(networkRequests)
        .where(
          and(
            eq(networkRequests.testRunsCaseId, rep.id),
            gte(networkRequests.duration, DEFAULT_CONTEXT_LIMITS.slowRequestMs),
          ),
        )
        .orderBy(desc(networkRequests.duration))
        .limit(1)
    : [];

  const runsForRate = runsInProject || 1;
  return {
    cluster,
    rep,
    affectedTests: affectedRows.map((r) => ({ title: r.title, filePath: r.filePath, count: Number(r.count) })),
    browsers: browserRows.map((r) => ({ name: r.name || 'unknown', count: Number(r.count) })),
    occurrences: cluster.occurrences ?? affectedRows.reduce((s, r) => s + Number(r.count), 0),
    runsInProject: runsForRate,
    failedRuns,
    failureRatePct: Math.round((failedRuns / runsForRate) * 100),
    firstBuild,
    lastBuild,
    slowRequest: slowRequest?.url
      ? { method: slowRequest.method, url: slowRequest.url, duration: Number(slowRequest.duration) }
      : null,
  };
}

// ── Section markdown builders ────────────────────────────────────────────────

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function clusterSummaryMd(ev: ClusterEvidence): string {
  const c = ev.cluster;
  const lines = [
    '## Failure Cluster',
    `- **Signature:** \`${c.signature}\``,
    `- **Error type:** ${c.errorType}`,
    `- **Occurrences:** ${ev.occurrences} across ${ev.failedRuns} run(s)`,
    `- **Affected tests:** ${ev.affectedTests.length}`,
    `- **Triage status:** ${c.status}${c.triageNote ? ` — ${c.triageNote}` : ''}`,
  ];
  return lines.join('\n');
}

function sampleErrorMd(ev: ClusterEvidence): string {
  return `## Sample Raw Error\n\n\`\`\`\n${ev.cluster.sampleError ?? '(none)'}\n\`\`\``;
}

function affectedTestsMd(ev: ClusterEvidence): string {
  const lines = ['## Affected Tests', ''];
  for (const t of ev.affectedTests) {
    lines.push(`- \`${t.filePath}\` — ${t.title} (${t.count}×)`);
  }
  return lines.join('\n');
}

function browserDistributionMd(ev: ClusterEvidence): string {
  const lines = ['## Browser Distribution', ''];
  for (const b of ev.browsers) lines.push(`- ${b.name}: ${b.count} failure(s)`);
  return lines.join('\n');
}

function representativeExecutionMd(rep: RepRow): string {
  const meta = rep.metadata ?? {};
  const ci = meta.ci ?? {};
  const scm = meta.scm ?? {};
  const lines = [
    '## Representative Execution',
    `- **Test:** ${rep.title}`,
    `- **File:** \`${rep.filePath}:${rep.line ?? '?'}:${rep.column ?? '?'}\``,
    `- **Status:** ${rep.status}`,
    `- **Duration:** ${fmtDuration(rep.duration)}`,
    `- **Browser:** ${rep.browser?.projectName ?? 'unknown'} (${rep.browser?.browserName ?? '?'})`,
    `- **CI build:** ${ci.buildNumber ? `#${ci.buildNumber}` : 'n/a'}${ci.workflow ? ` · ${ci.workflow}` : ''}`,
    `- **Branch / commit:** ${scm.branch ?? '?'} @ ${scm.commit ?? '?'}`,
  ];
  return lines.join('\n');
}

function executionErrorMd(rep: RepRow): string {
  if (!rep.error) return '';
  return `## Representative Execution Error\n\n\`\`\`\n${rep.error}\n\`\`\``;
}

function stepsMd(rep: RepRow): string | null {
  if (!rep.steps?.length) return null;
  const lines = ['## Test Steps', ''];
  for (const s of rep.steps) lines.push(`- ${s.title} — ${fmtDuration(s.duration)} (${s.category})`);
  return lines.join('\n');
}

function failingStepsMd(rep: RepRow): string | null {
  if (!rep.slowestStep) return null;
  return `## Failed Steps\n\n- **${rep.slowestStep}** — slowest step at ${fmtDuration(rep.slowestStepDuration)}; the failure surfaced here.`;
}

function consoleMd(rep: RepRow): string | null {
  if (!rep.consoleLogs?.length) return null;
  const lines = ['## Browser Console Logs', ''];
  for (const l of rep.consoleLogs) lines.push(`- [${l.type}] ${l.text}`);
  return lines.join('\n');
}

function webVitalsMd(rep: RepRow): string | null {
  const v = rep.webVitals;
  if (!v) return null;
  const nav = v.navigation ?? {};
  const paint = v.paint ?? {};
  const vitals = v.vitals ?? {};
  const lines = ['## Web Vitals', ''];
  if (nav.ttfb != null) lines.push(`- TTFB: ${nav.ttfb}ms`);
  if (nav.domContentLoaded != null) lines.push(`- DOM content loaded: ${nav.domContentLoaded}ms`);
  if (nav.loadComplete != null) lines.push(`- Load complete: ${nav.loadComplete}ms`);
  if (paint.firstContentfulPaint != null) lines.push(`- First contentful paint: ${paint.firstContentfulPaint}ms`);
  if (vitals.lcp != null) lines.push(`- LCP: ${vitals.lcp}ms`);
  if (vitals.cls != null) lines.push(`- CLS: ${vitals.cls}`);
  if (vitals.inp != null) lines.push(`- INP: ${vitals.inp}ms`);
  return lines.length > 2 ? lines.join('\n') : null;
}

function ariaMd(rep: RepRow): string | null {
  if (!rep.ariaSnapshot) return null;
  return `## ARIA Snapshot\n\n\`\`\`yaml\n${rep.ariaSnapshot}\n\`\`\``;
}

function runContextMd(rep: RepRow): string {
  const scm = rep.metadata?.scm ?? {};
  const lines = [
    '## Run Context',
    `- **Run type:** ${rep.isFullRun ? 'full run' : 'filtered / partial run'}`,
    `- **Run status:** ${rep.runStatus}`,
    `- **Branch:** ${scm.branch ?? '?'}`,
  ];
  return lines.join('\n');
}

function annotationsMd(rep: RepRow): string | null {
  if (!rep.testAnnotations?.length) return null;
  const lines = ['## Test Annotations', ''];
  for (const a of rep.testAnnotations) lines.push(`- @${a.type}${a.description ? ` — ${a.description}` : ''}`);
  return lines.join('\n');
}

function recurrenceMd(ev: ClusterEvidence): string {
  const range = ev.firstBuild && ev.lastBuild ? ` (builds #${ev.lastBuild}–#${ev.firstBuild})` : '';
  const cls = ev.failureRatePct >= 80 ? 'persistent' : 'intermittent';
  return [
    '## Recurrence & Flakiness',
    `- Seen in ${ev.failedRuns} of ${ev.runsInProject} recent runs (${ev.failureRatePct}% failure rate)${range}.`,
    `- Classified as **${cls}** based on the failure distribution across runs.`,
  ].join('\n');
}

async function serverLogsMd(db: DrizzleDB, repId: number): Promise<string | null> {
  const rows = await db
    .select({
      url: networkRequests.url,
      method: networkRequests.method,
      status: networkRequests.status,
      serverLogs: networkRequests.serverLogs,
    })
    .from(networkRequests)
    .where(eq(networkRequests.testRunsCaseId, repId));
  const withLogs = rows.filter((r) => Array.isArray(r.serverLogs) && (r.serverLogs as unknown[]).length > 0);
  if (!withLogs.length) return null;
  const lines = ['## Backend Server Logs', ''];
  for (const r of withLogs) {
    lines.push(`**${r.method} ${r.url} → ${r.status}**`);
    for (const l of r.serverLogs as Array<{ level: string; message: string; stack?: string }>) {
      lines.push(`- [${l.level}] ${l.message}`);
      if (l.stack) lines.push(`  \`\`\`\n  ${l.stack.split('\n').join('\n  ')}\n  \`\`\``);
    }
  }
  return lines.join('\n');
}

async function networkMd(db: DrizzleDB, repId: number): Promise<{ md: string | null; items: number }> {
  const rows = await db
    .select({
      method: networkRequests.method,
      url: networkRequests.url,
      status: networkRequests.status,
      duration: networkRequests.duration,
    })
    .from(networkRequests)
    .where(eq(networkRequests.testRunsCaseId, repId));
  if (!rows.length) return { md: null, items: 0 };
  const lines = ['## Network Requests', ''];
  for (const r of rows) lines.push(`- ${r.method} ${r.url} → ${r.status} (${fmtDuration(r.duration)})`);
  return { md: lines.join('\n'), items: rows.length };
}

async function screenshotsMd(db: DrizzleDB, repId: number): Promise<{ md: string | null; count: number }> {
  const rows = await db
    .select({ label: files.label, path: files.path })
    .from(files)
    .where(and(eq(files.testRunsCaseId, repId), eq(files.subtype, 'screenshot')));
  if (!rows.length) return { md: null, count: 0 };
  const lines = ['## Screenshots (attached as images)', ''];
  for (const r of rows) lines.push(`- ${r.label ?? 'screenshot'} (\`${r.path}\`)`);
  return { md: lines.join('\n'), count: rows.length };
}

async function priorDiagnosisMd(db: DrizzleDB, clusterId: number): Promise<string | null> {
  const [d] = await db
    .select()
    .from(failureDiagnoses)
    .where(and(eq(failureDiagnoses.clusterId, clusterId), eq(failureDiagnoses.scope, 'cluster')));
  if (!d || d.status !== 'completed') return null;
  return [
    '## Prior Assessment',
    `- **Previous category:** ${d.category} (${d.confidence} confidence)`,
    `- **Summary:** ${d.summary}`,
  ].join('\n');
}

async function locatorHealingMd(
  db: DrizzleDB,
  repId: number,
): Promise<{ md: string | null; coverage: DiagnosisContextCoverage['locatorHealing'] }> {
  const healing = await getLocatorHealing(db, repId);
  if (!healing) return { md: null, coverage: null };
  const notApplicable = healingNotApplicableMarkdown(healing);
  if (notApplicable) {
    return {
      md: healing.failingLocator ? notApplicable : null,
      coverage: healing.failingLocator ? { source: healing.source, alternativesCount: 0 } : null,
    };
  }
  if (healing.source === 'none') return { md: null, coverage: null };
  const alts = healing.recommendation?.recommended ? [healing.recommendation.recommended] : [];
  const list = healing.fromPriorSuccess ?? healing.fromAriaSnapshot ?? healing.fromElementMatch ?? alts;
  if (!list.length) return { md: null, coverage: null };
  const lines = ['## Alternative Locators (Locator Healing)', `- Source: ${healing.source}`, ''];
  if (healing.priorNameMayBeStale) {
    lines.push("CAUTION: the element's captured name changed — name-based alternatives probably no longer match.", '');
  }
  for (const a of list.slice(0, 5)) lines.push(`- \`${a.locator}\` (stability ${a.score})`);
  if (healing.recommendation?.recommended) {
    lines.push('', `**Recommended fix:** \`${healing.recommendation.recommended.locator}\``);
  }
  return {
    md: lines.join('\n'),
    coverage: { source: healing.source, alternativesCount: list.length },
  };
}

// ── SCM sections (canned) ────────────────────────────────────────────────────

function scmChangesFor(projectId: number, baseCommit: string | null, selectedShas: string[]): ScmChanges | null {
  if (selectedShas.length) return getDemoChangesForShas(projectId, selectedShas);
  // Default baseline: the oldest known commit, so every newer commit (including the
  // suspect) appears as "what changed since the last green run".
  const proj = getDemoScmProject(projectId);
  const fallbackBaseline = baseCommit || proj?.commits[proj.commits.length - 1]?.sha || null;
  return getDemoChangesSince(projectId, fallbackBaseline);
}

function scmInvestigationMd(changes: ScmChanges): string {
  const lines = ['## What Changed (SCM diff since last green)', ''];
  lines.push(`${changes.commits.length} commit(s), ${changes.files.length} file(s) changed:`, '');
  for (const c of changes.commits) lines.push(`- \`${c.sha.slice(0, 7)}\` ${c.message}`);
  lines.push('');
  for (const f of changes.files) {
    lines.push(`### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})`);
    if (f.patch) lines.push('```diff', f.patch, '```');
  }
  return lines.join('\n');
}

function topSuspectedMd(projectId: number, changes: ScmChanges): string | null {
  const proj = getDemoScmProject(projectId);
  const suspectSha = proj?.suspectShas[0];
  if (!suspectSha) return null;
  const commit = proj.commits.find((c) => c.sha === suspectSha);
  const changed = changes.files.map((f) => f.filename);
  if (!commit) return null;
  return [
    '### Top Suspected Change',
    `- \`${commit.sha.slice(0, 7)}\` **${commit.message}** by ${commit.author}`,
    `- Touches: ${commit.files.map((f) => `\`${f.filename}\``).join(', ')}`,
    changed.length ? `- Overlaps the changed files in this diff: ${changed.map((f) => `\`${f}\``).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function sourceFilesMd(projectId: number): { md: string | null; coverage: DiagnosisContextCoverage['sourceFiles'] } {
  const proj = getDemoScmProject(projectId);
  if (!proj?.sourceFiles.length) return { md: null, coverage: null };
  const lines = ['## Source Files (suspect + imports)', ''];
  for (const f of proj.sourceFiles) {
    lines.push(`### \`${f.path}\``, '```', f.content.trimEnd(), '```', '');
  }
  return {
    md: lines.join('\n'),
    coverage: { count: proj.sourceFiles.length, paths: proj.sourceFiles.map((f) => f.path), truncated: false },
  };
}

function testSourceMd(projectId: number, filePath: string | null): string | null {
  const proj = getDemoScmProject(projectId);
  const match = proj?.sourceFiles.find((f) => f.path === filePath) ?? proj?.sourceFiles[0];
  if (!match) return null;
  return `## Test Source Code\n\n\`\`\`ts\n${match.content.trimEnd()}\n\`\`\``;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

interface AssembleResult {
  text: string;
  sections: ContextSection[];
  coverage: DiagnosisContextCoverage;
  scmChanges: ScmChanges | null;
  tokenEstimate: number;
  textTokenEstimate: number;
  imageTokenEstimate: number;
}

const IMAGE_TOKEN_ESTIMATE = 1600;

async function assemble(
  db: DrizzleDB,
  ev: ClusterEvidence,
  opts: { baseCommit: string | null; selectedShas: string[] },
): Promise<AssembleResult> {
  const { cluster, rep } = ev;
  const projectId = cluster.projectId;
  const sections: ContextSection[] = [];
  const push = (s: ContextSection | null) => {
    if (s) sections.push(s);
  };

  let coverage: DiagnosisContextCoverage = { scm: null };

  // Cluster-level
  push(section('clusterSummary', 'Failure Cluster', clusterSummaryMd(ev)));
  push(section('sampleError', 'Sample Raw Error', sampleErrorMd(ev)));
  push(section('affectedTests', 'Affected Tests', affectedTestsMd(ev), ev.affectedTests.length));
  push(section('browserDistribution', 'Browser Distribution', browserDistributionMd(ev)));
  push(section('recurrenceFlakiness', 'Recurrence & Flakiness', recurrenceMd(ev)));

  // Representative execution
  let imageCount = 0;
  if (rep) {
    push(section('representativeExecution', 'Representative Execution', representativeExecutionMd(rep)));
    push(section('executionError', 'Representative Execution Error', executionErrorMd(rep)));
    push(section('failingSteps', 'Failed Steps', failingStepsMd(rep)));
    push(section('steps', 'Test Steps', stepsMd(rep), rep.steps?.length));
    push(section('ariaSnapshot', 'ARIA Snapshot', ariaMd(rep)));
    push(section('console', 'Browser Console Logs', consoleMd(rep)));
    push(section('webVitals', 'Web Vitals', webVitalsMd(rep)));
    push(section('runContext', 'Run Context', runContextMd(rep)));
    push(section('testAnnotations', 'Test Annotations', annotationsMd(rep)));

    const net = await networkMd(db, rep.id);
    push(section('networkRequests', 'Network Requests', net.md, net.items));
    push(section('serverLogs', 'Backend Server Logs', await serverLogsMd(db, rep.id)));

    const shots = await screenshotsMd(db, rep.id);
    push(section('screenshots', 'Screenshots (attached as images)', shots.md, shots.count));
    imageCount = shots.count;

    const heal = await locatorHealingMd(db, rep.id);
    push(section('locatorHealing', 'Alternative Locators (Locator Healing)', heal.md));
    if (heal.coverage) coverage = { ...coverage, locatorHealing: heal.coverage };

    // Environment diff vs last pass — same shared loader + renderer as the server
    const envDiff = await getEnvironmentDiff(db, rep.id);
    const envDiffMd = renderEnvironmentDiffMarkdown(envDiff);
    push(section('environmentDiff', 'Environment Diff vs Last Pass', envDiffMd));
    if (envDiffMd && envDiff.baseline) {
      coverage = {
        ...coverage,
        environmentDiff: {
          changedKeys: (envDiff.entries ?? []).filter((e) => !e.informational).length,
          baselineRunId: envDiff.baseline.runId,
        },
      };
    }

    // App state at test end (+ diff vs last pass) — same shared renderer + baseline loader as the server
    const appStateBaseline =
      rep.testCaseId != null
        ? ((await getLastPassPageState(db, {
            testCaseId: rep.testCaseId,
            browserName: rep.browserName,
          })) as PageStateLike | null)
        : null;
    const appStateMd = renderAppStateMarkdown(rep.pageState, appStateBaseline);
    push(section('appState', 'App State', appStateMd));
    if (appStateMd) coverage = { ...coverage, appState: { hasBaseline: appStateBaseline != null } };

    // Visual diff vs last pass — served from the seed-generated overlay row
    const vdRows = await db
      .select({ metadata: files.metadata })
      .from(files)
      .where(and(eq(files.testRunsCaseId, rep.id), eq(files.type, 'visual-diff')))
      .limit(1);
    const vd = vdRows[0]?.metadata as {
      changedPixels: number;
      changedPixelRatio: number;
      width: number;
      height: number;
      dimensionMismatch: boolean;
      baselineRunId: number;
    } | null;
    if (vd) {
      const pct = (vd.changedPixelRatio * 100).toFixed(2);
      push(
        section(
          'visualDiff',
          'Visual Diff vs Last Pass',
          `## Visual Diff vs Last Pass\nPixel comparison of the failing screenshot against the same test's last passing screenshot (run #${vd.baselineRunId}):\n- Changed pixels: ${vd.changedPixels} of ${vd.width * vd.height} (${pct}%)\n- The diff overlay (red = changed pixels) is attached as image "visual-diff".`,
        ),
      );
      coverage = {
        ...coverage,
        visualDiff: { changedPixelRatio: vd.changedPixelRatio, dimensionMismatch: vd.dimensionMismatch },
      };
    }

    // DOM snapshot from trace — parsed in-browser from the committed demo trace
    const domSnap = (await apiGetDemoDomSnapshot(rep.id)) as {
      status: string;
      html?: string;
      snapshotName?: string;
    };
    if (domSnap.status === 'ok' && domSnap.html) {
      push(
        section(
          'domSnapshot',
          'DOM Snapshot (from Trace)',
          `## DOM Snapshot (failure time, from trace)\nSanitized HTML of the page as Playwright recorded it around the failing action (trace snapshot \`${domSnap.snapshotName}\`) — field values as typed, password fields masked, handlers and script bodies removed; \`data-piwi-target\` marks the element the action targeted:\n\`\`\`html\n${domSnap.html}\n\`\`\``,
        ),
      );
      coverage = {
        ...coverage,
        domSnapshot: { chars: domSnap.html.length, snapshotName: domSnap.snapshotName },
      };
    }

    // Full call stack + network activity, parsed in-browser from the same
    // committed trace via the shared node-free builders/formatters.
    const traceStack = (await apiGetDemoTraceStacks(rep.id)) as TraceCallStackResponse;
    const stackFormatted = formatTraceCallStackSection(traceStack, DEFAULT_CONTEXT_LIMITS.traceStackFrames);
    if (stackFormatted) {
      push(section('traceCallStack', 'Full Call Stack (from Trace)', stackFormatted.markdown));
      coverage = { ...coverage, traceCallStack: stackFormatted.coverage };
    }

    const traceNet = (await apiGetDemoTraceNetwork(rep.id)) as TraceNetworkResponse;
    const netPicked = selectTraceNetworkRequests(
      traceNet,
      DEFAULT_CONTEXT_LIMITS.traceNetworkRequests,
      DEFAULT_CONTEXT_LIMITS.slowRequestMs,
    );
    const netBodyExcerpts: TraceNetworkBodyExcerpt[] = [];
    for (const r of netPicked.filter((p) => p.failed && p.bodySha1).slice(0, 2)) {
      const body = (await apiGetDemoTraceNetworkBody(rep.id, new URLSearchParams({ sha1: r.bodySha1! }))) as {
        status: string;
        content?: string;
      };
      if (body.status === 'ok' && body.content) {
        netBodyExcerpts.push({
          label: `Response body of failed ${r.method} ${r.url} (excerpt)`,
          content: body.content.slice(0, 500),
        });
      }
    }
    const netFormatted = formatTraceNetworkSection(traceNet, netPicked, netBodyExcerpts);
    if (netFormatted) {
      push(section('traceNetwork', 'Network Activity (from Trace)', netFormatted.markdown));
      coverage = { ...coverage, traceNetwork: netFormatted.coverage };
    }
  }

  push(section('priorDiagnosis', 'Prior Assessment', await priorDiagnosisMd(db, cluster.id)));

  // SCM (canned)
  const scmChanges = scmChangesFor(projectId, opts.baseCommit, opts.selectedShas);
  if (scmChanges && scmChanges.files.length) {
    push(section('scmInvestigation', 'SCM Investigation', scmInvestigationMd(scmChanges)));
    push(section('topSuspectedCommit', 'Top Suspected Commit', topSuspectedMd(projectId, scmChanges)));

    const src = sourceFilesMd(projectId);
    push(section('sourceFiles', 'Source Files', src.md));
    if (src.coverage) coverage = { ...coverage, sourceFiles: src.coverage };
    push(section('testSource', 'Test Source Code', testSourceMd(projectId, rep?.filePath ?? null)));

    if (opts.selectedShas.length) {
      push(
        section(
          'selectedCommits',
          'Manually Selected Commits',
          `## Manually Selected Commits\n\n${opts.selectedShas.map((s) => `- \`${s.slice(0, 7)}\``).join('\n')}`,
        ),
      );
    }

    const patchedFiles = scmChanges.files.filter((f) => f.patch).length;
    coverage = {
      ...coverage,
      scm: {
        hasLastGreen: true,
        hasCommitRange: true,
        baseCommitUsed: opts.baseCommit,
        provider: 'github',
        commitsCount: scmChanges.commits.length,
        filesCount: scmChanges.files.length,
        patchedFilesCount: patchedFiles,
        patchesOmitted: false,
        patchesTruncated: false,
        baselineKind: opts.baseCommit ? 'manual' : 'run-green',
      },
    };
  } else {
    coverage = {
      ...coverage,
      scm: {
        hasLastGreen: false,
        hasCommitRange: false,
        baseCommitUsed: opts.baseCommit,
        provider: null,
        commitsCount: 0,
        filesCount: 0,
        patchedFilesCount: 0,
        patchesOmitted: false,
        patchesTruncated: false,
      },
    };
  }

  // Order + coverage block header
  const orderMap = new Map(SECTION_ORDER.map((id, i) => [id, i]));
  sections.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));

  const coverageBlock = buildCoverageBlock(sections);
  const text = [coverageBlock, ...sections.map((s) => s.markdown)].join('\n\n');
  const textChars = sections.reduce((s, sec) => s + sec.chars, 0) + coverageBlock.length;
  const imageTokenEstimate = imageCount * IMAGE_TOKEN_ESTIMATE;

  return {
    text,
    sections,
    coverage,
    scmChanges: scmChanges && scmChanges.files.length ? scmChanges : null,
    tokenEstimate: Math.ceil(textChars / 4) + imageTokenEstimate,
    textTokenEstimate: Math.ceil(textChars / 4),
    imageTokenEstimate,
  };
}

/** "## Data Coverage" present/absent map — mirrors the server block. */
function buildCoverageBlock(sections: ContextSection[]): string {
  const lines = [
    '## Data Coverage',
    'Evidence available for this diagnosis. Absent or truncated sections mean partial information — calibrate confidence accordingly.',
    '',
  ];
  for (const { id, label } of DIAGNOSIS_SECTIONS) {
    const s = sections.find((x) => x.id === id);
    const state = s ? (s.truncated ? 'present (truncated)' : 'present') : 'absent (no data)';
    lines.push(`- [${id}] ${label}: ${state}`);
  }
  return lines.join('\n');
}

// ── Public entry points ──────────────────────────────────────────────────────

function parseScmQuery(query?: URLSearchParams): { baseCommit: string | null; selectedShas: string[] } {
  const baseCommit = query?.get('baseCommit') || null;
  const selectedShas = query?.getAll('selectedCommitShas') ?? [];
  return { baseCommit, selectedShas };
}

/** GET /api/failure-clusters/:id/context */
export async function getClusterContext(db: DrizzleDB, clusterId: number, query?: URLSearchParams) {
  const ev = await collectClusterEvidence(db, clusterId);
  if (!ev) {
    return {
      scope: { kind: 'cluster', clusterId },
      text: '',
      sections: [],
      coverage: { scm: null },
      scmChanges: null,
      tokenEstimate: 0,
      textTokenEstimate: 0,
      imageTokenEstimate: 0,
      cluster: null,
    };
  }
  const { baseCommit, selectedShas } = parseScmQuery(query);
  const effectiveBase = baseCommit || ev.cluster.manualBaseCommit || null;
  const ctx = await assemble(db, ev, { baseCommit: effectiveBase, selectedShas });
  // Same envelope the server's `?format=json` returns: scope descriptor and a
  // compact cluster summary alongside the assembled context.
  return {
    ...ctx,
    scope: { kind: 'cluster', clusterId },
    cluster: {
      id: ev.cluster.id,
      signature: ev.cluster.signature,
      occurrences: ev.cluster.occurrences,
      pattern: 'unknown',
    },
  };
}

/** GET /api/test-run-cases/:id/diagnosis-context — execution scope. */
export async function getExecutionContext(db: DrizzleDB, testRunsCaseId: number, query?: URLSearchParams) {
  const rep = await loadExecutionRep(db, testRunsCaseId);
  if (!rep) {
    return {
      scope: { kind: 'execution', executionId: testRunsCaseId },
      text: '',
      sections: [],
      coverage: { scm: null },
      scmChanges: null,
      tokenEstimate: 0,
      textTokenEstimate: 0,
      imageTokenEstimate: 0,
      cluster: null,
    };
  }
  const [trc] = await db
    .select({ clusterId: testRunsCases.failureClusterId })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, testRunsCaseId));
  // When the execution belongs to a cluster, reuse the full cluster context so the
  // execution view is just as rich; otherwise fall back to a single-execution view.
  if (trc?.clusterId) {
    const ctx = await getClusterContext(db, trc.clusterId, query);
    return { ...ctx, scope: { kind: 'execution', executionId: testRunsCaseId } };
  }
  // No cluster: assemble a minimal execution-only context.
  const sections: ContextSection[] = [];
  const push = (s: ContextSection | null) => {
    if (s) sections.push(s);
  };
  push(section('representativeExecution', 'Representative Execution', representativeExecutionMd(rep)));
  push(section('executionError', 'Representative Execution Error', executionErrorMd(rep)));
  push(section('steps', 'Test Steps', stepsMd(rep), rep.steps?.length));
  push(section('console', 'Browser Console Logs', consoleMd(rep)));
  push(section('webVitals', 'Web Vitals', webVitalsMd(rep)));
  const coverageBlock = buildCoverageBlock(sections);
  const text = [coverageBlock, ...sections.map((s) => s.markdown)].join('\n\n');
  const textChars = sections.reduce((s, sec) => s + sec.chars, 0) + coverageBlock.length;
  return {
    scope: { kind: 'execution', executionId: testRunsCaseId },
    text,
    sections,
    coverage: { scm: null } as DiagnosisContextCoverage,
    scmChanges: null,
    tokenEstimate: Math.ceil(textChars / 4),
    textTokenEstimate: Math.ceil(textChars / 4),
    imageTokenEstimate: 0,
    cluster: null,
  };
}

// ── Prompt preview ──────────────────────────────────────────────────────────
// `?format=prompt` returns the exact request payload as plain text. The demo
// reads the same stored instructions the server does, so the preview it shows
// is the one its own canned diagnosis would use.

/** Resolve the project a cluster or execution belongs to. */
async function resolveProjectId(db: DrizzleDB, opts: { clusterId?: number; testRunsCaseId?: number }) {
  if (opts.clusterId != null) {
    const [row] = await db
      .select({ projectId: failureClusters.projectId })
      .from(failureClusters)
      .where(eq(failureClusters.id, opts.clusterId));
    return row?.projectId ?? null;
  }
  const [row] = await db
    .select({ projectId: testRuns.projectId })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(eq(testRunsCases.id, opts.testRunsCaseId!));
  return row?.projectId ?? null;
}

async function promptResponse(db: DrizzleDB, contextText: string, projectId: number | null): Promise<Response> {
  const globalRow = await getAppSetting<{ value?: string }>(db, 'ai_instructions');
  let projectInstructions: string | null = null;
  if (projectId != null) {
    const [row] = await db
      .select({ diagnosisInstructions: projects.diagnosisInstructions })
      .from(projects)
      .where(eq(projects.id, projectId));
    projectInstructions = row?.diagnosisInstructions?.trim() || null;
  }

  const text = buildPromptPreview({
    system: buildDiagnosisSystemPrompt({
      globalInstructions: globalRow?.value?.trim() || null,
      projectInstructions,
    }),
    user: contextText,
    jsonSchema: DIAGNOSIS_JSON_SCHEMA,
  });

  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** GET /api/failure-clusters/:id/context?format=prompt */
export async function getClusterContextPrompt(db: DrizzleDB, clusterId: number, query?: URLSearchParams) {
  const ctx = (await getClusterContext(db, clusterId, query)) as { text?: string };
  return promptResponse(db, ctx.text ?? '', await resolveProjectId(db, { clusterId }));
}

/** GET /api/test-run-cases/:id/diagnosis-context?format=prompt */
export async function getExecutionContextPrompt(db: DrizzleDB, testRunsCaseId: number, query?: URLSearchParams) {
  const ctx = (await getExecutionContext(db, testRunsCaseId, query)) as { text?: string };
  return promptResponse(db, ctx.text ?? '', await resolveProjectId(db, { testRunsCaseId }));
}
