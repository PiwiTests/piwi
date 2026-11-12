import { liveWorkerName, type LiveLane, type LiveWorkerState } from '#shared/live-view';
import type { TestCaseResult } from '~~/types/api';
import { stopWords } from './stop-words';

/**
 * **Follow what needs attention**: the lane view of the run page moves on its own to a lane whose test failed, got
 * stuck (the server's **Stuck?** mark) or stopped, and says why it moved. What needs attention comes from what the page
 * already knows of each lane (`attentionSignals`): its rows, their **Stuck?** marks and their stops, and the stops of
 * the workers in the run's live view. `AttentionFollower` turns them into moves: a signal seen for the first time is
 * news, and the newest news of another lane in the live view is where the view goes, no sooner than `DWELL_MS` after
 * it last moved or the person chose a lane, and not while the lane it shows needs attention itself (a stop or a
 * **Stuck?** mark that lasts, a failure for `HOLD_MS`). A failure is news for `FRESH_MS`; a stop or a mark while it
 * lasts. The failures the page held as the mode turned on are not news.
 */

/** What a lane needs attention for. */
export type AttentionReason = 'failed' | 'stuck' | 'stopped';

/** One thing a lane needs attention for: its key names this one occurrence (an attempt that failed, a stop). */
export interface AttentionSignal {
  key: string;
  lane: LiveLane;
  reason: AttentionReason;
  /** The test's title. */
  test: string;
  /** How a stop reads (`stopWords`), for a stop. */
  stop?: string;
}

/** A move of the view to a lane, and why. */
export type AttentionMove = AttentionSignal & { at: number };

/** The least time the view stays on a lane, after it moved or the person chose one, before it moves on its own. */
export const DWELL_MS = 5_000;
/** How long the lane shown holds the view after its own test failed. */
export const HOLD_MS = 10_000;
/** How long a failure is news. */
export const FRESH_MS = 30_000;

const FAILED: ReadonlySet<string> = new Set(['failed', 'timedout', 'timedOut']);

function sameLane(a: LiveLane, b: LiveLane): boolean {
  return a.shard === b.shard && a.slot === b.slot;
}

/** The lane of a row, from a reporter that says it; null otherwise. */
function rowLane(row: TestCaseResult): LiveLane | null {
  return typeof row.parallelIndex === 'number' ? { shard: row.shardIndex ?? null, slot: row.parallelIndex } : null;
}

/** An attempt's key: its test, its retry and its repetition, in its lane. */
function attemptKey(row: TestCaseResult, lane: LiveLane): string {
  return `${lane.shard ?? ''}#${lane.slot}|${row.location}|${row.title}|${row.retries ?? 0}|${row.repeatEachIndex ?? 0}`;
}

/**
 * What each lane needs attention for now, from the page's rows (every attempt, the earlier ones a retry followed
 * included) and the workers in its live view: an attempt that failed, a running one marked **Stuck?** or stopped, a
 * worker stopped at a call.
 */
export function attentionSignals(
  rows: readonly TestCaseResult[],
  workers: readonly LiveWorkerState[],
): AttentionSignal[] {
  const signals: AttentionSignal[] = [];
  for (const row of rows) {
    const lane = rowLane(row);
    if (!lane) continue;
    const key = attemptKey(row, lane);
    if (FAILED.has(row.status)) signals.push({ key: `failed:${key}`, lane, reason: 'failed', test: row.title });
    if (row.status !== 'running') continue;
    if (row.stuck) signals.push({ key: `stuck:${key}`, lane, reason: 'stuck', test: row.title });
    if (row.liveStop) {
      const stop = stopWords(row.liveStop.reason);
      signals.push({ key: `stopped:${key}:${row.liveStop.since}`, lane, reason: 'stopped', test: row.title, stop });
    }
  }
  for (const worker of workers) {
    if (!worker.paused || worker.slot === undefined) continue;
    const lane = { shard: worker.shard, slot: worker.slot };
    const test = worker.paused.test ?? worker.paused.call.title;
    const key = `paused:${worker.shard ?? ''}#${worker.slot}|${worker.worker}|${test}|${worker.paused.call.title}`;
    signals.push({ key, lane, reason: 'stopped', test, stop: stopWords(worker.paused.reason) });
  }
  return signals;
}

export class AttentionFollower {
  /** The signals already seen: news no more. */
  private readonly seen = new Set<string>();
  /** The news not acted on yet, and when each was first seen. */
  private news: AttentionMove[] = [];
  private started = false;
  /** When the view last moved, or the person chose a lane. */
  private settledAt = Number.NEGATIVE_INFINITY;
  /** The lane the view moved to for a failure, which holds it until `until`. */
  private failedHere: { lane: LiveLane; until: number } | null = null;

  /** The person chose the lane the view shows: it stays there `DWELL_MS` at least. */
  chose(now: number): void {
    this.settledAt = now;
  }

  /**
   * Note `signals` (all of them, as the page reads them now), and say where the view should move: the newest news of
   * another lane in `inView`, the lanes of the workers in the run's live view; null to stay where it is (`shown`, null
   * for no lane).
   */
  update(
    signals: readonly AttentionSignal[],
    shown: LiveLane | null,
    inView: readonly LiveLane[],
    now: number,
  ): AttentionMove | null {
    if (!this.started) {
      this.started = true;
      // A failure from before the mode turned on is not news; a stop or a mark that lasts is.
      for (const signal of signals) if (signal.reason === 'failed') this.seen.add(signal.key);
    }
    for (const signal of signals) {
      if (this.seen.has(signal.key)) continue;
      this.seen.add(signal.key);
      this.news.push({ ...signal, at: now });
    }
    const lasting = new Set(signals.map((signal) => signal.key));
    this.news = this.news.filter((news) =>
      news.reason === 'failed' ? now - news.at < FRESH_MS : lasting.has(news.key),
    );
    if (now - this.settledAt < DWELL_MS) return null;
    if (shown && this.holds(shown, signals, now)) return null;
    const candidates = this.news.filter(
      (news) => (!shown || !sameLane(news.lane, shown)) && inView.some((lane) => sameLane(lane, news.lane)),
    );
    if (!candidates.length) return null;
    const move = candidates.reduce((newest, news) => (news.at > newest.at ? news : newest));
    // The lane moved to: its news is acted on, a failure holding the view there a while.
    this.news = this.news.filter((news) => !sameLane(news.lane, move.lane));
    this.settledAt = now;
    this.failedHere = move.reason === 'failed' ? { lane: move.lane, until: now + HOLD_MS } : null;
    return move;
  }

  /** Whether the lane shown needs attention itself: a stop or a mark that lasts, or a failure within `HOLD_MS`. */
  private holds(shown: LiveLane, signals: readonly AttentionSignal[], now: number): boolean {
    if (signals.some((signal) => signal.reason !== 'failed' && sameLane(signal.lane, shown))) return true;
    if (this.failedHere && sameLane(this.failedHere.lane, shown) && now < this.failedHere.until) return true;
    return this.news.some((news) => news.reason === 'failed' && sameLane(news.lane, shown) && now - news.at < HOLD_MS);
  }
}

/** Why the view moved, as it says it: the worker and what its test did. */
export function attentionWords(move: AttentionSignal): string {
  const name = liveWorkerName({ shard: move.lane.shard, worker: move.lane.slot, slot: move.lane.slot });
  const test = `“${move.test}”`;
  const what =
    move.reason === 'failed'
      ? `${test} failed`
      : move.reason === 'stuck'
        ? `${test} has run far longer than it usually does (Stuck?)`
        : `${test}: ${(move.stop ?? 'Stopped').toLowerCase()}`;
  return `Moved to ${name}: ${what}.`;
}
