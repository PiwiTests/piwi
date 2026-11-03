/**
 * Gather what Piwi knows about a failure and hand it to the pure issue builder.
 *
 * The reading order and the section-by-section degradation live in
 * `#shared/integrations/build-issue`; this file only reads the database — the
 * cluster, its latest occurrence, the diagnosis and the fix plan — so a field
 * added to the fix plan reaches the ticket without a second edit. The fix plan's
 * own logic (patch, locator edits, verify command, reproduce recipe) is reused,
 * never duplicated.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { testRuns, testRunsCases } from '../../database/schema';
import { notLabRun } from '#shared/run-eligibility';
import { clusterKnownIssues } from '#shared/handlers/known-issues';
import type { AutomaticFiling } from '#shared/integrations/automation';
import { buildFixPlan } from '../fix-plan';
import { getFailureCluster } from '#shared/handlers/failure-clusters';
import { describeCluster } from '#shared/describe-cluster';
import { caseHeadline } from '#shared/failure-verdict';
import { errorExcerpt } from '#shared/notification-events';
import { clusterClue } from '#shared/inbox-queues';
import { reproScript } from '#shared/reproduce';
import { getBugReport, getBugReportMissedBy, renderBugReportSpec } from '#shared/handlers/bug-reports';
import {
  buildBugIssue,
  type BugIssueFacts,
  buildIssue,
  type AffectedTestFact,
  type BuiltIssue,
  type IssueBuildOpts,
  type IssueFacts,
  type LocatorEditFact,
  type RelatedIssueFact,
} from '#shared/integrations/build-issue';
import { DEFAULT_LOCALE, formatDate } from '#shared/integrations/messages';
import type { DrizzleDB } from '#shared/handlers/db';

function scmCommit(metadata: unknown): string | null {
  const scm = (metadata as { scm?: { commit?: string | null } } | null)?.scm;
  return scm?.commit ?? null;
}

function site(opts: IssueBuildOpts): string | null {
  const raw = opts.siteUrl?.trim();
  return raw ? raw.replace(/\/$/, '') : null;
}

/** A cluster/execution/run link on the configured site, or null when unset. */
function link(base: string | null, path: string): string | null {
  return base ? `${base}${path}` : null;
}

/**
 * The share token a cluster's body carries, or null when share links are off:
 * the server's stands in for the link created when the issue is sent
 * (`server/utils/integrations/share-url`); the demo passes none, so this
 * module never imports `node:crypto` into the worker bundle.
 */
export type ShareTokenMinter = (projectId: number, clusterId: number) => Promise<string | null>;

/** The builder options: the pure `IssueBuildOpts` plus the server-side minter. */
export interface DocumentBuildOpts extends IssueBuildOpts {
  mintShareToken?: ShareTokenMinter | null;
  /** The share link the issue already carries, its token redacted: a rebuilt body reuses it. */
  shareUrl?: string | null;
  /** Set when a rule files the issue: the body opens with what it counted. */
  automatic?: AutomaticFiling | null;
}

/** The cluster's share URL when the toggle is on: the one given, else one on the minter's token. */
async function resolveShareUrl(projectId: number, clusterId: number, opts: DocumentBuildOpts): Promise<string | null> {
  if (!opts.includeShareLink) return null;
  if (opts.shareUrl !== undefined) return opts.shareUrl;
  if (!opts.mintShareToken) return null;
  const base = site(opts);
  if (!base) return null;
  const token = await opts.mintShareToken(projectId, clusterId);
  return token ? `${base}/share/${token}` : null;
}

interface GatheredFacts {
  facts: IssueFacts;
  projectId: number;
  fingerprint: string;
}

/**
 * Read the cluster's facts, pinning the evidence and the execution link to a
 * chosen occurrence (the caller's execution, or the cluster's latest).
 */
async function gatherClusterFacts(
  db: DrizzleDB,
  clusterId: number,
  occurrenceExecutionId: number | null,
  opts: DocumentBuildOpts,
): Promise<GatheredFacts | null> {
  const cluster = await getFailureCluster(db, clusterId);
  if (!cluster) return null;

  const executionId = occurrenceExecutionId ?? cluster.latestTestRunsCaseId ?? null;

  const [occurrence] = executionId
    ? await db
        .select({
          error: testRunsCases.error,
          steps: testRunsCases.steps,
          runId: testRunsCases.testRunId,
        })
        .from(testRunsCases)
        .where(eq(testRunsCases.id, executionId))
    : [];

  const runId = occurrence?.runId ?? cluster.lastSeenRunId ?? null;
  const [run] = runId
    ? await db
        .select({ branch: testRuns.branch, environment: testRuns.environment, metadata: testRuns.metadata })
        .from(testRuns)
        .where(eq(testRuns.id, runId))
    : [];

  const locale = opts.locale ?? DEFAULT_LOCALE;
  const headlineDesc = occurrence?.error ? caseHeadline({ error: occurrence.error, steps: occurrence.steps }) : null;
  const commit = scmCommit(run?.metadata ?? null);

  const affectedTests: AffectedTestFact[] = cluster.affectedTestCases.slice(0, 25).map((t) => ({
    title: t.title,
    filePath: t.filePath,
    owner: t.owner ?? cluster.owner?.name ?? null,
    failures: t.runCount,
  }));
  const reach = await clusterReach(db, clusterId);

  const plan = await buildFixPlan(db, clusterId);
  const patch = opts.includePatch === false ? null : (plan?.diagnosis?.patch ?? null);
  const locatorEdits: LocatorEditFact[] = (plan?.edits ?? [])
    .filter((e) => e.suggestedLocator)
    .map((e) => ({
      filePath: e.filePath,
      line: e.line,
      failingLocator: e.failingLocator,
      suggestedLocator: e.suggestedLocator,
    }));
  const reproduceScript = plan && plan.reproduce.steps.length ? reproScript(plan.reproduce, 'bash') : null;

  const diagnosisSummary = opts.includeDiagnosis === false ? null : (cluster.diagnosis?.summary ?? null);
  const rootCause = opts.includeDiagnosis === false ? null : (plan?.diagnosis?.rootCause ?? null);
  const clue =
    clusterClue({
      errorType: cluster.errorType,
      selector: cluster.selector,
      fixVerification: cluster.fixVerification,
    })?.text ?? null;

  const base = site(opts);
  const shareUrl = await resolveShareUrl(cluster.projectId, clusterId, opts);
  const ownKeys = new Set(cluster.links.map((l) => l.key).filter((key): key is string => !!key));
  const relatedIssues = await relatedTrackerIssues(db, plan?.fixedBefore ?? [], ownKeys);

  const facts: IssueFacts = {
    clusterId,
    fingerprint: cluster.fingerprint,
    title: describeCluster(cluster),
    headline: headlineDesc?.headline ?? null,
    errorType: cluster.errorType ?? null,
    firstSeen: formatDate(locale, cluster.firstSeenAt),
    lastSeen: formatDate(locale, cluster.lastSeenAt),
    occurrences: cluster.occurrences ?? 0,
    runs: reach.runs || null,
    affectedTests,
    moreAffectedTests: Math.max(0, (cluster.affectedTests ?? 0) - affectedTests.length),
    branch: run?.branch ?? null,
    environment: run?.environment ?? null,
    branches: reach.branches,
    environments: reach.environments,
    commit: commit ? commit.slice(0, 12) : null,
    diagnosisSummary,
    rootCause,
    diagnosisCategory: diagnosisSummary || rootCause ? (cluster.diagnosis?.category ?? null) : null,
    diagnosisConfidence: diagnosisSummary || rootCause ? (cluster.diagnosis?.confidence ?? null) : null,
    clue,
    errorExcerpt: errorExcerpt(occurrence?.error ?? cluster.sampleError ?? null) ?? null,
    failingLocator: cluster.selector ?? null,
    patch,
    locatorEdits,
    verifyCommand: plan?.verify.command ?? null,
    reproduceScript,
    relatedIssues,
    automatic: opts.automatic ?? null,
    clusterUrl: link(base, `/failure-clusters/${clusterId}`),
    executionUrl: executionId ? link(base, `/test-run-cases/${executionId}`) : null,
    runUrl: runId ? link(base, `/test-runs/${runId}`) : null,
    shareUrl,
  };

  return { facts, projectId: cluster.projectId, fingerprint: cluster.fingerprint };
}

/**
 * Where a cluster failed: the distinct runs, and the distinct branches and
 * environments of those runs, newest first. Lab runs are left out.
 */
async function clusterReach(
  db: DrizzleDB,
  clusterId: number,
): Promise<{ runs: number; branches: string[]; environments: string[] }> {
  const failing = and(eq(testRunsCases.failureClusterId, clusterId), notLabRun(testRuns.origin));
  const [[count], places] = await Promise.all([
    db
      .select({ runs: sql<number>`count(distinct ${testRunsCases.testRunId})` })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .where(failing),
    db
      .select({
        branch: testRuns.branch,
        environment: testRuns.environment,
        lastRunId: sql<number>`max(${testRuns.id})`,
      })
      .from(testRunsCases)
      .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
      .where(failing)
      .groupBy(testRuns.branch, testRuns.environment)
      .orderBy(desc(sql`max(${testRuns.id})`))
      .limit(20),
  ]);
  const distinct = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => !!v))];
  return {
    runs: Number(count?.runs ?? 0),
    branches: distinct(places.map((p) => p.branch)),
    environments: distinct(places.map((p) => p.environment)),
  };
}

/** The tracker issues of the clusters a fix plan found fixed before, other than the cluster's own. */
async function relatedTrackerIssues(
  db: DrizzleDB,
  fixedBefore: Array<{ clusterId: number; title: string }>,
  ownKeys: Set<string>,
): Promise<RelatedIssueFact[]> {
  if (fixedBefore.length === 0) return [];
  const known = await clusterKnownIssues(
    db,
    fixedBefore.map((m) => m.clusterId),
  ).catch(() => new Map());
  const related: RelatedIssueFact[] = [];
  for (const match of fixedBefore) {
    const issue = known.get(match.clusterId);
    if (!issue || ownKeys.has(issue.key) || related.some((r) => r.key === issue.key)) continue;
    related.push({ key: issue.key, url: issue.url, title: match.title, status: issue.status });
  }
  return related.slice(0, 3);
}

export interface BuiltClusterIssue extends BuiltIssue {
  projectId: number;
  /** The share link the body carries, when it carries one, on the minter's token. */
  shareUrl: string | null;
}

/** Build the default cluster ticket. Returns null when the cluster is gone. */
export async function buildClusterIssue(
  db: DrizzleDB,
  clusterId: number,
  opts: DocumentBuildOpts = {},
): Promise<BuiltClusterIssue | null> {
  const gathered = await gatherClusterFacts(db, clusterId, null, opts);
  if (!gathered) return null;
  return { ...buildIssue(gathered.facts, opts), projectId: gathered.projectId, shareUrl: gathered.facts.shareUrl };
}

/**
 * Build a ticket for one failing execution — the same body scoped to that
 * execution and its cluster. Returns null when the execution or its cluster is
 * gone (an execution never spawns a second ticket for a known cluster).
 */
export async function buildExecutionIssue(
  db: DrizzleDB,
  executionId: number,
  opts: DocumentBuildOpts = {},
): Promise<BuiltClusterIssue | null> {
  const [execution] = await db
    .select({
      failureClusterId: testRunsCases.failureClusterId,
    })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, executionId));
  if (!execution?.failureClusterId) return null;

  // The cluster's own name titles the ticket, as on the cluster page, so the
  // title is the same from either entry point.
  const gathered = await gatherClusterFacts(db, execution.failureClusterId, executionId, opts);
  if (!gathered) return null;
  return { ...buildIssue(gathered.facts, opts), projectId: gathered.projectId, shareUrl: gathered.facts.shareUrl };
}

/**
 * Build the ticket for a bug report sent from Piwi Picker: the steps written
 * again in the ticket's language, the evidence, the failing test to commit,
 * the reproductions and a link to the report. Null when the report is gone.
 */
export async function buildBugReportIssue(
  db: DrizzleDB,
  bugReportId: number,
  opts: DocumentBuildOpts = {},
): Promise<BuiltClusterIssue | null> {
  const report = await getBugReport(db, bugReportId);
  if (!report) return null;
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const spec = await renderBugReportSpec(db, bugReportId, 'commit').catch(() => null);
  const base = site(opts);
  const facts: BugIssueFacts = {
    id: report.id,
    title: report.title,
    steps: report.steps,
    evidence: report.evidence,
    context: report.context,
    reportLanguage: report.language,
    reportedBy: report.reportedBy,
    reportedAt: formatDate(locale, report.createdAt),
    spec: spec ? { path: spec.path, code: spec.code } : null,
    reproductions: report.reproductionList.map((r) => ({
      verdict: r.verdict,
      divergedAt: r.divergedAt,
      origin: r.origin,
      source: r.source,
    })),
    missedBy: await getBugReportMissedBy(db, bugReportId)
      .then((m) => (m?.pagesKnown ? { summary: m.summary, tests: m.visiting } : null))
      .catch(() => null),
    reportUrl: link(base, `/bug-reports/${report.id}`),
  };
  return { ...buildBugIssue(facts, { locale }), projectId: report.projectId, shareUrl: null };
}
