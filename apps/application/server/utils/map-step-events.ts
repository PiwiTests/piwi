import { hideTypedStepTitle } from '@piwitests/core/step-analysis';
import { liveWorkerKey } from '#shared/live-view';
import type { StreamEventPayload } from '#shared/types';

/**
 * A run-stream event built from a reporter step event. A test-attached step
 * streams as `step-begin` / `step-end`; a suite-level hook (no parent test)
 * publishes as `test-begin` / `test-completed` under the `hooks` file path,
 * the shape the timeline draws hooks from.
 */
export interface StepRunEvent {
  type: 'step-begin' | 'step-end' | 'test-begin' | 'test-completed';
  data: Record<string, unknown>;
}

/**
 * The key a worker's live step is kept under: its shard and its worker, as the live view keys workers. Null for a step
 * with no worker (a suite-level hook).
 */
export function liveStepKey(data: { shardIndex?: unknown; workerIndex?: unknown }): string | null {
  if (typeof data.workerIndex !== 'number') return null;
  const shard = typeof data.shardIndex === 'number' ? data.shardIndex : null;
  return liveWorkerKey({ shard, worker: data.workerIndex });
}

/** The most workers a run keeps a live step for: a run's worker processes, its restarts after failures included. */
export const MAX_KEPT_LIVE_STEPS = 512;

/** Keep a worker's latest step event in `steps`, by `liveStepKey`, for a page that opens the run mid-test. */
export function keepLiveStep(steps: Map<string, StepRunEvent>, event: StepRunEvent): void {
  if (event.type !== 'step-begin' && event.type !== 'step-end') return;
  const key = liveStepKey(event.data);
  if (key === null || (steps.size >= MAX_KEPT_LIVE_STEPS && !steps.has(key))) return;
  steps.set(key, event);
}

/** Drop a worker's kept step once its test completes: the step kept for its worker that is of that test. */
export function forgetCompletedStep(
  steps: Map<string, StepRunEvent> | undefined,
  tc: { title?: unknown; workerIndex?: unknown; shardIndex?: unknown },
): void {
  const key = liveStepKey(tc);
  if (!steps || key === null) return;
  if (steps.get(key)?.data.parentTitle === tc.title) steps.delete(key);
}

/**
 * Map the step events of one streamed batch to the run-stream events to
 * publish, in the order the reporter sent them — the run page shows whichever
 * step event reached a worker last, so a step's end must stay ahead of the
 * next step's begin. Other event types are skipped.
 *
 * Pure, so the live server ingest (`api/test-runs/[id]/events`) and the
 * demo-mode ingest (`app/demo/api/reporter`) share it.
 */
export function mapStepEventsToRunEvents(events: StreamEventPayload[]): StepRunEvent[] {
  const runEvents: StepRunEvent[] = [];
  for (const tc of events) {
    if (tc.type === 'step-begin') runEvents.push(stepBeginRunEvent(tc));
    else if (tc.type === 'step-end') runEvents.push(stepEndRunEvent(tc));
  }
  return runEvents;
}

function stepBeginRunEvent(tc: StreamEventPayload): StepRunEvent {
  if (tc.parentTitle != null) {
    return {
      type: 'step-begin',
      data: {
        title: hideTypedStepTitle(tc.title, tc.stepCategory),
        subtitle: tc.subtitle ?? null,
        parentTitle: tc.parentTitle,
        stepCategory: tc.stepCategory ?? null,
        location: tc.location,
        workerIndex: tc.workerIndex ?? null,
        shardIndex: tc.shardIndex ?? null,
        startedAt: tc.startedAt ?? null,
      },
    };
  }
  return {
    type: 'test-begin',
    data: {
      title: hideTypedStepTitle(tc.title, tc.stepCategory),
      filePath: 'hooks',
      parentTitle: null,
      stepCategory: tc.stepCategory ?? null,
      location: tc.location,
      workerIndex: tc.workerIndex ?? null,
      startedAt: tc.startedAt ?? null,
    },
  };
}

function stepEndRunEvent(tc: StreamEventPayload): StepRunEvent {
  if (tc.parentTitle != null) {
    return {
      type: 'step-end',
      data: {
        title: hideTypedStepTitle(tc.title, tc.stepCategory),
        subtitle: tc.subtitle ?? null,
        parentTitle: tc.parentTitle,
        stepCategory: tc.stepCategory ?? null,
        status: tc.status,
        duration: tc.duration,
        location: tc.location,
        workerIndex: tc.workerIndex ?? null,
        shardIndex: tc.shardIndex ?? null,
        startedAt: tc.startedAt ?? null,
      },
    };
  }
  return {
    type: 'test-completed',
    data: {
      title: hideTypedStepTitle(tc.title, tc.stepCategory),
      filePath: 'hooks',
      parentTitle: null,
      stepCategory: tc.stepCategory ?? null,
      status: tc.status,
      duration: tc.duration,
      location: tc.location,
      workerIndex: tc.workerIndex ?? null,
      startedAt: tc.startedAt ?? null,
    },
  };
}
