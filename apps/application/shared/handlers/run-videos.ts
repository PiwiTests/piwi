/**
 * A run's executions for the Video tab: each final attempt with its recorded video, when it has one. Served by
 * `GET /api/test-runs/:id/videos` and its demo mirror.
 */
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { files, testCases, testRunsCases } from '../../server/database/schema';
import { createPageEndMs, type ReelExecution, type TimingStep } from '../video-reel';
import type { DrizzleDB } from './db';

/** Executions one answer lists at most. */
const MAX_LISTED = 2000;
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

export async function getRunVideos(db: DrizzleDB, runId: number): Promise<RunVideos> {
  const rows = await db
    .select({
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
    })
    .from(testRunsCases)
    .innerJoin(testCases, eq(testCases.id, testRunsCases.testCaseId))
    .where(and(eq(testRunsCases.testRunId, runId), eq(testRunsCases.finalAttempt, true)))
    .orderBy(asc(testCases.filePath), asc(testRunsCases.line), asc(testRunsCases.column), asc(testRunsCases.id))
    .limit(MAX_LISTED + 1);
  const listed = rows.slice(0, MAX_LISTED);

  const videos = new Map<number, NonNullable<ReelExecution['video']>>();
  if (listed.length > 0) {
    const attached = await db
      .select({
        id: files.id,
        executionId: files.testRunsCaseId,
        path: files.path,
        contentType: files.label,
        size: files.size,
      })
      .from(files)
      .innerJoin(testRunsCases, eq(testRunsCases.id, files.testRunsCaseId))
      .where(and(eq(testRunsCases.testRunId, runId), eq(files.type, 'attachment'), like(files.label, 'video/%')))
      .orderBy(asc(files.id));
    for (const file of attached) {
      if (file.executionId != null && !videos.has(file.executionId)) {
        videos.set(file.executionId, {
          id: file.id,
          path: file.path,
          contentType: file.contentType ?? 'video/webm',
          size: file.size,
        });
      }
    }
  }

  // The anchor comes from the steps of the executions that have a video; the rest need none.
  const anchors = new Map<number, number | null>();
  const withVideo = listed.map((r) => r.executionId).filter((id) => videos.has(id));
  for (let i = 0; i < withVideo.length; i += STEP_BATCH) {
    const stepRows = await db
      .select({ id: testRunsCases.id, steps: testRunsCases.steps })
      .from(testRunsCases)
      .where(inArray(testRunsCases.id, withVideo.slice(i, i + STEP_BATCH)));
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
      video: videos.get(r.executionId) ?? null,
    })),
    videoCount: withVideo.length,
    truncated: rows.length > MAX_LISTED,
  };
}
