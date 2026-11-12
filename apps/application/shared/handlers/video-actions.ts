/**
 * The actions of one execution for the marks under the Video tab's player. Served by
 * `GET /api/test-run-cases/:id/video-actions` and its demo mirror. The server hands in a reader of the stored trace;
 * without one, or when the trace holds no usable actions, the stored steps are read.
 */
import { eq } from 'drizzle-orm';
import { testRunsCases } from '../../server/database/schema';
import { actionsFromSteps, timeActions, type RawAction, type VideoActionsResponse } from '../video-actions';
import { createPageEndMs, type TimingStep } from '../video-reel';
import type { DrizzleDB } from './db';

/** Reads the actions of the execution's stored trace; null when it has none or cannot be read. */
export type TraceActionReader = () => Promise<RawAction[] | null>;

const NONE: VideoActionsResponse = { source: 'none', timing: null, actions: [], total: 0, capped: false };

export async function getVideoActions(
  db: DrizzleDB,
  executionId: number,
  readTrace?: TraceActionReader,
): Promise<VideoActionsResponse> {
  const [row] = await db
    .select({ startedAt: testRunsCases.startedAt, durationMs: testRunsCases.duration, steps: testRunsCases.steps })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, executionId))
    .limit(1);
  if (!row) return NONE;
  const steps = Array.isArray(row.steps) ? row.steps : null;
  const timing = {
    startedAtMs: row.startedAt ?? null,
    durationMs: row.durationMs ?? null,
    createPageEndMs: createPageEndMs(steps as TimingStep[] | null),
  };

  const sources: Array<['trace' | 'steps', () => Promise<RawAction[] | null>]> = [];
  if (readTrace) sources.push(['trace', readTrace]);
  sources.push(['steps', async () => actionsFromSteps(steps)]);
  for (const [source, read] of sources) {
    let raw: RawAction[] | null = null;
    try {
      raw = await read();
    } catch {
      raw = null;
    }
    if (!raw || raw.length === 0) continue;
    const timed = timeActions(raw, timing);
    return timed ? { source, ...timed } : NONE;
  }
  return NONE;
}
