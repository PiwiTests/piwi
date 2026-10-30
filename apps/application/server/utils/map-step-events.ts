import { hideTypedStepTitle } from '@piwitests/core/step-analysis';
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
