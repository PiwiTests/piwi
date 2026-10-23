import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { bugTitle, emptyBugEvidence, renderBugSpec, type BugReport } from '@piwitests/core/bug-report';
import { sessionFromSteps, type PiwiSteps } from '@piwitests/core/steps';
import { renderSpec, type CodegenResult } from '@piwitests/core/codegen';
import { canonicalLocator } from '@piwitests/core/locator-chain';
import { bugOutcome, lastAttemptsByTest } from '@piwitests/core/status-classify';
import type { BugContext, BugEvidence } from '@piwitests/core/bug-report';
import {
  bugReports,
  bugReproductions,
  entityLinks,
  projects,
  testCases,
  testRuns,
  testRunsCases,
  users,
} from '../../server/database/schema';
import { getProjectFunctionCatalog } from './test-functions';
import { getLocatorIndex } from '../../server/utils/locator-usages';
import { recordOutcome } from '../../server/utils/outcomes';
import type { HandbackOutcome } from '../handback-outcomes';
import { resolveRunBranch } from '../../server/utils/run-branch';
import { mostCommonRunBranch } from '../../server/utils/scm/stored-default-branch';
import type { TestMetadata } from '#shared/types';
import { computeMissedBy, describeMissedBy, type MissedBy } from '#shared/bug-report-missed-by';
import type { DrizzleDB } from './db';
import { isEligibleRun } from '../run-eligibility';

/**
 * Bug reports: what Piwi Picker sends with **Send to Piwi…**, kept with its
 * steps, evidence and context, the reproductions tried since, and the test
 * that reproduces it once one is committed with `piwi:bug <id>`.
 *
 * Lifecycle: `open` → `test-committed` when a run carries a test naming the
 * report → `looks-fixed` when that test, marked `test.fail()`, passes →
 * `closed` when it passes as an ordinary test. A later failure of a closed
 * report's test reopens it as `test-committed`. `dismissed` is set by hand and
 * never moves on its own. Only runs {@link movesBugReports} accepts move a
 * report.
 */

export const BUG_REPORT_STATUSES = ['open', 'test-committed', 'looks-fixed', 'closed', 'dismissed'] as const;
export type BugReportStatus = (typeof BUG_REPORT_STATUSES)[number];

export const BUG_REPRODUCTION_SOURCES = ['replay', 'desktop'] as const;
export const BUG_REPRODUCTION_VERDICTS = ['reproduced', 'not-reproduced', 'diverged'] as const;
export type BugReproductionVerdict = (typeof BUG_REPRODUCTION_VERDICTS)[number];

/** What a send may carry. */
export const BUG_REPORT_LIMITS = {
  screenshots: 3,
  screenshotBytes: 5 * 1024 * 1024,
  /** Screenshots of the page as each step began: JPEGs, at most one per step. */
  stepShots: 100,
  stepShotBytes: 1024 * 1024,
  /** All of a report's step screenshots together. */
  stepShotsBytes: 32 * 1024 * 1024,
  jsonBytes: 1024 * 1024,
} as const;

export const DEFAULT_BUGS_FOLDER = 'tests/bugs';

/** A project's settings for the specs Piwi writes from steps. */
export interface GeneratedSpecSettings {
  /** The module a bug spec imports `test` and `expect` from, as written in that spec; null for `@playwright/test`. */
  testImport: string | null;
  /** The folder bug specs go to, relative to the repository root. */
  bugsFolder: string;
}

export const generatedSpecSettingsSchema = z.object({
  testImport: z
    .string()
    .trim()
    .max(200)
    .regex(/^[\w@./-]*$/, 'A module path: letters, digits, @, ., / and -')
    .nullish(),
  bugsFolder: z
    .string()
    .trim()
    .max(200)
    .regex(/^[\w.-]+(\/[\w.-]+)*$/, 'A relative folder such as tests/bugs')
    .refine((p) => !p.split('/').includes('..'), 'The folder stays inside the repository')
    .nullish(),
});

/** A folder a spec is written to, relative to the repository root: forward slashes, staying inside it. */
export const specDirSchema = z
  .string()
  .max(500)
  .refine((dir) => !dir.startsWith('/') && !dir.includes('\\') && !dir.split('/').includes('..'))
  .optional();

function resolveGeneratedSpecSettings(raw: unknown): GeneratedSpecSettings {
  const parsed = generatedSpecSettingsSchema.safeParse(raw ?? {});
  const value = parsed.success ? parsed.data : {};
  return {
    testImport: value.testImport || null,
    bugsFolder: value.bugsFolder || DEFAULT_BUGS_FOLDER,
  };
}

export const bugReportPatchSchema = z.object({
  status: z.enum(['open', 'dismissed', 'closed']).optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

export const bugReproductionSchema = z.object({
  source: z.enum(BUG_REPRODUCTION_SOURCES).default('replay'),
  verdict: z.enum(BUG_REPRODUCTION_VERDICTS),
  divergedAt: z.number().int().min(0).max(1000).nullish(),
  origin: z
    .string()
    .trim()
    .max(300)
    .refine((o) => /^https?:\/\/[^/\s]+$/.test(o), 'An http(s) origin such as http://localhost:3000')
    .nullish(),
  userAgent: z.string().max(500).nullish(),
  runId: z.number().int().positive().nullish(),
});
export type BugReproductionInput = z.infer<typeof bugReproductionSchema>;

export interface BugReportListItem {
  id: number;
  title: string;
  status: BugReportStatus;
  pageKey: string | null;
  path: string | null;
  origin: string | null;
  createdAt: string;
  reportedBy: string | null;
  testCaseId: number | null;
  reproductions: number;
  lastVerdict: BugReproductionVerdict | null;
}

export interface BugReproductionItem {
  id: number;
  source: 'replay' | 'desktop';
  verdict: BugReproductionVerdict;
  divergedAt: number | null;
  origin: string | null;
  userAgent: string | null;
  runId: number | null;
  by: string | null;
  createdAt: string;
}

export interface BugReportDetail extends BugReportListItem {
  projectId: number;
  projectName: string;
  note: string | null;
  language: string | null;
  steps: PiwiSteps;
  evidence: BugEvidence;
  context: BugContext;
  closedAt: string | null;
  closedByRunId: number | null;
  statusRunId: number | null;
  test: { id: number; title: string; filePath: string } | null;
  reproductionList: BugReproductionItem[];
  /** The tracker issue the report is filed as, when there is one. */
  ticket: {
    id: number;
    url: string;
    key: string;
    provider: string;
    statusText: string | null;
    statusColor: string | null;
  } | null;
}

function iso(d: Date | number | null | undefined): string | null {
  if (d == null) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A user's name as the report pages show it. */
function userName(row: { name: string | null; username: string | null } | null | undefined): string | null {
  return row?.name || row?.username || null;
}

/** The storage folder of a report's screenshots. */
export function bugReportStorageDir(id: number): string {
  return `bug-reports/${id}`;
}

/** Stores a report sent from Piwi Picker; the screenshots are written by the caller once the id exists. */
export async function insertBugReport(
  db: DrizzleDB,
  input: { projectId: number; report: BugReport; language: string | null; createdBy: number | null },
): Promise<{ id: number }> {
  const { report } = input;
  const [row] = await db
    .insert(bugReports)
    .values({
      projectId: input.projectId,
      title: bugTitle(report).slice(0, 200),
      note: report.steps.note,
      pageKey: report.context.pageKey,
      path: report.context.path,
      origin: report.context.origin ?? report.steps.origin,
      status: 'open',
      steps: report.steps,
      evidence: report.evidence,
      context: report.context,
      language: input.language,
      createdBy: input.createdBy && input.createdBy > 0 ? input.createdBy : null,
    })
    .returning({ id: bugReports.id });
  return { id: row!.id };
}

export async function deleteBugReport(db: DrizzleDB, id: number): Promise<void> {
  await db.delete(entityLinks).where(eq(entityLinks.bugReportId, id));
  await db.delete(bugReports).where(eq(bugReports.id, id));
}

/** A project's bug reports, newest first: at most `limit` (500 by default), older than `beforeId` when set. */
export async function listBugReports(
  db: DrizzleDB,
  projectId: number,
  opts: { status?: string | null; beforeId?: number | null; limit?: number } = {},
): Promise<BugReportListItem[]> {
  const status = BUG_REPORT_STATUSES.find((s) => s === opts.status);
  const conditions = [eq(bugReports.projectId, projectId)];
  if (status) conditions.push(eq(bugReports.status, status));
  if (opts.beforeId != null) conditions.push(lt(bugReports.id, opts.beforeId));
  const rows = await db
    .select({
      id: bugReports.id,
      title: bugReports.title,
      status: bugReports.status,
      pageKey: bugReports.pageKey,
      path: bugReports.path,
      origin: bugReports.origin,
      createdAt: bugReports.createdAt,
      testCaseId: bugReports.testCaseId,
      name: users.name,
      username: users.username,
    })
    .from(bugReports)
    .leftJoin(users, eq(bugReports.createdBy, users.id))
    .where(and(...conditions))
    .orderBy(desc(bugReports.id))
    .limit(opts.limit ?? 500);
  const tries = await reproductionSummary(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status as BugReportStatus,
    pageKey: r.pageKey,
    path: r.path,
    origin: r.origin,
    createdAt: iso(r.createdAt)!,
    reportedBy: userName(r),
    testCaseId: r.testCaseId,
    reproductions: tries.get(r.id)?.count ?? 0,
    lastVerdict: tries.get(r.id)?.last ?? null,
  }));
}

async function reproductionSummary(
  db: DrizzleDB,
  ids: number[],
): Promise<Map<number, { count: number; last: BugReproductionVerdict }>> {
  const out = new Map<number, { count: number; last: BugReproductionVerdict }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ bugReportId: bugReproductions.bugReportId, verdict: bugReproductions.verdict })
    .from(bugReproductions)
    .where(inArray(bugReproductions.bugReportId, ids))
    .orderBy(bugReproductions.id);
  for (const row of rows) {
    const entry = out.get(row.bugReportId);
    out.set(row.bugReportId, {
      count: (entry?.count ?? 0) + 1,
      last: row.verdict as BugReproductionVerdict,
    });
  }
  return out;
}

export async function getBugReport(db: DrizzleDB, id: number): Promise<BugReportDetail | null> {
  const [row] = await db
    .select({
      report: bugReports,
      projectName: projects.name,
      projectLabel: projects.label,
      name: users.name,
      username: users.username,
    })
    .from(bugReports)
    .innerJoin(projects, eq(bugReports.projectId, projects.id))
    .leftJoin(users, eq(bugReports.createdBy, users.id))
    .where(eq(bugReports.id, id));
  if (!row) return null;
  const r = row.report;
  const test = r.testCaseId
    ? ((
        await db
          .select({ id: testCases.id, title: testCases.title, filePath: testCases.filePath })
          .from(testCases)
          .where(eq(testCases.id, r.testCaseId))
      )[0] ?? null)
    : null;
  const reproductionList = await listBugReproductions(db, id);
  const [ticket] = await db
    .select({
      id: entityLinks.id,
      url: entityLinks.url,
      key: entityLinks.key,
      provider: entityLinks.provider,
      statusText: entityLinks.statusText,
      statusColor: entityLinks.statusColor,
    })
    .from(entityLinks)
    .where(and(eq(entityLinks.bugReportId, id), sql`${entityLinks.key} is not null`))
    .orderBy(desc(entityLinks.id))
    .limit(1);
  return {
    id: r.id,
    projectId: r.projectId,
    projectName: row.projectLabel || row.projectName,
    title: r.title,
    note: r.note,
    status: r.status as BugReportStatus,
    pageKey: r.pageKey,
    path: r.path,
    origin: r.origin,
    language: r.language,
    createdAt: iso(r.createdAt)!,
    reportedBy: userName(row),
    testCaseId: r.testCaseId,
    steps: r.steps as PiwiSteps,
    evidence: r.evidence as BugEvidence,
    context: r.context as BugContext,
    closedAt: iso(r.closedAt),
    closedByRunId: r.closedByRunId,
    statusRunId: r.statusRunId,
    test,
    reproductions: reproductionList.length,
    lastVerdict: reproductionList.at(-1)?.verdict ?? null,
    reproductionList,
    ticket: ticket?.key ? { ...ticket, key: ticket.key } : null,
  };
}

async function listBugReproductions(db: DrizzleDB, bugReportId: number): Promise<BugReproductionItem[]> {
  const rows = await db
    .select({ r: bugReproductions, name: users.name, username: users.username })
    .from(bugReproductions)
    .leftJoin(users, eq(bugReproductions.createdBy, users.id))
    .where(eq(bugReproductions.bugReportId, bugReportId))
    .orderBy(bugReproductions.id);
  return rows.map(({ r, ...who }) => ({
    id: r.id,
    source: r.source as 'replay' | 'desktop',
    verdict: r.verdict as BugReproductionVerdict,
    divergedAt: r.divergedAt,
    origin: r.origin,
    userAgent: r.userAgent,
    runId: r.runId,
    by: userName(who),
    createdAt: iso(r.createdAt)!,
  }));
}

/**
 * Whether a reproduction may name `runId`: none named, or a run of the bug
 * report's own project. Callers answer 400 otherwise, so a run of a project the
 * caller cannot see reads the same as one that does not exist.
 */
export async function isReproductionRunAllowed(
  db: DrizzleDB,
  bugReportId: number,
  runId: number | null | undefined,
): Promise<boolean> {
  if (runId == null) return true;
  const [row] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .innerJoin(bugReports, eq(bugReports.projectId, testRuns.projectId))
    .where(and(eq(testRuns.id, runId), eq(bugReports.id, bugReportId)));
  return Boolean(row);
}

/** Changes a report's title or status by hand. Returns null when there is no such report. */
export async function updateBugReport(
  db: DrizzleDB,
  id: number,
  patch: z.infer<typeof bugReportPatchSchema>,
): Promise<BugReportDetail | null> {
  const set: Partial<typeof bugReports.$inferInsert> = { updatedAt: new Date() };
  if (patch.title) set.title = patch.title;
  if (patch.status) {
    set.status = patch.status;
    set.statusRunId = null;
    set.closedAt = patch.status === 'closed' ? new Date() : null;
    if (patch.status !== 'closed') set.closedByRunId = null;
  }
  await db.update(bugReports).set(set).where(eq(bugReports.id, id));
  return getBugReport(db, id);
}

export async function addBugReproduction(
  db: DrizzleDB,
  bugReportId: number,
  input: BugReproductionInput,
  createdBy: number | null,
): Promise<BugReproductionItem> {
  const [row] = await db
    .insert(bugReproductions)
    .values({
      bugReportId,
      source: input.source,
      verdict: input.verdict,
      divergedAt: input.verdict === 'diverged' ? (input.divergedAt ?? null) : null,
      origin: input.origin ?? null,
      userAgent: input.userAgent ?? null,
      runId: input.runId ?? null,
      createdBy: createdBy && createdBy > 0 ? createdBy : null,
    })
    .returning({ id: bugReproductions.id });
  const items = await listBugReproductions(db, bugReportId);
  return items.find((item) => item.id === row!.id)!;
}

/** A spec file name from a report's title: `coupon-not-applied-to-the-total.spec.ts`. */
export function bugSpecFileName(title: string, id: number): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${slug || `bug-${id}`}.spec.ts`;
}

export interface BugReportSpec extends CodegenResult {
  /** `commit`: `test.fail()` and the report's annotations; `run`: the spec a reproduction runs. */
  mode: 'commit' | 'run';
  fileName: string;
  /** Where the committed spec goes, relative to the repository root. */
  path: string;
  settings: GeneratedSpecSettings;
}

/**
 * A report's spec, rendered with the project's settings, its function catalog
 * and the locators its suite already uses. `commit` writes the spec to commit
 * now (`test.fail()`, `@bug`, `piwi:bug <id>`); `run` the same test without
 * `test.fail()`, for a reproduction, where a failure on the expected assertion
 * means reproduced.
 */
/** What a project's specs are written with: its function catalog, the locators its suite uses, its test import. */
async function projectSpecOptions(db: DrizzleDB, projectId: number, settings: GeneratedSpecSettings) {
  const [catalog, index] = await Promise.all([
    getProjectFunctionCatalog(db, projectId).catch(() => []),
    getLocatorIndex(db, projectId).catch(() => null),
  ]);
  const preferLocators = new Set(
    (index?.locators ?? []).flatMap((entry) => {
      const canonical = canonicalLocator(entry.locator);
      return canonical ? [canonical] : [];
    }),
  );
  return { catalog, preferLocators, ...(settings.testImport ? { testImport: settings.testImport } : {}) };
}

export async function renderBugReportSpec(
  db: DrizzleDB,
  id: number,
  mode: 'commit' | 'run',
  specDir?: string,
): Promise<BugReportSpec | null> {
  const [row] = await db
    .select({ report: bugReports, generatedSpecs: projects.generatedSpecs })
    .from(bugReports)
    .innerJoin(projects, eq(bugReports.projectId, projects.id))
    .where(eq(bugReports.id, id));
  if (!row) return null;
  const settings = resolveGeneratedSpecSettings(row.generatedSpecs);
  const shared = await projectSpecOptions(db, row.report.projectId, settings);
  if (shared.testImport && specDir != null) {
    shared.testImport = rebaseTestImport(shared.testImport, settings.bugsFolder, specDir);
  }
  const report: BugReport = {
    v: 1,
    steps: { ...(row.report.steps as PiwiSteps), title: row.report.title },
    evidence: row.report.evidence as BugEvidence,
    context: row.report.context as BugContext,
  };
  const result =
    mode === 'commit'
      ? renderBugSpec(report, { ...shared, annotations: [{ type: 'piwi:bug', description: String(id) }] })
      : renderBugSpec(report, { ...shared, expectFail: false, tags: ['@bug'] });
  const fileName = bugSpecFileName(row.report.title, id);
  return { ...result, mode, fileName, path: `${settings.bugsFolder}/${fileName}`, settings };
}

/**
 * Steps from anywhere (a repro request from Piwi Picker) as the spec a
 * reproduction runs in a project: its settings, catalog and suite locators,
 * no `test.fail()`. Null when there is no such project.
 */
export async function renderStepsRunSpec(
  db: DrizzleDB,
  projectId: number,
  steps: PiwiSteps,
  specDir?: string,
): Promise<CodegenResult | null> {
  const [project] = await db
    .select({ generatedSpecs: projects.generatedSpecs })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) return null;
  const settings = resolveGeneratedSpecSettings(project.generatedSpecs);
  const shared = await projectSpecOptions(db, projectId, settings);
  if (shared.testImport && specDir != null) {
    shared.testImport = rebaseTestImport(shared.testImport, settings.bugsFolder, specDir);
  }
  const report: BugReport = { v: 1, steps, evidence: emptyBugEvidence(), context: EMPTY_CONTEXT };
  return renderBugSpec(report, { ...shared, expectFail: false, tags: ['@bug'] });
}

function pathSegments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return out;
}

/**
 * A relative `testImport` is written for a spec in `bugsFolder`. A spec written
 * to another folder, `specDir` (both relative to the repository root), imports
 * the same module by a path from its own folder. A package name stays as it is.
 */
export function rebaseTestImport(testImport: string, bugsFolder: string, specDir: string): string {
  if (!testImport.startsWith('./') && !testImport.startsWith('../')) return testImport;
  const target = pathSegments(`${bugsFolder}/${testImport}`);
  const from = pathSegments(specDir);
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) common++;
  const relative = [...Array<string>(from.length - common).fill('..'), ...target.slice(common)].join('/');
  return relative.startsWith('../') ? relative : `./${relative}`;
}

const EMPTY_CONTEXT: BugContext = {
  origin: null,
  pageKey: null,
  path: null,
  browser: null,
  userAgent: null,
  viewport: null,
  time: 0,
  extensionVersion: null,
};

/** Renders steps with the options a caller names, for the MCP `render_steps` tool and the dashboard. */
export function renderStepsWith(steps: PiwiSteps, options: Parameters<typeof renderSpec>[1]): CodegenResult {
  return renderSpec(sessionFromSteps(steps), options);
}

// ---------------------------------------------------------------------------
// Lifecycle from runs

type Transition = { id: number; from: BugReportStatus; to: BugReportStatus; testCaseId: number; projectId: number };

/**
 * Whether a run moves bug reports: a run the `bug-lifecycle` use of the
 * eligibility rule accepts (never `piwi bug --write`, a lab run, a bisect step
 * or a reproduction) on the project's default branch. A null `defaultBranch`
 * means the project records no branch at all; its runs, which carry none
 * either, count as the default branch's.
 */
export function movesBugReports(
  run: { branch: string | null; metadata: unknown },
  defaultBranch: string | null,
): boolean {
  if (!isEligibleRun(run, 'bug-lifecycle')) return false;
  return (run.branch ?? resolveRunBranch(run.metadata)) === defaultBranch;
}

/**
 * A project's default branch from stored data and the run's own hint, with no
 * SCM call; null when neither the project, the run nor any earlier run names a
 * branch.
 */
async function runDefaultBranch(db: DrizzleDB, projectId: number, metadata: unknown): Promise<string | null> {
  const [project] = await db
    .select({ defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId));
  const hint = (metadata as { defaultBranch?: unknown } | null)?.defaultBranch;
  const named = project?.defaultBranch?.trim() || (typeof hint === 'string' ? hint.trim() : '');
  return named || (await mostCommonRunBranch(db, projectId));
}

/**
 * Moves the reports a run's tests name (`piwi:bug <id>`, same project) along
 * their lifecycle, and links each report to its test, when the run moves bug
 * reports at all ({@link movesBugReports}). Returns what changed.
 * The last attempt of each test in each browser project and `--repeat-each`
 * repetition decides (`bugOutcome`): an expected failure that passed where
 * every other project and repetition passed too → looks fixed; an ordinary pass
 * everywhere → closed; a test no project ran keeps its report; anything else
 * keeps an open report committed, and reopens a closed one. Only a run the
 * `bug-lifecycle` use reads moves a report: never `piwi bug`'s own run, a lab
 * run, a bisect step or a reproduction.
 */
export async function applyBugReportLifecycle(db: DrizzleDB, runId: number): Promise<Transition[]> {
  const [run] = await db
    .select({ projectId: testRuns.projectId, branch: testRuns.branch, metadata: testRuns.metadata })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  if (!run) return [];
  if (!movesBugReports(run, await runDefaultBranch(db, run.projectId, run.metadata))) return [];
  const rows = await db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      expectedStatus: testRunsCases.expectedStatus,
      retries: testRunsCases.retries,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      browserName: testRunsCases.browserName,
      testMeta: testRunsCases.testMeta,
    })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.testRunId, runId), sql`${testRunsCases.testMeta} is not null`));

  const tests: Array<{ testCaseId: number; bugId: number; attempts: typeof rows }> = [];
  for (const [testCaseId, attempts] of lastAttemptsByTest(rows)) {
    const bug = attempts.map((a) => (a.testMeta as TestMetadata | null)?.bug).find(Boolean);
    if (bug) tests.push({ testCaseId, bugId: Number(bug), attempts });
  }
  if (tests.length === 0) return [];

  const reports = await db
    .select({ id: bugReports.id, status: bugReports.status })
    .from(bugReports)
    .where(
      and(
        eq(bugReports.projectId, run.projectId),
        inArray(
          bugReports.id,
          tests.map((t) => t.bugId),
        ),
      ),
    );
  const statusOf = new Map(reports.map((r) => [r.id, r.status as BugReportStatus]));
  const transitions: Transition[] = [];
  const now = new Date();

  for (const test of tests) {
    const from = statusOf.get(test.bugId);
    if (!from) continue;
    await db.update(testCases).set({ bugReportId: test.bugId }).where(eq(testCases.id, test.testCaseId));
    if (from === 'dismissed') continue;

    const outcome = bugOutcome(test.attempts);
    const to: BugReportStatus =
      outcome === 'looks-fixed'
        ? 'looks-fixed'
        : outcome === 'passed'
          ? 'closed'
          : outcome === 'not-run'
            ? from
            : 'test-committed';

    const set: Partial<typeof bugReports.$inferInsert> = { testCaseId: test.testCaseId, updatedAt: now };
    if (to !== from) {
      set.status = to;
      set.statusRunId = runId;
      set.closedAt = to === 'closed' ? now : null;
      set.closedByRunId = to === 'closed' ? runId : null;
      transitions.push({ id: test.bugId, from, to, testCaseId: test.testCaseId, projectId: run.projectId });
      statusOf.set(test.bugId, to);
    }
    await db.update(bugReports).set(set).where(eq(bugReports.id, test.bugId));
    for (const outcome of bugSpecOutcomes(from, to)) {
      await recordOutcome(db, {
        projectId: run.projectId,
        kind: 'bug-spec',
        subjectType: 'bug-report',
        subjectId: test.bugId,
        outcome,
        runId,
        details: { testCaseId: test.testCaseId, from, to },
      });
    }
  }
  return transitions;
}

/**
 * The `bug-spec` hand-back outcomes of a lifecycle move: the first run carrying
 * the test applies the spec, closing verifies it, a failure after closing
 * regresses it.
 */
export function bugSpecOutcomes(from: BugReportStatus, to: BugReportStatus): HandbackOutcome[] {
  if (from === to) return [];
  const out: HandbackOutcome[] = [];
  if (from === 'open') out.push('applied');
  if (to === 'closed') out.push('verified');
  if (from === 'closed' && to === 'test-committed') out.push('regressed');
  return out;
}

/** Why the suite missed a report's bug, from its project's locator index. Null when there is no such report. */
export async function getBugReportMissedBy(
  db: DrizzleDB,
  id: number,
): Promise<(MissedBy & { summary: string }) | null> {
  const [row] = await db
    .select({
      projectId: bugReports.projectId,
      steps: bugReports.steps,
      pageKey: bugReports.pageKey,
      context: bugReports.context,
    })
    .from(bugReports)
    .where(eq(bugReports.id, id));
  if (!row) return null;
  const index = await getLocatorIndex(db, row.projectId).catch(() => null);
  const missed = computeMissedBy(index, {
    steps: row.steps as PiwiSteps,
    pageKey: row.pageKey,
    pathPrefix: (row.context as BugContext | null)?.pathPrefix ?? null,
    testPathPrefix: (row.context as BugContext | null)?.testPathPrefix ?? null,
  });
  return { ...missed, summary: describeMissedBy(missed) };
}
