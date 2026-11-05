/**
 * Assembles the `PerfettoRunInput` the trace builder consumes, from the same
 * tables the run and execution pages read. Shared by the server routes and the
 * demo mirror; only the base URL differs.
 */
import { eq, sql } from 'drizzle-orm';
import { testRuns, testCases, testRunsCases, projects, files } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import type {
  PerfettoExecution,
  PerfettoRunInput,
  PerfettoSetupStep,
  PerfettoStep,
  PerfettoStepEvent,
} from '../perfetto/types';

/** Columns the trace needs from an execution row. */
const EXECUTION_COLUMNS = {
  id: testRunsCases.id,
  testRunId: testRunsCases.testRunId,
  testCaseId: testRunsCases.testCaseId,
  status: testRunsCases.status,
  duration: testRunsCases.duration,
  error: testRunsCases.error,
  retries: testRunsCases.retries,
  line: testRunsCases.line,
  column: testRunsCases.column,
  steps: testRunsCases.steps,
  stepEvents: testRunsCases.stepEvents,
  workerIndex: testRunsCases.workerIndex,
  parallelIndex: testRunsCases.parallelIndex,
  shardIndex: testRunsCases.shardIndex,
  startedAt: testRunsCases.startedAt,
  tags: testRunsCases.tags,
  locks: testRunsCases.locks,
  testAnnotations: testRunsCases.testAnnotations,
  title: testCases.title,
  filePath: testCases.filePath,
};

type ExecutionRow = {
  id: number;
  testRunId: number;
  testCaseId: number;
  status: string;
  duration: number | null;
  error: string | null;
  retries: number | null;
  line: number | null;
  column: number | null;
  steps: unknown;
  stepEvents: unknown;
  workerIndex: number | null;
  parallelIndex: number | null;
  shardIndex: number | null;
  startedAt: number | null;
  tags: unknown;
  locks: unknown;
  testAnnotations: unknown;
  title: string | null;
  filePath: string | null;
};

function toExecution(row: ExecutionRow, attachments?: PerfettoExecution['attachments']): PerfettoExecution {
  const location = row.line && row.column ? `${row.filePath}:${row.line}:${row.column}` : (row.filePath ?? undefined);
  return {
    executionId: row.id,
    testCaseId: row.testCaseId,
    title: row.title ?? `Execution ${row.id}`,
    filePath: row.filePath ?? null,
    location,
    status: row.status,
    workerIndex: row.workerIndex,
    parallelIndex: row.parallelIndex,
    shardIndex: row.shardIndex,
    startedAt: row.startedAt,
    duration: row.duration,
    retries: row.retries ?? 0,
    tags: (row.tags as string[] | null) ?? null,
    locks: (row.locks as string[] | null) ?? null,
    annotations: (row.testAnnotations as PerfettoExecution['annotations']) ?? null,
    error: row.error,
    steps: (row.steps as PerfettoStep[] | null) ?? null,
    stepEvents: (row.stepEvents as PerfettoStepEvent[] | null) ?? null,
    attachments: attachments ?? undefined,
  };
}

async function loadRun(db: DrizzleDB, runId: number) {
  const [run] = await db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run) return null;
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId));
  return {
    id: run.id,
    label: run.label ?? null,
    status: run.status ?? null,
    startTime: run.startTime instanceof Date ? run.startTime.getTime() : (run.startTime as number | null),
    duration: run.duration ?? null,
    playwrightVersion: run.playwrightVersion ?? null,
    project: project ? { id: project.id, name: project.name, label: project.label ?? null } : null,
    setupSteps: (run.setupSteps as PerfettoSetupStep[] | null) ?? null,
  };
}

/** The whole run: every execution across its shards and workers. */
export async function collectRunPerfetto(db: DrizzleDB, runId: number): Promise<PerfettoRunInput | null> {
  const run = await loadRun(db, runId);
  if (!run) return null;

  const rows = (await db
    .select(EXECUTION_COLUMNS)
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.testRunId, runId))) as ExecutionRow[];

  const { setupSteps, ...runMeta } = run;
  return {
    run: runMeta,
    executions: rows.map((row) => toExecution(row)),
    setupSteps,
  };
}

/** One execution, with its attachments, as a single-execution run input. */
export async function collectExecutionPerfetto(db: DrizzleDB, executionId: number): Promise<PerfettoRunInput | null> {
  const [row] = (await db
    .select(EXECUTION_COLUMNS)
    .from(testRunsCases)
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.id, executionId))) as ExecutionRow[];
  if (!row) return null;

  const run = await loadRun(db, row.testRunId);
  if (!run) return null;

  const attachmentRows = await db
    .select({ name: files.subtype, contentType: files.label, path: files.path })
    .from(files)
    .where(sql`${files.testRunsCaseId} = ${executionId} AND ${files.type} = 'attachment'`);

  const attachments = attachmentRows.map((a) => ({
    name: a.name ?? a.path ?? 'attachment',
    path: a.path ?? null,
    contentType: a.contentType ?? null,
  }));

  const { setupSteps: _setupSteps, ...runMeta } = run;
  return {
    run: runMeta,
    executions: [toExecution(row, attachments)],
    // A single execution carries its own hooks; the run's suite-level setup
    // steps belong to the whole-run export.
    setupSteps: null,
  };
}
