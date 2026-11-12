/**
 * Cross-context event bus for demo mode, mirroring the server's runEventBus.
 *
 * In demo mode the API handlers run inside the service worker while the pages
 * that display live run updates run in the window context, so the SSE streams
 * used by the real server are replaced with a BroadcastChannel: the reporter
 * endpoints (app/demo/api/reporter.ts) publish events from the service worker
 * and useRunStream / the test-run detail page subscribe from the main thread.
 *
 * Event payload shapes are identical to the server SSE messages so the
 * subscribing components can share their handling code between modes.
 */
import { dropProjectTestFilters } from '#shared/handlers/analytics/test-filter-memo';
import type { RunProgressBroadcast } from '~~/server/utils/run-events';
import { runProgressThrottle } from '~~/server/utils/run-progress-throttle';

const CHANNEL_NAME = 'piwi-demo-run-events';

/** Per-run event — same shape as the server's RunEvent SSE messages. */
export interface DemoRunEvent {
  type:
    | 'test-begin'
    | 'test-stuck'
    | 'test-stopped'
    | 'test-resumed'
    | 'test-completed'
    | 'step-begin'
    | 'step-end'
    | 'run-progress'
    | 'run-finalizing'
    | 'run-finished'
    | 'resources';
  data: Record<string, unknown>;
}

/** Global lifecycle event — same shape as the server's GlobalRunEvent. */
export interface DemoGlobalEvent {
  type:
    | 'run-started'
    | 'run-initializing'
    | 'run-finalizing'
    | 'run-finished'
    | 'run-submitted'
    | 'run-cancelled'
    | 'rollup-updated';
  runId: number;
  projectId: number;
  status?: string;
}

export type DemoEventMessage =
  | { scope: 'run'; runId: number; event: DemoRunEvent }
  | { scope: 'global'; event: DemoGlobalEvent }
  /** A running run's tally, as the server's `/api/stream` sends its `run-progress`. */
  | { scope: 'progress'; event: RunProgressBroadcast }
  | { scope: 'notification'; event: Record<string, unknown> };

// ── Publishing (service worker side) ───────────────────────────────────────

let publishChannel: BroadcastChannel | null = null;

function getPublishChannel(): BroadcastChannel {
  if (!publishChannel) {
    publishChannel = new BroadcastChannel(CHANNEL_NAME);
  }
  return publishChannel;
}

export function publishDemoRunEvent(runId: number, event: DemoRunEvent): void {
  getPublishChannel().postMessage({ scope: 'run', runId, event } satisfies DemoEventMessage);
}

/** The global events after which the analytics test filters memoized over the run's project are stale. */
const STALE_TEST_FILTER_EVENTS = new Set<DemoGlobalEvent['type']>(['run-finished', 'run-submitted', 'rollup-updated']);

/** The runs' tallies, throttled per run as the server's `/api/stream` throttles them. */
let progressThrottle: ReturnType<typeof runProgressThrottle> | null = null;

function getProgressThrottle() {
  progressThrottle ??= runProgressThrottle((event) =>
    getPublishChannel().postMessage({ scope: 'progress', event } satisfies DemoEventMessage),
  );
  return progressThrottle;
}

export function publishDemoGlobalEvent(event: DemoGlobalEvent): void {
  if (STALE_TEST_FILTER_EVENTS.has(event.type)) dropProjectTestFilters(event.projectId);
  // The run's tally held back goes first, as on the server's stream.
  progressThrottle?.flush(event.runId);
  getPublishChannel().postMessage({ scope: 'global', event } satisfies DemoEventMessage);
}

/** Publish a running run's tally, at most once every 2 s per run, its latest winning. */
export function publishDemoRunProgress(progress: RunProgressBroadcast): void {
  getProgressThrottle().push(progress.runId, progress);
}

export function publishDemoNotificationEvent(event: Record<string, unknown>): void {
  getPublishChannel().postMessage({ scope: 'notification', event } satisfies DemoEventMessage);
}

// ── Subscribing (window side) ──────────────────────────────────────────────

let subscribeChannel: BroadcastChannel | null = null;
const handlers = new Set<(message: DemoEventMessage) => void>();

/**
 * Subscribe to demo run events. Returns an unsubscribe function.
 * The underlying channel is shared and closed when the last subscriber leaves.
 */
export function subscribeDemoEvents(handler: (message: DemoEventMessage) => void): () => void {
  if (!subscribeChannel) {
    subscribeChannel = new BroadcastChannel(CHANNEL_NAME);
    subscribeChannel.onmessage = (e: MessageEvent<DemoEventMessage>) => {
      for (const fn of handlers) fn(e.data);
    };
  }

  handlers.add(handler);

  return () => {
    handlers.delete(handler);
    if (handlers.size === 0 && subscribeChannel) {
      subscribeChannel.close();
      subscribeChannel = null;
    }
  };
}
