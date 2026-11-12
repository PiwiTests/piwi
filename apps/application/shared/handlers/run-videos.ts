/**
 * A run's executions for the Video tab: each final attempt with its recorded video, when it has one. Served by
 * `GET /api/test-runs/:id/videos` and its demo mirror.
 */
import { and, asc, count, eq, inArray, like, sql } from 'drizzle-orm';
import { files, testCases, testRunsCases } from '../../server/database/schema';
import {
  MAX_LISTED_EXECUTIONS as MAX_LISTED,
  createPageEndMs,
  type ReelExecution,
  type TimingStep,
} from '../video-reel';
import type { DrizzleDB } from './db';

/** Executions whose steps are read in one query. */
const STEP_BATCH = 400;

export interface RunVideos {
  /** The run's final attempts, by file, line and title. */
  executions: ReelExecution[];
  /** The executions with a video. */
  videoCount: number;
  /** True when the run has more final attempts than the answer lists. */
  truncated: boolean;
}

/** Playwright's own recording attaches under this name; a test can attach other videos under others. */
const PLAYWRIGHT_VIDEO_NAME = 'video';

/**
 * True for an execution with a recorded video: a `video/*` attachment. The Video tab's list and the run payload's
 * `videoCount` both use it, so they cannot disagree. It is one lookup on `idx_files_test_runs_case_id` per execution.
 */
export const executionHasVideo = sql`exists (
  select 1 from ${files}
  where ${files.testRunsCaseId} = ${testRunsCases.id} and ${files.type} = 'attachment' and ${files.label} like 'video/%'
)`;

/** How many of a run's final attempts have a video, however many videos each has. */
export async function countRunVideos(db: DrizzleDB, runId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.testRunId, runId), eq(testRunsCases.finalAttempt, true), executionHasVideo));
  return Number(row?.n ?? 0);
}

export async function getRunVideos(db: DrizzleDB, runId: number): Promise<RunVideos> {
  const hasVideo = executionHasVideo;
  const select = {
    executionId: testRunsCases.id,
    testCaseId: testRunsCases.testCaseId,
    title: testCases.title,
    filePath: testCases.filePath,
    line: testRunsCases.line,
    column: testRunsCases.column,
    status: testRunsCases.status,
    retries: testRunsCases.retries,
    repeatEachIndex: testRunsCases.repeatEachIndex,
    browserName: testRunsCases.browserName,
    passedAfterFailure: testRunsCases.passedAfterFailure,
    shardIndex: testRunsCases.shardIndex,
    parallelIndex: testRunsCases.parallelIndex,
    workerIndex: testRunsCases.workerIndex,
    startedAt: testRunsCases.startedAt,
    durationMs: testRunsCases.duration,
  };
  // The cap applies to the executions with a video and to the rest apart, so a long run cannot push its videos out.
  const finalAttempts = (withVideo: boolean) =>
    db
      .select(select)
      .from(testRunsCases)
      .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
      .where(
        and(
          eq(testRunsCases.testRunId, runId),
          eq(testRunsCases.finalAttempt, true),
          withVideo ? hasVideo : sql`not ${hasVideo}`,
        ),
      )
      .orderBy(asc(testCases.filePath), asc(testRunsCases.line), asc(testRunsCases.column), asc(testRunsCases.id))
      .limit(MAX_LISTED + 1);
  const [withVideoRows, withoutVideoRows] = await Promise.all([finalAttempts(true), finalAttempts(false)]);
  const listed = [...withVideoRows.slice(0, MAX_LISTED), ...withoutVideoRows.slice(0, MAX_LISTED)].sort(byDeclaration);
  const listedIds = new Set(listed.map((r) => r.executionId));

  // One video per execution: Playwright's own, else the earliest attached.
  const videos = new Map<number, { file: NonNullable<ReelExecution['video']>; own: boolean }>();
  if (listed.length > 0) {
    const attached = await db
      .select({
        id: files.id,
        executionId: files.testRunsCaseId,
        name: files.subtype,
        path: files.path,
        contentType: files.label,
        size: files.size,
      })
      .from(files)
      .innerJoin(testRunsCases, eq(testRunsCases.id, files.testRunsCaseId))
      .where(
        and(
          eq(testRunsCases.testRunId, runId),
          eq(testRunsCases.finalAttempt, true),
          eq(files.type, 'attachment'),
          like(files.label, 'video/%'),
        ),
      )
      .orderBy(asc(files.id));
    for (const file of attached) {
      if (file.executionId == null || !listedIds.has(file.executionId)) continue;
      const own = file.name === PLAYWRIGHT_VIDEO_NAME;
      const earlier = videos.get(file.executionId);
      if (earlier && (earlier.own || !own)) continue;
      videos.set(file.executionId, {
        file: { id: file.id, path: file.path, contentType: file.contentType ?? 'video/webm', size: file.size },
        own,
      });
    }
  }

  // The anchor comes from the steps of the executions that have a video and a start time; the rest need none.
  const anchors = new Map<number, number | null>();
  const anchorable = listed.filter((r) => videos.has(r.executionId) && r.startedAt != null).map((r) => r.executionId);
  for (let i = 0; i < anchorable.length; i += STEP_BATCH) {
    const stepRows = await db
      .select({ id: testRunsCases.id, steps: testRunsCases.steps })
      .from(testRunsCases)
      .where(inArray(testRunsCases.id, anchorable.slice(i, i + STEP_BATCH)));
    for (const row of stepRows) {
      anchors.set(row.id, createPageEndMs(Array.isArray(row.steps) ? (row.steps as TimingStep[]) : null));
    }
  }

  return {
    executions: listed.map((r) => ({
      ...r,
      retries: r.retries ?? 0,
      passedAfterFailure: r.passedAfterFailure === true,
      createPageEndMs: anchors.get(r.executionId) ?? null,
      video: videos.get(r.executionId)?.file ?? null,
    })),
    videoCount: videos.size,
    truncated: withVideoRows.length > MAX_LISTED || withoutVideoRows.length > MAX_LISTED,
  };
}

/** The order the spec files declare the tests in: file, line, column. */
function byDeclaration(
  a: { filePath: string; line: number | null; column: number | null; executionId: number },
  b: typeof a,
): number {
  return (
    (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    a.executionId - b.executionId
  );
}
