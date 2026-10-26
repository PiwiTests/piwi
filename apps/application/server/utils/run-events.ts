import { EventEmitter } from 'node:events';
import type { RunResourceTimelinePart } from '#shared/handlers/run-resources';
import { applyLiveResourcesToParts } from '#shared/live-resources';
import type { WireLiveResources } from '#shared/types';
import { matchesShardToken, shardTokenDigest } from './shard-tokens';

/**
 * In-memory pub/sub for live test run streaming.
 * Events are keyed by run ID and forwarded to SSE subscribers.
 *
 * **Single-instance limitation**: This event bus lives in Node.js process memory.
 * When the server is scaled to multiple instances, SSE clients connected to one
 * instance will not receive events published on another instance. For multi-instance
 * deployments you must either use sticky sessions (ensuring each run's reporter and
 * its SSE subscribers always hit the same instance) or replace this bus with a
 * shared pub/sub backend such as Redis.
 */

export interface RunEvent {
  type:
    | 'test-begin'
    | 'test-completed'
    | 'step-begin'
    | 'step-end'
    | 'run-progress'
    | 'run-finalizing'
    | 'run-finished'
    | 'case-files'
    | 'resources';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  seq: number;
  timestamp: number;
}

export interface GlobalRunEvent {
  /**
   * `rollup-updated` follows `run-finished` and `run-submitted` once the run's daily rollup is
   * written: analytics read the rollups, so they refresh on it, never on the run events before it.
   */
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

/**
 * A live progress tally for one run, broadcast globally so an app-wide consumer
 * (the desktop shell's OS progress) can track every in-flight run's counts
 * without opening a per-run stream. Kept on its own channel so the existing
 * global lifecycle stream (`/api/stream`) is unaffected.
 */
export interface RunProgressBroadcast {
  runId: number;
  projectId: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  didNotRunTests: number;
}

export interface RunState {
  /** The stored form of the run's main stream token (`streamTokenDigest`). */
  streamToken: string;
  projectId: number;
  shardTokens?: Set<string>;
}

class RunEventBus {
  private emitter = new EventEmitter();
  private globalEmitter = new EventEmitter();
  private sequences = new Map<number, number>();
  /**
   * In-memory cache of active run state (token + projectId) so the events
   * endpoint can skip a DB round-trip on every incoming batch.
   * Populated by start/begin endpoints; cleared when the run finishes.
   */
  private runStates = new Map<number, RunState>();
  /**
   * The begin payloads of test cases that have started but not yet completed,
   * keyed by run ID then by a stable case key. Only completed cases get a DB
   * row, so a client that connects or refreshes mid-run has nothing to show a
   * running case from; the stream catch-up replays these as `test-begin`
   * events. A case is dropped when it completes; the whole run's set goes on
   * cleanup.
   */
  private runningCases = new Map<number, Map<string, Record<string, unknown>>>();
  /**
   * What each reporter of a live run measured so far, one part per reporter,
   * from its live resources posts. A client that connects mid-run gets them as
   * its catch-up; the run's stored report replaces them once it ends.
   */
  private liveResources = new Map<number, RunResourceTimelinePart[]>();
  /** Whether each live run's project declined the resources capability, read once per run. */
  private liveResourcesDeclined = new Map<number, boolean>();

  constructor() {
    // Allow many concurrent listeners (one per SSE connection)
    this.emitter.setMaxListeners(1000);
    this.globalEmitter.setMaxListeners(1000);
  }

  /**
   * Publish an event for a specific run.
   */
  publish(runId: number, event: Omit<RunEvent, 'seq' | 'timestamp'>): RunEvent {
    const seq = (this.sequences.get(runId) || 0) + 1;
    this.sequences.set(runId, seq);

    const fullEvent: RunEvent = {
      ...event,
      seq,
      timestamp: Date.now(),
    };

    this.emitter.emit(`run:${runId}`, fullEvent);
    return fullEvent;
  }

  /**
   * Subscribe to events for a specific run.
   * Returns an unsubscribe function.
   */
  subscribe(runId: number, listener: (event: RunEvent) => void): () => void {
    const channel = `run:${runId}`;
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  /**
   * Whether anyone is subscribed to the run's events: a run or execution page
   * holding its live stream open. The streaming endpoints return it to the
   * reporter, which sends step events only while it is true.
   */
  isWatched(runId: number): boolean {
    return this.emitter.listenerCount(`run:${runId}`) > 0;
  }

  /** Cache the stream token and projectId for an active run. */
  cacheRunState(runId: number, state: RunState): void {
    this.runStates.set(runId, state);
  }

  /** Return cached run state, or undefined on a cache miss. */
  getRunState(runId: number): RunState | undefined {
    return this.runStates.get(runId);
  }

  /** Remove the cached run state when the stream token is invalidated. */
  clearRunState(runId: number): void {
    this.runStates.delete(runId);
  }

  /** Register a per-shard stream token for an active run (kept as its digest, like the stored copy). */
  addShardToken(runId: number, token: string): void {
    const state = this.runStates.get(runId);
    if (state) {
      if (!state.shardTokens) state.shardTokens = new Set();
      state.shardTokens.add(shardTokenDigest(token));
    }
  }

  /** Check whether a token is a valid per-shard stream token. */
  isValidShardToken(runId: number, token: string): boolean {
    return matchesShardToken(this.runStates.get(runId)?.shardTokens, token);
  }

  /** Remove a per-shard stream token when its shard has finished. */
  removeShardToken(runId: number, token: string): void {
    const state = this.runStates.get(runId);
    state?.shardTokens?.delete(shardTokenDigest(token));
    state?.shardTokens?.delete(token);
    // Clean up the set if it's now empty
    if (state?.shardTokens?.size === 0) state.shardTokens = undefined;
  }

  /** Remember a case that has begun so the stream catch-up can replay it. */
  recordRunningCase(runId: number, key: string, data: Record<string, unknown>): void {
    let cases = this.runningCases.get(runId);
    if (!cases) {
      cases = new Map();
      this.runningCases.set(runId, cases);
    }
    cases.set(key, data);
  }

  /** Drop a running case once it completes. */
  clearRunningCase(runId: number, key: string): void {
    this.runningCases.get(runId)?.delete(key);
  }

  /** The begin payloads of every case still running for a run. */
  getRunningCases(runId: number): Record<string, unknown>[] {
    const cases = this.runningCases.get(runId);
    return cases ? [...cases.values()] : [];
  }

  /**
   * Apply a reporter's live resources post to the run's parts. False when the
   * post only adds to series this server does not hold (it restarted, or the
   * reporter's first post went elsewhere): nothing is kept, and the reporter
   * sends every point on its next post.
   */
  applyLiveResources(runId: number, post: WireLiveResources): boolean {
    const parts = this.liveResources.get(runId) ?? [];
    if (!post.reset && !parts.some((part) => part.shardIndex === post.shardIndex)) return false;
    this.liveResources.set(runId, applyLiveResourcesToParts(parts, post));
    return true;
  }

  /** What the run's reporters measured so far, one part per reporter, in shard order. */
  getLiveResources(runId: number): RunResourceTimelinePart[] {
    return this.liveResources.get(runId) ?? [];
  }

  /** Whether the run's project declined the resources capability, when already read for this run. */
  liveResourcesDeclinedFor(runId: number): boolean | undefined {
    return this.liveResourcesDeclined.get(runId);
  }

  noteLiveResourcesDeclined(runId: number, declined: boolean): void {
    this.liveResourcesDeclined.set(runId, declined);
  }

  /**
   * Clean up all in-memory state for a finished run.
   */
  cleanup(runId: number): void {
    this.sequences.delete(runId);
    this.runStates.delete(runId);
    this.runningCases.delete(runId);
    this.liveResources.delete(runId);
    this.liveResourcesDeclined.delete(runId);
  }

  /**
   * Broadcast a global run lifecycle event to all dashboard subscribers.
   */
  publishGlobal(event: GlobalRunEvent): void {
    this.globalEmitter.emit('global', event);
  }

  /**
   * Subscribe to global run lifecycle events.
   * Returns an unsubscribe function.
   */
  subscribeGlobal(listener: (event: GlobalRunEvent) => void): () => void {
    this.globalEmitter.on('global', listener);
    return () => {
      this.globalEmitter.off('global', listener);
    };
  }

  /**
   * Broadcast a run's live progress tally to app-wide subscribers. On its own
   * channel so it never reaches the lifecycle stream's subscribers.
   */
  publishRunProgress(progress: RunProgressBroadcast): void {
    this.globalEmitter.emit('run-progress', progress);
  }

  /**
   * Subscribe to global run-progress tallies. Returns an unsubscribe function.
   */
  subscribeRunProgress(listener: (progress: RunProgressBroadcast) => void): () => void {
    this.globalEmitter.on('run-progress', listener);
    return () => {
      this.globalEmitter.off('run-progress', listener);
    };
  }

  /**
   * Publish a browser-notification event to all notification-stream subscribers.
   * Separate from the global run-lifecycle bus — these events are delivered
   * without debounce and the connection stays open even when the tab is hidden.
   */
  publishNotification(event: Record<string, unknown>): void {
    this.emitter.emit('notification', event);
  }

  /**
   * Subscribe to browser-notification events.
   * Returns an unsubscribe function.
   */
  subscribeNotifications(listener: (event: Record<string, unknown>) => void): () => void {
    this.emitter.on('notification', listener);
    return () => {
      this.emitter.off('notification', listener);
    };
  }
}

// Singleton instance
export const runEventBus = new RunEventBus();
