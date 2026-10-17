/**
 * Change coverage — the answer to "did we test what this pull request changed?".
 * Joins the changed files of a diff to the tests that observably reach them
 * (locator call sites, captured every run, the tests defined in a changed spec,
 * the route or page a file implements, and the files a test executed when code
 * reach is on) and to the tickets named in the commits and the pull request.
 *
 * Honest by construction: reach is *observed* reach, and "no test in this run"
 * is always paired with the count from the recent window, so a
 * selection-narrowed run is never mistaken for a gap. With the head commit's
 * combined coverage, a file a suite ran one of the changed lines of counts as
 * reached too, and the change's patch coverage is counted on it.
 */

import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import {
  codeReach,
  graphEdges,
  locatorSnapshots,
  testCases,
  testRuns,
  testRunsCases,
} from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { parseCallsiteLocation } from '../callsite-location';
import {
  fileRouteTarget,
  filePageTarget,
  routeKeyMatchesTarget,
  pageKeyMatchesTarget,
  type ConventionTarget,
} from '../graph';
import { HISTORY_WINDOW_RUNS } from './scenario-gaps';
import { eligibleRunSql } from '../run-eligibility';
import type { CombinedFile, CoverageSuiteKind } from '../coverage-combine';
import { computePatchCoverage, suitesOnChangedLines, type PatchAreas, type PatchCoverage } from '../patch-coverage';

/** A repo-relative path normalized for suffix matching. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/** Statuses a case can carry without having actually executed — never reach. */
const NON_RUNNING_STATUSES = ['skipped', 'didnotrun'];

/** Two repo-relative paths match when equal or one is a path-suffix of the other. */
function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith('/' + b) || b.endsWith('/' + a);
}

/** The Jira/Linear-style ticket shape, `PROJ-123`. */
const TICKET_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/**
 * Prefixes that share the ticket shape but are standards, hashes, acronyms or
 * epidemiological names — never a tracker id. A binding's project key takes
 * precedence over this list; without one, these are dropped as false positives.
 */
const NON_TICKET_PREFIXES = new Set([
  'UTF',
  'UTF8',
  'UTF16',
  'UTF32',
  'SHA',
  'SHA1',
  'SHA256',
  'SHA512',
  'MD5',
  'ISO',
  'RFC',
  'CVE',
  'ES',
  'COVID',
  'AES',
  'RSA',
  'HTTP',
  'HTTPS',
  'IPV4',
  'IPV6',
  'PBKDF2',
  'BASE64',
  'EC2',
]);

/** The alphabetic project-key part of a ticket id (`PROJ` of `PROJ-123`). */
export function ticketPrefix(id: string): string {
  const dash = id.indexOf('-');
  return (dash < 0 ? id : id.slice(0, dash)).toUpperCase();
}

/**
 * Distinct ticket ids mentioned across a set of free-text strings. Ids whose
 * prefix is a known non-ticket token (a hash, a standard, an acronym) are
 * dropped unless they match the project's tracker key, which is always kept.
 */
export function extractTicketIds(
  texts: Array<string | null | undefined>,
  options: { ticketKey?: string | null } = {},
): string[] {
  const ticketKey = options.ticketKey?.toUpperCase() || null;
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(TICKET_RE)) {
      const prefix = ticketPrefix(m[0]);
      if (prefix !== ticketKey && NON_TICKET_PREFIXES.has(prefix)) continue;
      found.add(m[0]);
    }
  }
  return [...found];
}

/**
 * The ticket a group and its files lead with: one matching the project's tracker
 * key when the binding names one, else the first mentioned. Foreign-project ids
 * still list, they just do not win the primary slot over the bound project's.
 */
export function pickPrimaryTicket(tickets: string[], ticketKey?: string | null): string | null {
  if (tickets.length === 0) return null;
  const key = ticketKey?.toUpperCase() || null;
  if (key) {
    const match = tickets.find((t) => ticketPrefix(t) === key);
    if (match) return match;
  }
  return tickets[0]!;
}

// ── Inputs / outputs ─────────────────────────────────────────────────────────

export interface ChangedFileInput {
  filePath: string;
  additions: number;
  deletions: number;
  /** The new file's added and modified lines, from the provider's patch; absent without one. */
  changedLines?: number[];
}

/**
 * How much the reach answer can be trusted for a file:
 * - `reached` — a test observably reaches it (this run or history).
 * - `observable-unreached` — it maps to a route or page node, or a spec/call-site
 *   source, so "no test reaches it" is real evidence.
 * - `no-evidence` — no convention maps it and no test source touches it, so
 *   nothing can be said about its reach; not a confident gap.
 */
export type ReachBasis = 'reached' | 'observable-unreached' | 'no-evidence';

export interface ChangeCoverageFile {
  filePath: string;
  additions: number;
  deletions: number;
  /** A test reaching this file ran in the run under inspection. */
  reachedInRun: boolean;
  /** How many of the recent runs a reaching test executed in. */
  reachedCountHistory: number;
  /** Distinct tests that observably reach this file. */
  reachingTestCount: number;
  /** The suites of the head commit's coverage that ran one of the file's changed lines. */
  suites: string[];
  /** Whether reach for this file is observable at all — drives gap confidence. */
  reachBasis: ReachBasis;
  ticket: string | null;
}

export interface ChangeCoverageTicket {
  ticket: string | null;
  files: ChangeCoverageFile[];
}

export interface ChangeCoverage {
  runId: number | null;
  baseSha: string | null;
  headSha: string | null;
  baseBranch: string | null;
  windowRuns: number;
  files: ChangeCoverageFile[];
  tickets: ChangeCoverageTicket[];
  reachedFiles: number;
  uncoveredFiles: number;
  /** The changed lines the head commit's combined coverage counts; null without coverage or patches. */
  patchCoverage: PatchCoverage | null;
  /** True when the provider capped the changed-file list, so more files exist than shown. */
  filesTruncated: boolean;
  /** Total changed files the diff reported before the cap, when the provider exposes it. */
  totalChangedFiles: number | null;
  /** False when no SCM diff was available (no token, or the fetch failed). */
  scmAvailable: boolean;
}

export interface ChangeCoverageInput {
  changedFiles: ChangedFileInput[];
  runId?: number | null;
  baseSha?: string | null;
  headSha?: string | null;
  baseBranch?: string | null;
  /** Tickets from the commit messages and the pull request. */
  tickets?: string[];
  /** The project's tracker key (`PROJ`), so its ids win the primary slot. */
  ticketKey?: string | null;
  /** Per-file ticket, from the commit that changed each file — normalized path → id. */
  fileTickets?: Record<string, string>;
  /** True when the provider capped the changed-file list before handing it in. */
  filesTruncated?: boolean;
  /** Total changed files the diff reported before the cap, when known. */
  totalChangedFiles?: number | null;
  scmAvailable?: boolean;
  /** The head commit's combined coverage, when it has some. */
  commitCoverage?: CommitCoverageInput | null;
}

/** The parts of a commit's combined coverage change coverage reads. */
export interface CommitCoverageInput {
  commit: string;
  files: CombinedFile[];
  suites: Array<{ name: string; kind: CoverageSuiteKind }>;
  /** The project's named areas; the patch coverage counts each. */
  areas?: PatchAreas | null;
}

/** A file reached by a test, in the run or the window, or by a suite on its changed lines. */
export function isReachedFile(
  file: Pick<ChangeCoverageFile, 'reachedInRun' | 'reachedCountHistory' | 'suites'>,
): boolean {
  return file.reachedInRun || file.reachedCountHistory > 0 || file.suites.length > 0;
}

// ── File reach ───────────────────────────────────────────────────────────────

/**
 * Per-file set of test cases that reach it, from locator call sites (captured
 * every run for every locator) plus the tests defined in the file itself.
 */
async function loadFileReach(
  db: DrizzleDB,
  projectId: number,
): Promise<{ byFile: Map<string, Set<number>>; caseFiles: Array<{ id: number; filePath: string }> }> {
  const caseFiles = await db
    .select({ id: testCases.id, filePath: testCases.filePath })
    .from(testCases)
    .where(eq(testCases.projectId, projectId));

  const snapshots = await db
    .select({ testCaseId: locatorSnapshots.testCaseId, location: locatorSnapshots.location })
    .from(locatorSnapshots)
    .innerJoin(testCases, eq(locatorSnapshots.testCaseId, testCases.id))
    .where(eq(testCases.projectId, projectId));

  const byFile = new Map<string, Set<number>>();
  const add = (file: string, caseId: number) => {
    const norm = normalizePath(file);
    if (!norm) return;
    const set = byFile.get(norm) ?? new Set<number>();
    set.add(caseId);
    byFile.set(norm, set);
  };

  for (const s of snapshots) {
    const parsed = parseCallsiteLocation(s.location);
    if (parsed?.file) add(parsed.file, s.testCaseId);
  }
  return { byFile, caseFiles };
}

/**
 * Per-node set of test cases that reach it, from the graph's `reaches` edges.
 * Change coverage resolves a changed route handler or page file to its route or
 * page node through the file-routing convention and reads reach here, so a
 * changed application source file joins to the tests that reach it. Read across
 * branches, since a pull-request run's reach is as valid as the default's.
 */
async function loadGraphNodeReach(
  db: DrizzleDB,
  projectId: number,
): Promise<{ byRoute: Map<string, Set<number>>; byPage: Map<string, Set<number>> }> {
  const rows = await db
    .select({ toKind: graphEdges.toKind, toKey: graphEdges.toKey, fromKey: graphEdges.fromKey })
    .from(graphEdges)
    .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.kind, 'reaches')));

  const byRoute = new Map<string, Set<number>>();
  const byPage = new Map<string, Set<number>>();
  for (const r of rows) {
    const target = r.toKind === 'route' ? byRoute : r.toKind === 'page' ? byPage : null;
    if (!target) continue;
    const id = Number(r.fromKey);
    if (!Number.isFinite(id)) continue;
    const set = target.get(r.toKey) ?? new Set<number>();
    set.add(id);
    target.set(r.toKey, set);
  }
  return { byRoute, byPage };
}

/** Per file, the tests whose execution ran its code (`code_reach`, every branch and runtime, browser and server). */
async function loadCodeReach(db: DrizzleDB, projectId: number): Promise<Map<string, Set<number>>> {
  const rows = await db
    .select({ file: codeReach.file, testCaseId: codeReach.testCaseId })
    .from(codeReach)
    .where(eq(codeReach.projectId, projectId));
  const byFile = new Map<string, Set<number>>();
  for (const r of rows) byFile.set(r.file, (byFile.get(r.file) ?? new Set<number>()).add(r.testCaseId));
  return byFile;
}

/** Union into `reaching` the tests reaching any node a file's convention target matches. */
function addNodeReach(
  target: ConventionTarget | null,
  byNode: Map<string, Set<number>>,
  matches: (t: ConventionTarget, key: string) => boolean,
  reaching: Set<number>,
): void {
  if (!target) return;
  for (const [key, ids] of byNode) {
    if (matches(target, key)) for (const id of ids) reaching.add(id);
  }
}

/**
 * Compute change coverage for one diff. Pure of any SCM concern — the caller
 * fetches the diff and the tickets and hands them in, so the demo runs the same
 * join against seeded rows.
 */
export async function computeChangeCoverage(
  db: DrizzleDB,
  projectId: number,
  input: ChangeCoverageInput,
): Promise<ChangeCoverage> {
  const windowRuns = HISTORY_WINDOW_RUNS;
  const tickets = input.tickets ?? [];
  const primaryTicket = pickPrimaryTicket(tickets, input.ticketKey);
  const fileTickets = input.fileTickets ?? {};
  const files = input.changedFiles
    .map((f) => ({ ...f, filePath: normalizePath(f.filePath) }))
    .filter((f) => f.filePath);
  const commitCoverage = input.commitCoverage ?? null;
  const combinedByPath = new Map((commitCoverage?.files ?? []).map((f) => [f.path, f]));

  const recent = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.projectId, projectId), eligibleRunSql('change-coverage')))
    .orderBy(desc(testRuns.id))
    .limit(windowRuns);
  const recentIds = recent.map((r) => r.id);

  const { byFile, caseFiles } = await loadFileReach(db, projectId);
  const { byRoute, byPage } = await loadGraphNodeReach(db, projectId);
  const byCode = await loadCodeReach(db, projectId);

  // Which test cases ran in the inspected run, and in each recent run. A case
  // that was skipped or did-not-run is present in the rows but never executed, so
  // it is not reach — counting it would report an untested change as covered.
  const ranInRun = new Set<number>();
  if (input.runId != null) {
    const rows = await db
      .select({ testCaseId: testRunsCases.testCaseId })
      .from(testRunsCases)
      .where(and(eq(testRunsCases.testRunId, input.runId), notInArray(testRunsCases.status, NON_RUNNING_STATUSES)));
    for (const r of rows) ranInRun.add(r.testCaseId);
  }

  const runsByCase = new Map<number, Set<number>>();
  if (recentIds.length > 0) {
    const rows = await db
      .select({ testRunId: testRunsCases.testRunId, testCaseId: testRunsCases.testCaseId })
      .from(testRunsCases)
      .where(and(inArray(testRunsCases.testRunId, recentIds), notInArray(testRunsCases.status, NON_RUNNING_STATUSES)));
    for (const r of rows) {
      const set = runsByCase.get(r.testCaseId) ?? new Set<number>();
      set.add(r.testRunId);
      runsByCase.set(r.testCaseId, set);
    }
  }

  const covered: ChangeCoverageFile[] = files.map((file) => {
    const reaching = new Set<number>();
    let observable = false;
    // Reach through captured locator call sites.
    for (const [reachedFile, ids] of byFile) {
      if (pathsMatch(reachedFile, file.filePath)) {
        observable = true;
        for (const id of ids) reaching.add(id);
      }
    }
    // A changed spec file reaches the tests defined in it.
    for (const c of caseFiles) {
      if (pathsMatch(normalizePath(c.filePath), file.filePath)) {
        observable = true;
        reaching.add(c.id);
      }
    }
    // Reach through the file's own graph node: a route handler resolved to its
    // route node, a page file to its page node, by the file-routing convention.
    const routeTarget = fileRouteTarget(file.filePath);
    const pageTarget = filePageTarget(file.filePath);
    if (routeTarget || pageTarget) observable = true;
    addNodeReach(routeTarget, byRoute, routeKeyMatchesTarget, reaching);
    addNodeReach(pageTarget, byPage, pageKeyMatchesTarget, reaching);
    // Reach through code reach: a test executed the file's functions.
    for (const [reachedFile, ids] of byCode) {
      if (pathsMatch(reachedFile, file.filePath)) {
        observable = true;
        for (const id of ids) reaching.add(id);
      }
    }

    const historyRuns = new Set<number>();
    for (const id of reaching) for (const runId of runsByCase.get(id) ?? []) historyRuns.add(runId);

    const reachedInRun = input.runId != null ? [...reaching].some((id) => ranInRun.has(id)) : historyRuns.size > 0;

    const combined = combinedByPath.get(file.filePath);
    const suites = combined && file.changedLines?.length ? suitesOnChangedLines(combined, file.changedLines) : [];

    const reachBasis: ReachBasis =
      reaching.size > 0 || suites.length > 0 ? 'reached' : observable ? 'observable-unreached' : 'no-evidence';

    return {
      filePath: file.filePath,
      additions: file.additions,
      deletions: file.deletions,
      reachedInRun,
      reachedCountHistory: historyRuns.size,
      reachingTestCount: reaching.size,
      suites,
      reachBasis,
      ticket: fileTickets[file.filePath] ?? primaryTicket,
    };
  });

  const reachedFiles = covered.filter(isReachedFile).length;
  const patchCoverage = commitCoverage
    ? computePatchCoverage(
        commitCoverage.commit,
        commitCoverage.files,
        commitCoverage.suites,
        new Map(files.filter((f) => f.changedLines?.length).map((f) => [f.filePath, f.changedLines!])),
        commitCoverage.areas ?? null,
      )
    : null;

  // Group by ticket, uncovered files leading each group.
  const byTicket = new Map<string | null, ChangeCoverageFile[]>();
  for (const f of covered) {
    const list = byTicket.get(f.ticket) ?? [];
    list.push(f);
    byTicket.set(f.ticket, list);
  }
  const ticketGroups: ChangeCoverageTicket[] = [...byTicket].map(([ticket, groupFiles]) => ({
    ticket,
    files: groupFiles,
  }));

  return {
    runId: input.runId ?? null,
    baseSha: input.baseSha ?? null,
    headSha: input.headSha ?? null,
    baseBranch: input.baseBranch ?? null,
    windowRuns,
    files: covered,
    tickets: ticketGroups,
    reachedFiles,
    uncoveredFiles: covered.length - reachedFiles,
    patchCoverage,
    filesTruncated: input.filesTruncated ?? false,
    totalChangedFiles: input.totalChangedFiles ?? null,
    scmAvailable: input.scmAvailable ?? true,
  };
}
