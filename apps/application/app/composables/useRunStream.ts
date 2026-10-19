import { onUnmounted } from 'vue';
import { subscribeDemoEvents } from '~/demo/run-events';

/**
 * Shared SSE connection and subscriber list.
 * All components share a single EventSource connection to /api/stream,
 * preventing redundant connections on every page/component mount.
 *
 * Inactivity handling (client-side):
 *   Debounce delay grows with user idle time (1 s → 30 s max) so idle tabs
 *   fire far fewer API refreshes while still staying up-to-date.
 *
 * Visibility handling (server-side benefit):
 *   When the tab is hidden the SSE connection is closed, freeing the
 *   server-side keep-alive. On tab focus it reconnects and immediately
 *   refreshes all subscribers so missed events are caught up.
 *
 * In demo mode the API handlers run in the service worker, so the SSE
 * connection is replaced with a BroadcastChannel subscription carrying the
 * same global lifecycle events (see app/demo/run-events.ts).
 *
 * Must be called inside a component's `setup` (or `<script setup>`) context
 * so that `onUnmounted` can deregister the callback.
 */
let sharedEventSource: EventSource | null = null;
let demoUnsubscribe: (() => void) | null = null;
/** The demo has no server: its events come over a BroadcastChannel, never an EventSource. */
let demoMode = false;
const subscribers = new Set<() => void>();

/** A global run lifecycle event, as `/api/stream` sends it. */
export interface RunLifecycleEvent {
  type: string;
  runId?: number;
  projectId?: number;
  status?: string;
}

/** Listeners that need the event itself (which project), called at once, not debounced. */
const eventListeners = new Set<(event: RunLifecycleEvent) => void>();

function notifyEventListeners(event: RunLifecycleEvent) {
  for (const fn of eventListeners) fn(event);
}
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ── Inactivity-based debounce ─────────────────────────────────────────────────
const BASE_DEBOUNCE = 1_000;
const MAX_DEBOUNCE = 30_000;
// Delay doubles for each inactivity tier crossed (5 min, 15 min, 30 min)
const INACTIVITY_TIERS = [5 * 60_000, 15 * 60_000, 30 * 60_000];

let lastActivityAt = Date.now();
let globalListenersAttached = false;

function recordActivity() {
  lastActivityAt = Date.now();
}

function getDebounceDelay(): number {
  const idle = Date.now() - lastActivityAt;
  let multiplier = 1;
  for (const tier of INACTIVITY_TIERS) {
    if (idle >= tier) multiplier *= 2;
    else break;
  }
  return Math.min(BASE_DEBOUNCE * multiplier, MAX_DEBOUNCE);
}
// ─────────────────────────────────────────────────────────────────────────────

const REFRESH_EVENTS = new Set([
  'run-initializing',
  'run-started',
  'run-finalizing',
  'run-finished',
  'run-submitted',
  'run-cancelled',
]);

function notifySubscribers(eventType: string) {
  if (!REFRESH_EVENTS.has(eventType)) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    for (const fn of subscribers) fn();
  }, getDebounceDelay());
}

function openEventSource() {
  if (sharedEventSource || demoMode) return;

  sharedEventSource = new EventSource('/api/stream');

  sharedEventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      notifySubscribers(data.type);
      if (data && typeof data.type === 'string') notifyEventListeners(data);
    } catch {
      // Ignore non-JSON messages (e.g. heartbeat comments)
    }
  };

  sharedEventSource.onerror = () => {
    // EventSource will automatically attempt to reconnect on error
  };
}

function handleVisibilityChange() {
  recordActivity();

  if (document.visibilityState === 'hidden') {
    // Close SSE while hidden — frees the server-side keep-alive connection
    if (sharedEventSource) {
      sharedEventSource.close();
      sharedEventSource = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  } else if (subscribers.size > 0 || eventListeners.size > 0) {
    // Tab is visible again — reconnect and immediately refresh to catch up on missed events
    openEventSource();
    for (const fn of subscribers) fn();
  }
}

function ensureConnection() {
  if (!import.meta.client) return;

  if (!globalListenersAttached) {
    globalListenersAttached = true;
    const activityEvents = ['mousemove', 'keydown', 'pointerdown', 'scroll'];
    for (const e of activityEvents) window.addEventListener(e, recordActivity, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  demoMode = Boolean(useRuntimeConfig().public.demoMode);
  if (demoMode) {
    if (demoUnsubscribe) return;
    demoUnsubscribe = subscribeDemoEvents((message) => {
      if (message.scope === 'global') {
        notifySubscribers(message.event.type);
        notifyEventListeners(message.event);
      }
    });
    return;
  }

  // Only open when the tab is visible
  if (document.visibilityState !== 'hidden') {
    openEventSource();
  }
}

function closeConnection() {
  if (subscribers.size > 0 || eventListeners.size > 0) return;

  if (sharedEventSource) {
    sharedEventSource.close();
    sharedEventSource = null;
  }
  if (demoUnsubscribe) {
    demoUnsubscribe();
    demoUnsubscribe = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

export function useRunStream(refresh: () => Promise<unknown>) {
  if (!import.meta.client) return;

  ensureConnection();

  subscribers.add(refresh);

  onUnmounted(() => {
    subscribers.delete(refresh);
    closeConnection();
  });
}

/**
 * Listen to the global run lifecycle events with their details (which run,
 * which project), on the same shared connection as `useRunStream`. Called
 * for every event as it arrives; the listener does its own throttling.
 */
export function useRunEvents(listener: (event: RunLifecycleEvent) => void) {
  if (!import.meta.client) return;

  ensureConnection();

  eventListeners.add(listener);

  onUnmounted(() => {
    eventListeners.delete(listener);
    closeConnection();
  });
}
