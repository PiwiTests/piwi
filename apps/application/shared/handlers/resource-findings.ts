import { and, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  projects,
  resourceFindings,
  resourceOccurrences,
  testCases,
  testRuns,
  testRunsCases,
} from '../../server/database/schema';
import type { GateFacts } from '@piwitests/core/gate';
import type { DrizzleDB } from './db';
import { isPassiveCapabilityDeclined } from './capabilities';
import { readProjectDefaultBranch, resolveFallbackBranch } from './baseline-scope';
import { resolveRunBranch } from '../../server/utils/run-branch';
import { getAppSetting, setAppSetting } from '../../server/utils/app-settings';
import { readResourceReport } from './resource-reports';
import { testOutcomes } from '#shared/utils/test-counts';
import { REPORT_FINDINGS_CAP } from '#shared/resource-report';
import {
  identityFile,
  isLeak,
  openingLine,
  RESOURCE_IDENTITY_VERSION,
  resourceFingerprint,
  resourceGroup,
} from '#shared/resource-fingerprint.mjs';
import type { WireResourceFinding, WireResourceReport } from '#shared/types';

/**
 * A project's resource findings across runs, the way failure clusters are kept:
 * each finding has an identity (`#shared/resource-fingerprint.mjs`: where it
 * was opened, line included), the runs it showed in, and a fix. Every run that
 * shows a finding records that it did. Only a run that vouches for the default
 * branch, a full run of it, changes the finding: its line, its clean runs and
 * its status. Five such runs without it, each able to have shown it, record it
 * fixed from the first of them; such a run that shows it reopens it.
 * A finding is new to a branch when no earlier run of the branch the run
 * compares with (the pull request's target, else the default branch) showed
 * it, which is what the gate's `maxNewLeaks` and the pull-request comment
 * read. A finding that shows under a new identity, where an open finding of
 * the same group that branch showed no longer shows, has moved with an edit
 * above its line: it joins that finding and is not new.
 */

/** Full default-branch runs without a finding that record it fixed. */
export const FIXED_AFTER_CLEAN_RUNS = 5;

/** One finding of a run, its shards folded together. */
export interface RunFinding {
  fingerprint: string;
  finding: WireResourceFinding;
}

type FindingRow = typeof resourceFindings.$inferSelect;

/** The findings of a run's report, one per identity, its shards folded together. */
export function runFindings(parts: WireResourceReport[]): RunFinding[] {
  const byFingerprint = new Map<string, WireResourceFinding>();
  for (const part of parts) {
    for (const finding of part.findings) {
      const key = resourceFingerprint(finding);
      const seen = byFingerprint.get(key);
      if (!seen) {
        byFingerprint.set(key, { ...finding });
        continue;
      }
      seen.count += finding.count;
      seen.tests += finding.tests;
      if (finding.heldMs != null) seen.heldMs = Math.max(seen.heldMs ?? 0, finding.heldMs);
      if (finding.pages) seen.pages = (seen.pages ?? 0) + finding.pages;
      if (finding.afterTestCpuMs) seen.afterTestCpuMs = (seen.afterTestCpuMs ?? 0) + finding.afterTestCpuMs;
      if (finding.untilWorkerEnd) seen.untilWorkerEnd = true;
    }
  }
  return [...byFingerprint].map(([fingerprint, finding]) => ({ fingerprint, finding }));
}

/** The capture fixtures counted the run's objects, so its report could show any finding but a probable one. */
function ledgerRan(parts: WireResourceReport[]): boolean {
  return parts.some(
    (part) =>
      part.workerHealth !== null || part.workers.length > 0 || part.findings.some((f) => f.verdict !== 'probable'),
  );
}

/**
 * The verdicts a run's report was cut short of: a part that holds as many
 * findings as the dashboard keeps, and counts more of a verdict than it holds.
 */
function cutVerdicts(parts: WireResourceReport[]): Set<string> {
  const cut = new Set<string>();
  for (const part of parts) {
    if (part.findings.length < REPORT_FINDINGS_CAP) continue;
    const held: Record<string, number> = {};
    for (const finding of part.findings) {
      held[finding.verdict] = (held[finding.verdict] ?? 0) + (finding.verdict === 'idle' ? finding.count : 1);
    }
    for (const [verdict, count] of Object.entries(part.counts)) if (count > (held[verdict] ?? 0)) cut.add(verdict);
  }
  return cut;
}

/** Whether two paths name the same file, either one relative to a folder above the other's. */
function sameFile(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

interface RunFacts {
  id: number;
  projectId: number;
  startTime: Date;
  parts: WireResourceReport[];
  branch: string | null;
  metadata: unknown;
  isFullRun: boolean;
}

async function readRun(db: DrizzleDB, runId: number): Promise<RunFacts | null> {
  const [run] = await db
    .select({
      id: testRuns.id,
      projectId: testRuns.projectId,
      startTime: testRuns.startTime,
      branch: testRuns.branch,
      metadata: testRuns.metadata,
      isFullRun: testRuns.isFullRun,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) return null;
  return {
    id: run.id,
    projectId: run.projectId,
    startTime: run.startTime,
    parts: (await readResourceReport(db, run.id)).parts,
    branch: run.branch ?? resolveRunBranch(run.metadata),
    metadata: run.metadata,
    isFullRun: run.isFullRun === 1,
  };
}

/** The showings of runs of a branch; a run with no branch counts as a run of the default branch. */
function shownOnBranch(branch: string, isDefault: boolean): SQL {
  return isDefault
    ? or(eq(resourceOccurrences.branch, branch), isNull(resourceOccurrences.branch))!
    : eq(resourceOccurrences.branch, branch);
}

/**
 * The open findings a run's unknown identities may have moved from: those a
 * run of the branch (`onBranch`) that started before this one showed, and
 * this run does not show (`shown`).
 */
async function moveCandidates(
  db: DrizzleDB,
  run: Pick<RunFacts, 'id' | 'projectId' | 'startTime'>,
  onBranch: SQL,
  shown: Set<string>,
): Promise<FindingRow[]> {
  const shownBefore = db
    .select({ findingId: resourceOccurrences.findingId })
    .from(resourceOccurrences)
    .innerJoin(testRuns, eq(testRuns.id, resourceOccurrences.runId))
    .where(
      and(
        eq(testRuns.projectId, run.projectId),
        ne(resourceOccurrences.runId, run.id),
        lt(testRuns.startTime, run.startTime),
        onBranch,
      ),
    );
  const rows = await db
    .select()
    .from(resourceFindings)
    .where(
      and(
        eq(resourceFindings.projectId, run.projectId),
        eq(resourceFindings.status, 'open'),
        inArray(resourceFindings.id, shownBefore),
      ),
    );
  return rows.filter((row) => !shown.has(row.fingerprint));
}

export interface RecordedFindings {
  /** Findings this run showed. */
  seen: number;
  /** Findings this run made fixed: the fifth clean run since each last showed. */
  fixed: number[];
  /** Findings that were fixed and showed again in this run. */
  reopened: number[];
}

/**
 * Record a finished run's findings in its project's history, and count it as a
 * clean run for the open findings it did not show, in one transaction. Safe to
 * call again for the same run: each showing is recorded once, its numbers
 * replaced, and the run counts as clean for a finding once.
 */
export async function recordRunResourceFindings(db: DrizzleDB, runId: number): Promise<RecordedFindings> {
  const none: RecordedFindings = { seen: 0, fixed: [], reopened: [] };
  const run = await readRun(db, runId);
  if (!run || run.parts.length === 0) return none;
  if (await isPassiveCapabilityDeclined(db, run.projectId, 'resources')) return none;
  const defaultBranch = await readProjectDefaultBranch(db, run.projectId, run.metadata);
  // A run with no branch counts as a run of the default branch.
  const vouches = run.isFullRun && (!run.branch || run.branch === defaultBranch);
  const found = runFindings(run.parts);
  return db.transaction(async (tx) => {
    // Hold the project's row until the transaction ends: the runs of a project record one after the other, each
    // reading what the one before wrote.
    await tx
      .update(projects)
      .set({ name: sql`${projects.name}` })
      .where(eq(projects.id, run.projectId));
    return recordFindings(tx, run, found, defaultBranch, vouches);
  });
}

async function recordFindings(
  db: DrizzleDB,
  run: RunFacts,
  found: RunFinding[],
  defaultBranch: string,
  vouches: boolean,
): Promise<RecordedFindings> {
  const fingerprints = new Set(found.map((f) => f.fingerprint));
  const existing = fingerprints.size
    ? await db
        .select()
        .from(resourceFindings)
        .where(
          and(eq(resourceFindings.projectId, run.projectId), inArray(resourceFindings.fingerprint, [...fingerprints])),
        )
    : [];
  const byFingerprint = new Map(existing.map((row) => [row.fingerprint, row]));
  // A finding the run shows under an identity it never had may be an open one
  // of the default branch the run no longer shows, moved by an edit above its
  // line: the run's showing joins that finding.
  const unmatched = found.filter((f) => !byFingerprint.has(f.fingerprint));
  const moved = unmatched.length
    ? pairMoved(unmatched, await moveCandidates(db, run, shownOnBranch(defaultBranch, true), fingerprints))
    : new Map<RunFinding, FindingRow>();

  const now = new Date();
  const reopened: number[] = [];
  const seenIds = new Set<number>();
  for (const item of found) {
    const { fingerprint, finding } = item;
    const known = byFingerprint.get(fingerprint) ?? moved.get(item);
    const { row, inserted } = known ? { row: known, inserted: false } : await insertFinding(db, run, item, now);
    seenIds.add(row.id);
    const values = {
      branch: run.branch,
      count: finding.count,
      tests: finding.tests,
      heldMs: finding.heldMs ?? null,
      afterTestCpuMs: finding.afterTestCpuMs ?? null,
      pages: finding.pages ?? null,
    };
    const [occurrence] = await db
      .insert(resourceOccurrences)
      .values({ findingId: row.id, runId: run.id, ...values })
      .onConflictDoNothing({ target: [resourceOccurrences.findingId, resourceOccurrences.runId] })
      .returning({ id: resourceOccurrences.id });
    if (!occurrence) {
      // A retried finish: the showing was recorded, its numbers are replaced.
      await db
        .update(resourceOccurrences)
        .set(values)
        .where(and(eq(resourceOccurrences.findingId, row.id), eq(resourceOccurrences.runId, run.id)));
      continue;
    }
    if (inserted) continue;
    // The latest showing of a run that vouches places the finding and starts its clean runs again. A fixed
    // finding it shows is back after its fix when the default branch showed it before; else it reaches the
    // default branch now, from a branch that showed it first.
    const latest = vouches && run.startTime >= row.lastSeenAt;
    const shownAgain = latest && row.status === 'fixed';
    const comesBack = shownAgain && (await shownOnDefaultBefore(db, row.id, run.id, defaultBranch));
    if (comesBack) reopened.push(row.id);
    await db
      .update(resourceFindings)
      .set({
        occurrences: sql`${resourceFindings.occurrences} + 1`,
        ...(run.startTime < row.firstSeenAt && { firstSeenRunId: run.id, firstSeenAt: run.startTime }),
        ...(latest && {
          fingerprint,
          place: finding.where,
          site: finding.site ?? null,
          lastSeenRunId: run.id,
          lastSeenAt: run.startTime,
          cleanRuns: 0,
          fixedRunId: null,
        }),
        ...(shownAgain && { status: 'open', fixedAt: null }),
        ...(comesBack && { reopenedRunId: run.id }),
        updatedAt: now,
      })
      .where(eq(resourceFindings.id, row.id));
  }

  const fixed = vouches ? await countCleanRun(db, run, seenIds, now) : [];
  return { seen: seenIds.size, fixed, reopened };
}

/** Whether a run of the default branch other than `runId` showed the finding. */
async function shownOnDefaultBefore(
  db: DrizzleDB,
  findingId: number,
  runId: number,
  defaultBranch: string,
): Promise<boolean> {
  const [shown] = await db
    .select({ id: resourceOccurrences.id })
    .from(resourceOccurrences)
    .where(
      and(
        eq(resourceOccurrences.findingId, findingId),
        ne(resourceOccurrences.runId, runId),
        shownOnBranch(defaultBranch, true),
      ),
    )
    .limit(1);
  return shown !== undefined;
}

/**
 * Insert a finding the run is the first to show. When another run recorded
 * the same identity meanwhile, return that one: this run's showing joins it.
 */
async function insertFinding(
  db: DrizzleDB,
  run: RunFacts,
  { fingerprint, finding }: RunFinding,
  now: Date,
): Promise<{ row: FindingRow; inserted: boolean }> {
  const [inserted] = await db
    .insert(resourceFindings)
    .values({
      projectId: run.projectId,
      fingerprint,
      verdict: finding.verdict,
      kind: finding.kind,
      place: finding.where,
      site: finding.site ?? null,
      firstSeenRunId: run.id,
      lastSeenRunId: run.id,
      firstSeenAt: run.startTime,
      lastSeenAt: run.startTime,
      occurrences: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [resourceFindings.projectId, resourceFindings.fingerprint] })
    .returning();
  if (inserted) return { row: inserted, inserted: true };
  const [row] = await db
    .select()
    .from(resourceFindings)
    .where(and(eq(resourceFindings.projectId, run.projectId), eq(resourceFindings.fingerprint, fingerprint)));
  return { row: row!, inserted: false };
}

/**
 * Which findings a run's report could have shown, so that it not showing one
 * says the finding is gone: the capture fixtures ran (a probable finding needs
 * only the steps), the report kept every finding of its verdict, and every
 * test that could have left it open passed or was skipped, since what a test
 * that failed, was interrupted or did not run left open is never judged. With
 * such a test in the run, that holds only for a finding whose identity names a
 * spec file of the run with a test that passed and none of those others: a
 * fixture's or a helper's finding, or one that names no file, may be that
 * test's. With `inOwnFile`, that holds for every finding, whatever the other
 * tests of the run did.
 */
async function reportReach(
  db: DrizzleDB,
  run: RunFacts,
  { inOwnFile = false }: { inOwnFile?: boolean } = {},
): Promise<(row: Pick<FindingRow, 'verdict' | 'fingerprint'>) => boolean> {
  const withLedger = ledgerRan(run.parts);
  const cut = cutVerdicts(run.parts);
  const outcomes = testOutcomes(
    await db
      .select({
        testCaseId: testRunsCases.testCaseId,
        browserName: testRunsCases.browserName,
        repeatEachIndex: testRunsCases.repeatEachIndex,
        retries: testRunsCases.retries,
        status: testRunsCases.status,
        filePath: testCases.filePath,
      })
      .from(testRunsCases)
      .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
      .where(eq(testRunsCases.testRunId, run.id)),
  );
  const unjudged = new Set(
    outcomes.filter((o) => o.status !== 'passed' && o.status !== 'skipped').map((o) => o.filePath),
  );
  const passed = new Set(outcomes.filter((o) => o.status === 'passed').map((o) => o.filePath));
  return (row) => {
    if (row.verdict !== 'probable' && !withLedger) return false;
    if (cut.has(row.verdict)) return false;
    if (unjudged.size === 0 && !inOwnFile) return true;
    const file = identityFile(row.fingerprint);
    if (!file) return false;
    const specs = [...new Set([...passed, ...unjudged])].filter((spec) => sameFile(spec, file));
    return specs.some((spec) => passed.has(spec)) && specs.every((spec) => !unjudged.has(spec));
  };
}

/**
 * Count a run that vouches for the default branch as clean for each open
 * finding of its project it did not show, when its report could have shown
 * that finding (`reportReach`) and it started after the finding last showed.
 */
async function countCleanRun(db: DrizzleDB, run: RunFacts, seenIds: Set<number>, now: Date): Promise<number[]> {
  const open = await db
    .select()
    .from(resourceFindings)
    .where(
      and(
        eq(resourceFindings.projectId, run.projectId),
        eq(resourceFindings.status, 'open'),
        lt(resourceFindings.lastSeenAt, run.startTime),
      ),
    );
  const unseen = open.filter((row) => !seenIds.has(row.id) && row.lastCheckedRunId !== run.id);
  if (unseen.length === 0) return [];
  const couldShow = await reportReach(db, run);
  const fixed: number[] = [];
  for (const row of unseen) {
    if (!couldShow(row)) continue;
    const cleanRuns = row.cleanRuns + 1;
    const firstClean = row.fixedRunId ?? run.id;
    const isFixed = cleanRuns >= FIXED_AFTER_CLEAN_RUNS;
    if (isFixed) fixed.push(row.id);
    await db
      .update(resourceFindings)
      .set({
        cleanRuns,
        lastCheckedRunId: run.id,
        fixedRunId: firstClean,
        ...(isFixed && { status: 'fixed', fixedAt: now }),
        updatedAt: now,
      })
      .where(eq(resourceFindings.id, row.id));
  }
  return fixed;
}

/** A run's finding, and whether the branch it compares with had shown it before. */
export interface RunFindingNovelty extends RunFinding {
  isNew: boolean;
  /** The identity the project's history keeps it under: its own, or that of the open finding it moved from. */
  historyFingerprint: string;
}

export interface RunFindingsNovelty {
  /** The branch the run compares with: the pull request's target, else the default branch. */
  baseBranch: string;
  findings: RunFindingNovelty[];
}

/**
 * The run's findings, each new when no run of the base branch that started
 * before it showed it. Reads the run's own report and the history of earlier runs only, so it
 * holds before the run's own findings are recorded. Null when the run sent no
 * report.
 */
export async function runFindingsNovelty(db: DrizzleDB, runId: number): Promise<RunFindingsNovelty | null> {
  const run = await readRun(db, runId);
  if (!run || run.parts.length === 0) return null;
  const defaultBranch = await readProjectDefaultBranch(db, run.projectId, run.metadata);
  const baseBranch = resolveFallbackBranch(run.metadata, defaultBranch).branch;
  const found = runFindings(run.parts);
  if (found.length === 0) return { baseBranch, findings: [] };

  const onBase = shownOnBranch(baseBranch, baseBranch === defaultBranch);
  const seenBefore = new Set(
    (
      await db
        .selectDistinct({ fingerprint: resourceFindings.fingerprint })
        .from(resourceOccurrences)
        .innerJoin(resourceFindings, eq(resourceFindings.id, resourceOccurrences.findingId))
        .innerJoin(testRuns, eq(testRuns.id, resourceOccurrences.runId))
        .where(
          and(
            eq(resourceFindings.projectId, run.projectId),
            inArray(
              resourceFindings.fingerprint,
              found.map((f) => f.fingerprint),
            ),
            ne(resourceOccurrences.runId, run.id),
            lt(testRuns.startTime, run.startTime),
            onBase,
          ),
        )
    ).map((row) => row.fingerprint),
  );
  // A finding the base branch never showed under this identity may have moved
  // there: an open finding of its group, shown on the base branch before this
  // run, that this run no longer shows.
  const unseen = found.filter((f) => !seenBefore.has(f.fingerprint));
  const moved = unseen.length
    ? pairMoved(unseen, await moveCandidates(db, run, onBase, new Set(found.map((f) => f.fingerprint))))
    : new Map<RunFinding, FindingRow>();
  return {
    baseBranch,
    findings: found.map((f) => ({
      ...f,
      isNew: !seenBefore.has(f.fingerprint) && !moved.has(f),
      historyFingerprint: moved.get(f)?.fingerprint ?? f.fingerprint,
    })),
  };
}

/**
 * The open leaks and Node handles of the default branch that a full run of a
 * pull request into it no longer shows: each one a full default-branch run
 * showed before this run, with no clean run since, whose spec file has a test
 * that passed in this run and none that failed (`reportReach`, `inOwnFile`),
 * and that this run showed under no identity, its own nor a moved one. A
 * fixture's or a helper's finding, whose identity names no spec file of the
 * run, is never one. Empty for a run that names no pull request's target, a
 * partial run, or one that sent no report.
 */
export async function runClosedFindings(
  db: DrizzleDB,
  runId: number,
  novelty: RunFindingsNovelty,
): Promise<WireResourceFinding[]> {
  const run = await readRun(db, runId);
  if (!run || run.parts.length === 0 || !run.isFullRun) return [];
  const defaultBranch = await readProjectDefaultBranch(db, run.projectId, run.metadata);
  const base = resolveFallbackBranch(run.metadata, defaultBranch);
  if (base.source !== 'pull-request' || base.branch !== defaultBranch || run.branch === defaultBranch) return [];
  const shown = new Set(novelty.findings.flatMap((f) => [f.fingerprint, f.historyFingerprint]));
  const open = await db
    .selectDistinct({
      fingerprint: resourceFindings.fingerprint,
      verdict: resourceFindings.verdict,
      kind: resourceFindings.kind,
      place: resourceFindings.place,
      site: resourceFindings.site,
    })
    .from(resourceFindings)
    .innerJoin(resourceOccurrences, eq(resourceOccurrences.findingId, resourceFindings.id))
    .innerJoin(testRuns, eq(testRuns.id, resourceOccurrences.runId))
    .where(
      and(
        eq(resourceFindings.projectId, run.projectId),
        eq(resourceFindings.status, 'open'),
        eq(resourceFindings.cleanRuns, 0),
        inArray(resourceFindings.verdict, ['leaked', 'probable', 'handle']),
        lt(testRuns.startTime, run.startTime),
        eq(testRuns.isFullRun, 1),
        shownOnBranch(defaultBranch, true),
      ),
    );
  const unseen = open.filter((row) => !shown.has(row.fingerprint));
  if (unseen.length === 0) return [];
  const couldShow = await reportReach(db, run, { inOwnFile: true });
  return unseen
    .filter((row) => couldShow(row))
    .sort((a, b) => (a.site ?? a.place).localeCompare(b.site ?? b.place))
    .map((row) => ({
      verdict: row.verdict as WireResourceFinding['verdict'],
      kind: row.kind as WireResourceFinding['kind'],
      where: row.place,
      site: row.site,
      tests: 0,
      count: 0,
    }));
}

/** What the gate's leak rules read of a run. */
export type RunLeakFacts = NonNullable<GateFacts['resources']>;

/**
 * What the gate's leak rules read of a run: its leaks, one per identity, and
 * those its base branch never showed. Not measured (`reported: false`) when
 * the run sent no report, nor when its project declined the `resources`
 * capability (`declined`): no history is recorded for such a project, so
 * every leak would read new.
 */
export async function runLeakFacts(db: DrizzleDB, runId: number): Promise<RunLeakFacts> {
  const [run] = await db.select({ projectId: testRuns.projectId }).from(testRuns).where(eq(testRuns.id, runId));
  if (run && (await isPassiveCapabilityDeclined(db, run.projectId, 'resources'))) {
    return { reported: false, declined: true, leaks: [], newLeaks: [], baseBranch: null };
  }
  const novelty = await runFindingsNovelty(db, runId);
  const leaks = (novelty?.findings ?? []).filter((f) => isLeak(f.finding));
  const toLeak = ({ finding }: RunFindingNovelty) => ({
    where: finding.where,
    site: finding.site ?? null,
    tests: finding.tests,
  });
  return {
    reported: novelty !== null,
    leaks: leaks.map(toLeak),
    newLeaks: leaks.filter((f) => f.isNew).map(toLeak),
    baseBranch: novelty?.baseBranch ?? null,
  };
}

/**
 * Pair each finding with an open finding of the same group (`resourceGroup`:
 * the same identity and text without line numbers) it may have moved from,
 * the closest lines first; each candidate pairs once. A finding left unpaired
 * is a new one.
 */
export function pairMoved<T extends RunFinding, U extends Pick<FindingRow, 'fingerprint' | 'place'>>(
  findings: T[],
  candidates: U[],
): Map<T, U> {
  const options: Array<{ finding: T; candidate: U; distance: number }> = [];
  for (const finding of findings) {
    const group = resourceGroup(finding.fingerprint, finding.finding.where);
    const line = openingLine(finding.fingerprint);
    for (const candidate of candidates) {
      const sameGroup = resourceGroup(candidate.fingerprint, candidate.place) === group;
      if (candidate.fingerprint === finding.fingerprint || !sameGroup) continue;
      const from = openingLine(candidate.fingerprint);
      options.push({ finding, candidate, distance: line !== null && from !== null ? Math.abs(line - from) : 0 });
    }
  }
  options.sort((a, b) => a.distance - b.distance);
  const pairs = new Map<T, U>();
  const taken = new Set<U>();
  for (const { finding, candidate } of options) {
    if (pairs.has(finding) || taken.has(candidate)) continue;
    pairs.set(finding, candidate);
    taken.add(candidate);
  }
  return pairs;
}

/** The app setting holding the identity version (`RESOURCE_IDENTITY_VERSION`) the stored findings carry. */
const RESOURCE_IDENTITY_SETTING = 'resource_finding_identity_version';

/**
 * A finding stored under the identity of version 1,
 * `verdict|kind|scope|where|growth|detail` with `detail` only for an idle page
 * or a handle, as the current identity reads it: its `where` is the stored
 * `place`, which the latest showing wrote with that identity.
 */
function versionOneFinding(row: FindingRow): WireResourceFinding {
  const parts = row.fingerprint.split('|');
  const scope = parts[2];
  return {
    verdict: row.verdict as WireResourceFinding['verdict'],
    kind: row.kind as WireResourceFinding['kind'],
    where: row.place,
    site: row.site,
    ...((scope === 'test' || scope === 'describe') && { scope }),
    ...(row.verdict === 'piling' && {
      growth: { what: parts.at(-2) as NonNullable<WireResourceFinding['growth']>['what'], from: 0, to: 0, tests: 0 },
    }),
    ...(row.verdict === 'handle' && { detail: parts.slice(5).join('|') }),
    tests: 0,
    count: 0,
  };
}

/**
 * Give every stored finding the current identity, once per identity version,
 * in one transaction: each takes the identity its stored text gives
 * (`versionOneFinding`), and the findings of a project that take the same one
 * merge into the one first seen. The merged finding keeps every showing (two
 * showings in one run add up), runs from the first one's first showing, and
 * takes its line and status from the one seen last. Returns how many findings
 * took a new identity and how many merged into another, or null when the
 * stored findings already carry the current one.
 */
export async function rekeyResourceFindingsOnce(db: DrizzleDB): Promise<{ updated: number; merged: number } | null> {
  if (((await getAppSetting<number>(db, RESOURCE_IDENTITY_SETTING)) ?? 1) >= RESOURCE_IDENTITY_VERSION) return null;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(resourceFindings)
      .orderBy(resourceFindings.projectId, resourceFindings.firstSeenAt, resourceFindings.id);
    const byIdentity = new Map<string, FindingRow[]>();
    for (const row of rows) {
      // A finding a run recorded under the current identity, five fields to version 1's six, keeps it.
      const current = row.fingerprint.split('|').length < 6;
      const key = `${row.projectId}|${current ? row.fingerprint : resourceFingerprint(versionOneFinding(row))}`;
      byIdentity.set(key, [...(byIdentity.get(key) ?? []), row]);
    }
    let updated = 0;
    let merged = 0;
    const now = new Date();
    for (const [key, [survivor, ...absorbed]] of byIdentity) {
      const fingerprint = key.slice(key.indexOf('|') + 1);
      if (absorbed.length === 0 && survivor!.fingerprint === fingerprint) continue;
      let occurrences = survivor!.occurrences;
      for (const row of absorbed) {
        occurrences += row.occurrences - (await mergeOccurrences(tx, row.id, survivor!.id));
        await tx.delete(resourceFindings).where(eq(resourceFindings.id, row.id));
        merged++;
      }
      const latest = [survivor!, ...absorbed].reduce((a, b) => (b.lastSeenAt > a.lastSeenAt ? b : a));
      await tx
        .update(resourceFindings)
        .set({
          fingerprint,
          occurrences,
          place: latest.place,
          site: latest.site,
          lastSeenRunId: latest.lastSeenRunId,
          lastSeenAt: latest.lastSeenAt,
          status: latest.status,
          cleanRuns: latest.cleanRuns,
          lastCheckedRunId: latest.lastCheckedRunId,
          fixedRunId: latest.fixedRunId,
          fixedAt: latest.fixedAt,
          reopenedRunId: latest.reopenedRunId,
          updatedAt: now,
        })
        .where(eq(resourceFindings.id, survivor!.id));
      updated++;
    }
    await setAppSetting(tx, RESOURCE_IDENTITY_SETTING, RESOURCE_IDENTITY_VERSION);
    return { updated, merged };
  });
}

/**
 * Move a finding's showings to the finding it merges into; a run that showed
 * both keeps one showing, their numbers added up. Returns how many runs showed
 * both.
 */
async function mergeOccurrences(db: DrizzleDB, fromId: number, toId: number): Promise<number> {
  const kept = new Map(
    (await db.select().from(resourceOccurrences).where(eq(resourceOccurrences.findingId, toId))).map((o) => [
      o.runId,
      o,
    ]),
  );
  let shared = 0;
  for (const occurrence of await db
    .select()
    .from(resourceOccurrences)
    .where(eq(resourceOccurrences.findingId, fromId))) {
    const into = kept.get(occurrence.runId);
    if (!into) {
      await db.update(resourceOccurrences).set({ findingId: toId }).where(eq(resourceOccurrences.id, occurrence.id));
      continue;
    }
    shared++;
    const sum = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
    await db
      .update(resourceOccurrences)
      .set({
        count: into.count + occurrence.count,
        tests: into.tests + occurrence.tests,
        heldMs:
          into.heldMs == null && occurrence.heldMs == null ? null : Math.max(into.heldMs ?? 0, occurrence.heldMs ?? 0),
        afterTestCpuMs: sum(into.afterTestCpuMs, occurrence.afterTestCpuMs),
        pages: sum(into.pages, occurrence.pages),
      })
      .where(eq(resourceOccurrences.id, into.id));
    await db.delete(resourceOccurrences).where(eq(resourceOccurrences.id, occurrence.id));
  }
  return shared;
}

/** A finding as its history reads, for the tab, the tools and the comment. */
export interface ResourceFindingHistory {
  id: number;
  fingerprint: string;
  verdict: string;
  kind: string;
  where: string;
  site: string | null;
  status: 'open' | 'fixed';
  firstSeenRunId: number;
  lastSeenRunId: number;
  /** Runs it showed in. */
  runs: number;
  /** Full default-branch runs without it since it last showed. */
  cleanRuns: number;
  /** The first of those runs; the run it was fixed in once it is fixed. */
  fixedRunId: number | null;
  fixedAt: Date | null;
  reopenedRunId: number | null;
}

function toHistory(row: typeof resourceFindings.$inferSelect): ResourceFindingHistory {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    verdict: row.verdict,
    kind: row.kind,
    where: row.place,
    site: row.site,
    status: row.status === 'fixed' ? 'fixed' : 'open',
    firstSeenRunId: row.firstSeenRunId,
    lastSeenRunId: row.lastSeenRunId,
    runs: row.occurrences,
    cleanRuns: row.cleanRuns,
    fixedRunId: row.fixedRunId,
    fixedAt: row.fixedAt,
    reopenedRunId: row.reopenedRunId,
  };
}

/** The history of the findings with these identities in a project, by identity. */
export async function findingHistoryByFingerprint(
  db: DrizzleDB,
  projectId: number,
  fingerprints: string[],
): Promise<Map<string, ResourceFindingHistory>> {
  if (fingerprints.length === 0) return new Map();
  const rows = await db
    .select()
    .from(resourceFindings)
    .where(and(eq(resourceFindings.projectId, projectId), inArray(resourceFindings.fingerprint, fingerprints)));
  return new Map(rows.map((row) => [row.fingerprint, toHistory(row)]));
}

/** A project's findings, the most recently seen first. */
export async function listResourceFindings(
  db: DrizzleDB,
  projectId: number,
  opts: { status?: 'open' | 'fixed' | 'all'; verdict?: string; limit?: number } = {},
): Promise<ResourceFindingHistory[]> {
  const status = opts.status ?? 'open';
  const conditions: SQL[] = [eq(resourceFindings.projectId, projectId)];
  if (status !== 'all') conditions.push(eq(resourceFindings.status, status));
  if (opts.verdict) conditions.push(eq(resourceFindings.verdict, opts.verdict));
  const rows = await db
    .select()
    .from(resourceFindings)
    .where(and(...conditions))
    .orderBy(desc(resourceFindings.lastSeenAt), desc(resourceFindings.id))
    .limit(Math.min(200, Math.max(1, opts.limit ?? 50)));
  return rows.map(toHistory);
}

/** The latest occurrence of each finding, for what it held the last time it showed. */
export async function latestOccurrences(
  db: DrizzleDB,
  findingIds: number[],
): Promise<Map<number, typeof resourceOccurrences.$inferSelect>> {
  if (findingIds.length === 0) return new Map();
  const rows = await db
    .select({ occurrence: resourceOccurrences })
    .from(resourceOccurrences)
    .innerJoin(testRuns, eq(testRuns.id, resourceOccurrences.runId))
    .where(inArray(resourceOccurrences.findingId, findingIds))
    .orderBy(desc(testRuns.startTime), desc(resourceOccurrences.runId));
  const out = new Map<number, typeof resourceOccurrences.$inferSelect>();
  for (const { occurrence } of rows) if (!out.has(occurrence.findingId)) out.set(occurrence.findingId, occurrence);
  return out;
}
