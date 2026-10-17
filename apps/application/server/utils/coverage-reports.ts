/**
 * Coverage reports: one suite's coverage of one commit, from another tool's
 * report (Vitest, coverlet, Microsoft code coverage) that `piwi coverage
 * upload` read into Piwi's model, attributed to no test.
 *
 * - `coverage_reports`: one row per project, commit and suite. Reports of the
 *   same commit and suite merge, like shards: per file, the union of the lines
 *   and functions when the file version agrees, the newer version otherwise,
 *   which marks the report incomplete.
 * - `coverage_report_files`: per file of a report, its fragment, a
 *   `coverage_fragments` row under the runtime `report` holding the file's
 *   version, its executable lines, the lines and functions that ran and every
 *   function the tool knows. Two commits whose file did not change and ran the
 *   same lines share one.
 * - The commit's file inventory (the tracked files and their blobs) is a
 *   `case_payloads` row of the report, `[[path, blob], ...]` sorted by path.
 *
 * A branch's reports go with its other coverage rows (its pull request closed,
 * or thirty days without a report); on the default branch, the newest commit
 * and the last commit of each day of the past ninety days are kept.
 */
import { and, desc, eq, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  decodeFunctionRanges,
  decodeLineRanges,
  normalizeCoveragePath,
  normalizeFunctionRanges,
  normalizeLineRanges,
  MAX_COVERAGE_RANGES,
  type LineRange,
} from '@piwitests/core/coverage';
import { coverageFragments, coverageReportFiles, coverageReports, coverageTotals, projects } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { locatorBranchTag } from './locator-usages';
import { resolveCasePayloadContents, upsertCasePayloads } from './case-payloads';
import { REPORT_RUNTIME, upsertFragmentRows, withCoverageLock } from './coverage';
import { COMBINED_SUITE, E2E_SUITE } from '#shared/coverage-combine';
import { projectDefaultBranch } from './scm/stored-default-branch';

/** Files one upload carries at most. */
export const MAX_REPORT_FILES = 20_000;
/** Largest upload body read. */
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
/** Inventory entries one upload carries at most. */
export const MAX_INVENTORY_FILES = 100_000;
/** Inventory entries a report keeps at most, across its parts. */
const MAX_STORED_INVENTORY = 500_000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A branch's reports outlive its last one by at most thirty days, like its other coverage rows. */
const BRANCH_REPORT_MAX_AGE_MS = 30 * DAY_MS;
/** The default branch keeps one commit per day for ninety days. */
const DEFAULT_BRANCH_DAYS = 90;
const ROW_CHUNK = 200;
const ID_CHUNK = 500;

const COMMIT = /^[0-9a-f]{7,64}$/;
const BLOB_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A suite name: a letter or digit, then up to 63 letters, digits, `.`, `_` or `-`. */
const SUITE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The suite names totals use: the Playwright suite Piwi records, and every suite together. */
const RESERVED_SUITES = new Set([E2E_SUITE, COMBINED_SUITE]);

/** What a suite's tests are: unit tests, or an end-to-end suite (the Playwright suite Piwi records, a backend's run). */
export type CoverageSuiteKind = 'unit' | 'e2e';

/** One file of an upload, repository-relative, with its version and line ranges. */
export interface ReportFileUpload {
  path: string;
  blob?: string;
  /** Every line the tool can mark as run. */
  executable: LineRange[];
  /** The lines that ran. */
  lines: LineRange[];
  /** The functions that ran. */
  functions: LineRange[];
  /** Every function the tool knows, run or not. */
  allFunctions: LineRange[];
}

/** An upload, checked: `POST /api/projects/:id/coverage-reports`. */
export interface CoverageReportUpload {
  commit: string;
  branch: string | null;
  suite: string;
  kind: CoverageSuiteKind;
  tool: string | null;
  /** The commit's tracked files in the project's scope and their blobs; null when the upload names none. */
  inventory: Array<[path: string, blob: string]> | null;
  files: ReportFileUpload[];
  /** The uploader left part of the report out (a path that matched no file, a cap). */
  incomplete: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ranges of untrusted input, or none past the cap on a file's ranges, which `dropped` then records. */
function capped(ranges: LineRange[], dropped: { any: boolean }): LineRange[] {
  if (ranges.length <= MAX_COVERAGE_RANGES) return ranges;
  dropped.any = true;
  return [];
}

function shortText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
}

/**
 * An upload body checked: `{ v: 1, commit, branch?, suite, kind?, tool?,
 * inventory?, incomplete?, files }`. Paths are cleaned as a test's coverage
 * paths are, ranges normalized, a file's ranges of one kind past 10,000
 * dropped (the upload is then incomplete), a file named twice merged. A file
 * needs executable lines or a function list; one with neither is dropped. An
 * error message when the body is not one.
 */
export function parseCoverageReportUpload(body: unknown): CoverageReportUpload | string {
  if (!isRecord(body) || body.v !== 1) return 'Expected { "v": 1, "commit", "suite", "files": [...] }';
  const commit = typeof body.commit === 'string' ? body.commit.trim().toLowerCase() : '';
  if (!COMMIT.test(commit)) return 'commit must be a git commit id (7 to 64 hexadecimal characters)';
  const suite = typeof body.suite === 'string' ? body.suite.trim() : '';
  if (!SUITE.test(suite))
    return 'suite must be 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit';
  if (RESERVED_SUITES.has(suite.toLowerCase())) {
    return `suite "${suite}" is reserved: "e2e" is the Playwright suite Piwi records, "combined" every suite together`;
  }
  const kind = body.kind === undefined ? 'unit' : body.kind;
  if (kind !== 'unit' && kind !== 'e2e') return 'kind must be "unit" or "e2e"';
  if (!Array.isArray(body.files)) return 'files must be an array';
  if (body.files.length > MAX_REPORT_FILES) return `At most ${MAX_REPORT_FILES} files per request`;

  let inventory: CoverageReportUpload['inventory'] = null;
  if (body.inventory !== undefined && body.inventory !== null) {
    if (!Array.isArray(body.inventory)) return 'inventory must be an array of [path, blob] pairs';
    if (body.inventory.length > MAX_INVENTORY_FILES)
      return `At most ${MAX_INVENTORY_FILES} inventory files per request`;
    const byPath = new Map<string, string>();
    for (const entry of body.inventory) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const path = normalizeCoveragePath(entry[0]);
      const blob = typeof entry[1] === 'string' ? entry[1].toLowerCase() : '';
      if (path !== null && BLOB_ID.test(blob)) byPath.set(path, blob);
    }
    inventory = [...byPath].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  const files = new Map<string, ReportFileUpload>();
  const dropped = { any: false };
  for (const item of body.files) {
    if (!isRecord(item)) continue;
    const path = normalizeCoveragePath(item.path);
    if (path === null) continue;
    const file: ReportFileUpload = {
      path,
      ...(typeof item.blob === 'string' && BLOB_ID.test(item.blob.toLowerCase())
        ? { blob: item.blob.toLowerCase() }
        : {}),
      executable: capped(normalizeLineRanges(item.executable), dropped),
      lines: capped(normalizeLineRanges(item.lines), dropped),
      functions: capped(normalizeFunctionRanges(item.functions), dropped),
      allFunctions: capped(normalizeFunctionRanges(item.allFunctions), dropped),
    };
    if (file.executable.length === 0 && file.allFunctions.length === 0) continue;
    const known = files.get(path);
    files.set(path, known && known.blob === file.blob ? mergeFiles(known, file) : file);
  }

  return {
    commit,
    branch: shortText(body.branch, 255),
    suite,
    kind,
    tool: shortText(body.tool, 64),
    inventory,
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    incomplete: body.incomplete === true || dropped.any,
  };
}

/** Two entries of one file version, united. */
function mergeFiles(a: ReportFileUpload, b: ReportFileUpload): ReportFileUpload {
  return {
    path: a.path,
    ...(a.blob ? { blob: a.blob } : {}),
    executable: normalizeLineRanges([...a.executable, ...b.executable]),
    lines: normalizeLineRanges([...a.lines, ...b.lines]),
    functions: normalizeFunctionRanges([...a.functions, ...b.functions]),
    allFunctions: normalizeFunctionRanges([...a.allFunctions, ...b.allFunctions]),
  };
}

/** A stored report, as listings answer it. */
export interface CoverageReportSummary {
  id: number;
  commit: string;
  /** The branch it ran on; null for the project's default branch. */
  branch: string | null;
  suite: string;
  kind: CoverageSuiteKind;
  tool: string | null;
  incomplete: boolean;
  files: number;
  /** How many tracked files its commit's inventory names; null without one. */
  inventoryFiles: number | null;
  createdAt: string;
  updatedAt: string;
}

const reportLocks = new Map<string, Promise<unknown>>();

/** The inventory of a payload, `[[path, blob], ...]`; empty when it is not one. */
function parseInventory(content: string | null | undefined): Array<[string, string]> {
  if (!content) return [];
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string',
    );
  } catch {
    return [];
  }
}

/** A report's files as stored: per path, the fragment's version and ranges. */
async function loadReportFiles(
  db: DrizzleDB,
  reportId: number,
  paths?: string[],
): Promise<Map<string, ReportFileUpload>> {
  const out = new Map<string, ReportFileUpload>();
  const read = async (where: SQL) => {
    const rows = await db
      .select({
        path: coverageReportFiles.path,
        blob: coverageFragments.blob,
        executable: coverageFragments.executable,
        lines: coverageFragments.lines,
        functions: coverageFragments.functions,
        allFunctions: coverageFragments.allFunctions,
      })
      .from(coverageReportFiles)
      .innerJoin(coverageFragments, eq(coverageFragments.id, coverageReportFiles.fragmentId))
      .where(where);
    for (const row of rows) {
      out.set(row.path, {
        path: row.path,
        ...(row.blob ? { blob: row.blob } : {}),
        executable: decodeLineRanges(row.executable),
        lines: decodeLineRanges(row.lines),
        functions: decodeFunctionRanges(row.functions),
        allFunctions: decodeFunctionRanges(row.allFunctions),
      });
    }
  };
  if (!paths) {
    await read(eq(coverageReportFiles.reportId, reportId));
  } else {
    for (let i = 0; i < paths.length; i += ID_CHUNK) {
      await read(
        and(
          eq(coverageReportFiles.reportId, reportId),
          inArray(coverageReportFiles.path, paths.slice(i, i + ID_CHUNK)),
        )!,
      );
    }
  }
  return out;
}

/** The files of reports, by report id: each file's version and ranges. */
export async function getReportFiles(db: DrizzleDB, reportIds: number[]): Promise<Map<number, ReportFileUpload[]>> {
  const out = new Map<number, ReportFileUpload[]>();
  for (const id of [...new Set(reportIds)]) {
    out.set(
      id,
      [...(await loadReportFiles(db, id)).values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    );
  }
  return out;
}

/** The inventory of reports, by report id; a report without one is left out. */
export async function getReportInventories(
  db: DrizzleDB,
  reports: Array<{ id: number; inventoryPayloadId: number | null }>,
): Promise<Map<number, Array<[string, string]>>> {
  const withInventory = reports.filter((r) => r.inventoryPayloadId != null);
  const contents = await resolveCasePayloadContents(
    db,
    withInventory.map((r) => r.inventoryPayloadId),
  );
  return new Map(withInventory.map((r) => [r.id, parseInventory(contents.get(r.inventoryPayloadId!))]));
}

function summaryOf(row: typeof coverageReports.$inferSelect): CoverageReportSummary {
  return {
    id: row.id,
    commit: row.commit,
    branch: row.branch || null,
    suite: row.suite,
    kind: row.kind === 'e2e' ? 'e2e' : 'unit',
    tool: row.tool,
    incomplete: !!row.incomplete,
    files: row.fileCount,
    inventoryFiles: row.inventoryPayloadId == null ? null : row.inventoryCount,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** The error `storeCoverageReport` throws for a project that does not exist. */
export const PROJECT_NOT_FOUND = 'Project not found';

/**
 * Store an upload into its commit and suite's report, merging it with what the
 * report already holds: per file, the union of both when the version agrees,
 * the upload's otherwise (the report is then incomplete). The inventory is the
 * union of the parts'. A commit any part of which ran on the default branch is
 * the default branch's, every one of its reports with it. The merge runs in
 * one transaction holding the report's row, so parts arriving at two servers
 * at once both count. Returns the report and how many of the upload's files
 * were stored; throws {@link PROJECT_NOT_FOUND} for a project that does not
 * exist.
 */
export async function storeCoverageReport(
  db: DrizzleDB,
  projectId: number,
  upload: CoverageReportUpload,
): Promise<{ report: CoverageReportSummary; stored: number }> {
  const key = `${projectId}\x00${upload.commit}\x00${upload.suite}`;
  return withCoverageLock(reportLocks, key, async () => {
    const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error(PROJECT_NOT_FOUND);
    const tag = upload.branch ? locatorBranchTag(upload.branch, await projectDefaultBranch(db, projectId)) : '';
    const now = new Date();
    const ofReport = and(
      eq(coverageReports.projectId, projectId),
      eq(coverageReports.commit, upload.commit),
      eq(coverageReports.suite, upload.suite),
    )!;
    return db.transaction(async (tx) => {
      await tx
        .insert(coverageReports)
        .values({
          projectId,
          commit: upload.commit,
          branch: tag,
          suite: upload.suite,
          kind: upload.kind,
          tool: upload.tool,
          incomplete: upload.incomplete,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [coverageReports.projectId, coverageReports.commit, coverageReports.suite] });
      // Writing the row first holds it until the merge commits: another part of the report waits for this one.
      const [report] = await tx.update(coverageReports).set({ updatedAt: now }).where(ofReport).returning();
      const reportId = report!.id;

      let incomplete = upload.incomplete || !!report!.incomplete;
      const stored = await loadReportFiles(
        tx,
        reportId,
        upload.files.map((f) => f.path),
      );
      const merged = upload.files.map((file) => {
        const known = stored.get(file.path);
        if (!known) return file;
        if (known.blob === file.blob) return mergeFiles(known, file);
        incomplete = true;
        return file;
      });
      const { hashes, ids } = await upsertFragmentRows(
        tx,
        projectId,
        merged.map((file) => ({ ...file, runtime: REPORT_RUNTIME })),
      );
      const rows = merged.flatMap((file, i) => {
        const fragment = ids.get(hashes[i]!);
        return fragment ? [{ reportId, path: file.path, fragmentId: fragment.id }] : [];
      });
      for (let i = 0; i < rows.length; i += ROW_CHUNK) {
        await tx
          .insert(coverageReportFiles)
          .values(rows.slice(i, i + ROW_CHUNK))
          .onConflictDoUpdate({
            target: [coverageReportFiles.reportId, coverageReportFiles.path],
            set: { fragmentId: sql`excluded.fragment_id` },
          });
      }

      let inventoryPayloadId = report!.inventoryPayloadId;
      let inventoryCount = report!.inventoryCount;
      if (upload.inventory) {
        const byPath = new Map(
          inventoryPayloadId == null
            ? []
            : parseInventory((await resolveCasePayloadContents(tx, [inventoryPayloadId])).get(inventoryPayloadId)),
        );
        for (const [path, blob] of upload.inventory) byPath.set(path, blob);
        if (byPath.size > MAX_STORED_INVENTORY) incomplete = true;
        const content = JSON.stringify(
          [...byPath].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, MAX_STORED_INVENTORY),
        );
        inventoryPayloadId = (await upsertCasePayloads(tx, projectId, [content])).get(content) ?? inventoryPayloadId;
        inventoryCount = Math.min(byPath.size, MAX_STORED_INVENTORY);
      } else if (inventoryPayloadId != null && inventoryCount == null) {
        inventoryCount = await countInventory(tx, inventoryPayloadId);
      }

      const onDefaultBranch =
        tag === '' ||
        report!.branch === '' ||
        (
          await tx
            .select({ id: coverageReports.id })
            .from(coverageReports)
            .where(
              and(
                eq(coverageReports.projectId, projectId),
                eq(coverageReports.commit, upload.commit),
                eq(coverageReports.branch, ''),
              ),
            )
            .limit(1)
        ).length > 0;
      if (onDefaultBranch) {
        await tx
          .update(coverageReports)
          .set({ branch: '' })
          .where(
            and(
              eq(coverageReports.projectId, projectId),
              eq(coverageReports.commit, upload.commit),
              ne(coverageReports.branch, ''),
            ),
          );
      }

      const [counted] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(coverageReportFiles)
        .where(eq(coverageReportFiles.reportId, reportId));
      const [updated] = await tx
        .update(coverageReports)
        .set({
          branch: onDefaultBranch ? '' : report!.branch || tag,
          kind: upload.kind,
          tool: upload.tool ?? report!.tool,
          incomplete,
          fileCount: Number(counted?.n ?? 0),
          inventoryPayloadId,
          inventoryCount,
          updatedAt: now,
        })
        .where(eq(coverageReports.id, reportId))
        .returning();
      return { report: summaryOf(updated!), stored: rows.length };
    });
  });
}

/** How many files a stored inventory names. */
async function countInventory(db: DrizzleDB, payloadId: number): Promise<number> {
  return parseInventory((await resolveCasePayloadContents(db, [payloadId])).get(payloadId)).length;
}

/** The reports of a project, newest first: of one commit, or the latest `limit` (50 by default, 500 at most). */
export async function listCoverageReports(
  db: DrizzleDB,
  projectId: number,
  opts: { commit?: string | null; limit?: number } = {},
): Promise<CoverageReportSummary[]> {
  const where = opts.commit
    ? and(eq(coverageReports.projectId, projectId), eq(coverageReports.commit, opts.commit))
    : eq(coverageReports.projectId, projectId);
  const rows = await db
    .select()
    .from(coverageReports)
    .where(where)
    .orderBy(desc(coverageReports.updatedAt), desc(coverageReports.id))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  // A report whose inventory has no count yet is counted once, here, and keeps the count.
  for (const row of rows) {
    if (row.inventoryPayloadId == null || row.inventoryCount != null) continue;
    row.inventoryCount = await countInventory(db, row.inventoryPayloadId);
    await db.update(coverageReports).set({ inventoryCount: row.inventoryCount }).where(eq(coverageReports.id, row.id));
  }
  return rows.map(summaryOf);
}

/**
 * Prune coverage reports: a branch's last updated more than thirty days ago;
 * on the default branch, every commit but the newest and the last commit of
 * each UTC day within ninety days. A commit's totals go after the same thirty
 * or ninety days; the daily totals stay. Returns how many reports went.
 */
export async function pruneCoverageReports(db: DrizzleDB, now: Date = new Date()): Promise<number> {
  const branches = await db
    .delete(coverageReports)
    .where(
      and(
        ne(coverageReports.branch, ''),
        lt(coverageReports.updatedAt, new Date(now.getTime() - BRANCH_REPORT_MAX_AGE_MS)),
      ),
    )
    .returning({ id: coverageReports.id });

  const rows = await db
    .select({
      id: coverageReports.id,
      projectId: coverageReports.projectId,
      commit: coverageReports.commit,
      updatedAt: coverageReports.updatedAt,
    })
    .from(coverageReports)
    .where(eq(coverageReports.branch, ''));
  // A commit's time is that of its newest report.
  const commits = new Map<string, { projectId: number; commit: string; at: number; ids: number[] }>();
  for (const row of rows) {
    const key = `${row.projectId}\x00${row.commit}`;
    const at = new Date(row.updatedAt).getTime();
    const known = commits.get(key);
    if (known) {
      known.at = Math.max(known.at, at);
      known.ids.push(row.id);
    } else {
      commits.set(key, { projectId: row.projectId, commit: row.commit, at, ids: [row.id] });
    }
  }
  const keep = new Set<string>();
  const newest = new Map<number, { key: string; at: number }>();
  const lastOfDay = new Map<string, { key: string; at: number }>();
  const horizon = now.getTime() - DEFAULT_BRANCH_DAYS * DAY_MS;
  for (const [key, c] of commits) {
    const top = newest.get(c.projectId);
    if (!top || c.at > top.at) newest.set(c.projectId, { key, at: c.at });
    if (c.at < horizon) continue;
    const day = `${c.projectId}\x00${Math.floor(c.at / DAY_MS)}`;
    const last = lastOfDay.get(day);
    if (!last || c.at > last.at) lastOfDay.set(day, { key, at: c.at });
  }
  for (const { key } of newest.values()) keep.add(key);
  for (const { key } of lastOfDay.values()) keep.add(key);
  const stale = [...commits].flatMap(([key, c]) => (keep.has(key) ? [] : c.ids));
  for (let i = 0; i < stale.length; i += ID_CHUNK) {
    await db.delete(coverageReports).where(inArray(coverageReports.id, stale.slice(i, i + ID_CHUNK)));
  }
  await db
    .delete(coverageTotals)
    .where(
      or(
        and(
          ne(coverageTotals.branch, ''),
          lt(coverageTotals.computedAt, new Date(now.getTime() - BRANCH_REPORT_MAX_AGE_MS)),
        ),
        lt(coverageTotals.computedAt, new Date(horizon)),
      ),
    );
  return branches.length + stale.length;
}

/**
 * The `commit` and `limit` of a listing of coverage reports, checked: a
 * commit is 7 to 64 hexadecimal characters, a limit an integer.
 */
export function parseCoverageReportsQuery(
  commit: unknown,
  limit: unknown,
): { commit: string | null; limit: number | undefined } | { error: string } {
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const rawCommit = typeof first(commit) === 'string' ? (first(commit) as string).trim().toLowerCase() : '';
  if (rawCommit && !COMMIT.test(rawCommit)) return { error: 'commit must be 7 to 64 hexadecimal characters' };
  const rawLimit = typeof first(limit) === 'string' ? (first(limit) as string).trim() : '';
  if (!rawLimit) return { commit: rawCommit || null, limit: undefined };
  const n = Number(rawLimit);
  if (!Number.isInteger(n)) return { error: 'Invalid query parameter "limit": expected an integer' };
  return { commit: rawCommit || null, limit: n };
}
