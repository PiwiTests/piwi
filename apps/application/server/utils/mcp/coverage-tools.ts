/**
 * The coverage tools of the MCP server (`get_coverage`, `compare_coverage`,
 * `get_coverage_loss`, `get_coverage_summary`) and the coverage summary the quarantine tools add to
 * their answers. They answer from `#shared/handlers/coverage-insights` and
 * the coverage reads in `server/utils/coverage.ts`, with line ranges written
 * as `12-15,20` and empty fields left out. A project that recorded no
 * coverage gets one sentence saying how to turn it on.
 */
import { desc, eq, inArray } from 'drizzle-orm';
import { encodeLineRanges, type CoverageCapture, type LineRange } from '@piwitests/core/coverage';
import { sameFilePath } from '@piwitests/core/locator-break';
import {
  compactFileCoverage,
  nearestTest,
  noCoverageSentence,
  parseLossTestIds,
  parseTargetLines,
  type CoverageLossAnswer,
} from '#shared/coverage-insights';
import {
  getCoverageDivergence,
  getCoverageLoss,
  getCoverageReach,
  getPathVariation,
  latestCoveredExecutionId,
  projectRecordsCoverage,
  resolveTestByTitle,
} from '#shared/handlers/coverage-insights';
import { testRunsCases } from '../../database/schema';
import type { DbClient } from '../../database';
import { getExecutionsCoverage, getFileCoverage } from '../coverage';
import { getCoverageSummary, parseCoverageSummaryQuery } from '../coverage-summary';
import { resolveCaseProjectId, resolveTestRunCaseProjectId, scopeAllows } from '../project-access';
import type { McpContext, McpToolHandler } from './tools';

/** Files an execution's coverage lists, at most. */
const MAX_EXECUTION_FILES = 200;

/** Tests per project whose unique coverage a quarantine answer reads, and projects, at most. */
const QUARANTINE_SUMMARY_TESTS = 50;
const QUARANTINE_SUMMARY_PROJECTS = 5;

/** Files a quarantine answer's coverage summary names, at most. */
const QUARANTINE_SUMMARY_FILES = 5;

function isRange(value: unknown): value is LineRange {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number');
}

/**
 * An answer shaped for an agent: lists of line ranges written as `12-15,20`,
 * and `null`, `''`, empty lists and empty objects left out, at every depth.
 */
export function compactCoverageJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isRange)) return encodeLineRanges(value);
    return value.map(compactCoverageJson);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const compact = compactCoverageJson(entry);
      if (compact == null || compact === '') continue;
      if (Array.isArray(compact) && compact.length === 0) continue;
      out[key] = compact;
    }
    return out;
  }
  return value;
}

function positiveId(raw: unknown, name: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid ${name}: must be a positive integer`);
  return id;
}

function assertInScope(ctx: McpContext, projectId: number): void {
  if (!scopeAllows(ctx.scope, projectId)) throw new Error(`No access to project ${projectId}`);
}

/** The project of an entity the caller can read; null when there is no such entity. */
async function scopedProject(
  db: DbClient,
  ctx: McpContext,
  id: number,
  resolve: (db: DbClient, id: number) => Promise<number | null>,
): Promise<number | null> {
  const projectId = await resolve(db, id);
  if (projectId == null) return null;
  assertInScope(ctx, projectId);
  return projectId;
}

/** An execution's files: with `file`, that file's ranges; else per file its granularity and counts. */
function executionFiles(capture: CoverageCapture, file: string | null) {
  const files = file ? capture.files.filter((f) => sameFilePath(f.path, file)) : capture.files;
  const shown = files.slice(0, MAX_EXECUTION_FILES).map((f) =>
    file
      ? { path: f.path, runtime: f.runtime, blob: f.blob, lines: f.lines, functions: f.functions }
      : {
          path: f.path,
          runtime: f.runtime,
          lines: f.lines ? f.lines.reduce((n, [s, e]) => n + e - s + 1, 0) : null,
          functions: f.functions?.length ?? null,
        },
  );
  return { files: shown, moreFiles: files.length - shown.length || null };
}

/** `get_coverage` with an execution: the execution, or the test whose latest execution with coverage is read. */
async function executionCoverage(
  db: DbClient,
  projectId: number,
  target: { executionId: number } | { testCaseId: number },
  file: string | null,
  lines: LineRange[] | null,
) {
  if ('testCaseId' in target && file && lines) {
    return getCoverageReach(db, target.testCaseId, { file, lines });
  }
  if ('executionId' in target && file && lines) {
    const [row] = await db
      .select({ testCaseId: testRunsCases.testCaseId })
      .from(testRunsCases)
      .where(eq(testRunsCases.id, target.executionId));
    if (!row) return null;
    return getCoverageReach(db, row.testCaseId, { file, lines, executionId: target.executionId });
  }
  const executionId =
    'executionId' in target ? target.executionId : await latestCoveredExecutionId(db, target.testCaseId);
  if (executionId == null) {
    return { available: false, reason: 'no-coverage', testCaseId: (target as { testCaseId: number }).testCaseId };
  }
  const capture = (await getExecutionsCoverage(db, [executionId], file ? { rangesFor: [file] } : {})).get(executionId);
  if (!capture) return null;
  return {
    projectId,
    executionId,
    incomplete: capture.incomplete ?? null,
    fileCount: capture.files.length,
    ...executionFiles(capture, file),
  };
}

const getCoverage: McpToolHandler = async (db, params, ctx) => {
  const file = typeof params.file === 'string' && params.file.trim() ? params.file.trim() : null;
  if (file && file.length > 500) throw new Error('file is at most 500 characters');
  const lines = params.lines != null ? parseTargetLines(params.lines) : null;
  if (params.lines != null && !lines) throw new Error('lines must be 1-based line ranges, such as "57-59,63"');

  let projectId: number | null;
  let target: { executionId: number } | { testCaseId: number } | null = null;
  if (params.executionId != null) {
    const executionId = positiveId(params.executionId, 'executionId');
    projectId = await scopedProject(db, ctx, executionId, resolveTestRunCaseProjectId);
    target = { executionId };
  } else if (params.testCaseId != null) {
    const testCaseId = positiveId(params.testCaseId, 'testCaseId');
    projectId = await scopedProject(db, ctx, testCaseId, resolveCaseProjectId);
    target = { testCaseId };
  } else if (params.testFile != null || params.testTitle != null) {
    if (typeof params.testFile !== 'string' || typeof params.testTitle !== 'string' || params.projectId == null) {
      throw new Error('Pass projectId, testFile and testTitle together');
    }
    projectId = positiveId(params.projectId, 'projectId');
    assertInScope(ctx, projectId);
    const testCaseId = await resolveTestByTitle(db, projectId, params.testFile.trim(), params.testTitle.trim());
    if (testCaseId == null) return null;
    target = { testCaseId };
  } else if (params.projectId != null && file) {
    projectId = positiveId(params.projectId, 'projectId');
    assertInScope(ctx, projectId);
  } else {
    throw new Error(
      'Pass projectId and file, or an execution: executionId, testCaseId, or projectId with testFile and testTitle',
    );
  }
  if (projectId == null) return null;
  if (!(await projectRecordsCoverage(db, projectId))) return noCoverageSentence(projectId);

  if (target) return compactCoverageJson(await executionCoverage(db, projectId, target, file, lines));
  const branch = typeof params.branch === 'string' && params.branch.trim() ? params.branch.trim() : null;
  const view = await getFileCoverage(db, projectId, file!, branch);
  return compactCoverageJson({
    ...compactFileCoverage(view),
    ...(lines ? { nearest: nearestTest(view, lines) } : {}),
  });
};

const compareCoverage: McpToolHandler = async (db, params, ctx) => {
  if ((params.executionId == null) === (params.testCaseId == null)) {
    throw new Error('Pass executionId or testCaseId (one of them)');
  }
  if (params.executionId != null) {
    const executionId = positiveId(params.executionId, 'executionId');
    const projectId = await scopedProject(db, ctx, executionId, resolveTestRunCaseProjectId);
    if (projectId == null) return null;
    if (!(await projectRecordsCoverage(db, projectId))) return noCoverageSentence(projectId);
    return compactCoverageJson(await getCoverageDivergence(db, executionId));
  }
  const testCaseId = positiveId(params.testCaseId, 'testCaseId');
  const projectId = await scopedProject(db, ctx, testCaseId, resolveCaseProjectId);
  if (projectId == null) return null;
  if (!(await projectRecordsCoverage(db, projectId))) return noCoverageSentence(projectId);
  return compactCoverageJson(await getPathVariation(db, testCaseId));
};

const getCoverageLossTool: McpToolHandler = async (db, params, ctx) => {
  const projectId = positiveId(params.projectId, 'projectId');
  const testCaseIds = parseLossTestIds(params.testCaseIds);
  if (!testCaseIds) throw new Error('testCaseIds must list 1 to 50 test case ids');
  assertInScope(ctx, projectId);
  if (!(await projectRecordsCoverage(db, projectId))) return noCoverageSentence(projectId);
  return compactCoverageJson(await getCoverageLoss(db, projectId, testCaseIds));
};

const getCoverageSummaryTool: McpToolHandler = async (db, params, ctx) => {
  const projectId = positiveId(params.projectId, 'projectId');
  assertInScope(ctx, projectId);
  const query = parseCoverageSummaryQuery(params.commit, params.branch, params.folder);
  if ('error' in query) throw new Error(query.error);
  const summary = await getCoverageSummary(db, projectId, query);
  if (!summary) {
    return `No combined coverage for project ${projectId}${query.commit ? ` at ${query.commit}` : ''}: upload a suite's coverage report with \`piwi coverage upload\`, or record run coverage with the reporter's coverage options.`;
  }
  return compactCoverageJson(summary);
};

export const COVERAGE_TOOL_HANDLERS = {
  get_coverage: getCoverage,
  compare_coverage: compareCoverage,
  get_coverage_loss: getCoverageLossTool,
  get_coverage_summary: getCoverageSummaryTool,
} satisfies Record<'get_coverage' | 'compare_coverage' | 'get_coverage_loss' | 'get_coverage_summary', McpToolHandler>;

/** A coverage loss as a quarantine answer carries it: the counts and the worst few files. */
function lossSummary(loss: CoverageLossAnswer) {
  const { summary } = loss;
  const named = loss.files.filter((f) => f.status !== 'uncertain').slice(0, QUARANTINE_SUMMARY_FILES);
  return compactCoverageJson({
    projectId: loss.projectId,
    files: summary.files,
    filesOnlyThese: summary.filesOnlyThese,
    filesOnlyFlaky: summary.filesOnlyFlaky,
    filesUncertain: summary.filesUncertain,
    lines: summary.lines,
    functions: summary.functions,
    onlyFlakyLines: summary.onlyFlakyLines,
    worst: named.map((f) => ({ path: f.path, runtime: f.runtime, status: f.status, lines: f.lines })),
  });
}

/**
 * The code only the given tests run among the other non-quarantined tests,
 * summarized for a quarantine or release answer; null when the project
 * records no coverage or the tests have none.
 */
export async function uniqueCoverageSummary(
  db: DbClient,
  projectId: number,
  testCaseIds: number[],
): Promise<unknown | null> {
  try {
    if (!(await projectRecordsCoverage(db, projectId))) return null;
    const loss = await getCoverageLoss(db, projectId, testCaseIds.slice(0, QUARANTINE_SUMMARY_TESTS));
    return loss?.available ? lossSummary(loss) : null;
  } catch (error) {
    console.warn('[mcp] unique coverage of a quarantine answer failed', error);
    return null;
  }
}

/** {@link uniqueCoverageSummary} for the tests that failed in failure clusters, per project. */
export async function clusterTestsUniqueCoverage(
  db: DbClient,
  clusters: Array<{ id: number; projectId: number }>,
): Promise<unknown[]> {
  const projects = new Map<number, number[]>();
  for (const c of clusters) projects.set(c.projectId, [...(projects.get(c.projectId) ?? []), c.id]);
  const out: unknown[] = [];
  for (const [projectId, clusterIds] of [...projects].slice(0, QUARANTINE_SUMMARY_PROJECTS)) {
    const rows = await db
      .selectDistinct({ testCaseId: testRunsCases.testCaseId })
      .from(testRunsCases)
      .where(inArray(testRunsCases.failureClusterId, clusterIds))
      .orderBy(desc(testRunsCases.testCaseId))
      .limit(QUARANTINE_SUMMARY_TESTS);
    const summary = await uniqueCoverageSummary(
      db,
      projectId,
      rows.map((r) => r.testCaseId),
    );
    if (summary) out.push(summary);
  }
  return out;
}
