import type { StreamEvent } from '../../types.js';

/**
 * Drop tier for buffer eviction: lower tiers are shed first when the queue
 * exceeds its byte budget.
 *
 *  - `step-begin` / `step-end` (tier 0) are pure live-progress detail and are
 *    also carried inside the matching `complete` event (`stepEvents`), so
 *    shedding them loses nothing final; so is a stop (`test-stopped`,
 *    `test-resumed`), which the `complete` ends, and which is sent again to
 *    whoever opens the run while it stands.
 *  - `begin` (tier 1) marks a test as started; the server can still create the
 *    case from the `complete` that follows, so it is shed after steps.
 *  - `complete` (tier 2) carries the test's result and detail. Shedding it is
 *    real *live* data loss, so it happens only as a last resort — and the
 *    reporter's own `CollectedTestCase` set still holds the full run for the
 *    end-of-run batch submit (see `lostResults`).
 */
const DROP_TIER: Record<StreamEvent['type'], number> = {
  'step-begin': 0,
  'step-end': 0,
  'test-stopped': 1,
  'test-resumed': 1,
  begin: 1,
  complete: 2,
};

/** Highest tier eviction will shed. An event here is a test result. */
const CRITICAL_TIER = 2;

interface Item {
  event: StreamEvent;
  size: number;
}

/**
 * A FIFO queue of stream events with a byte budget. Order is preserved for
 * delivery; when the buffered size exceeds `maxBytes`, the lowest-value events
 * are dropped first (see `DROP_TIER`) so a stalled server or a huge suite can
 * never grow the reporter's memory (or the crash-recovery file it writes on
 * drain) without bound.
 *
 * The queue owns its array and all size bookkeeping, so the running byte total
 * stays consistent across every mutation.
 */
export class BoundedEventQueue {
  private items: Item[] = [];
  private _bytes = 0;
  private _peakBytes = 0;
  private _dropped = 0;
  private readonly _droppedByType: Partial<Record<StreamEvent['type'], number>> = {};
  private _lostResults = false;

  /**
   * @param maxBytes Byte budget for the buffered events. `<= 0` or non-finite
   *   disables the bound (unbounded).
   */
  constructor(private readonly maxBytes: number) {}

  /** Number of buffered events. */
  get length(): number {
    return this.items.length;
  }

  /** Whether the queue holds no events. */
  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** Approximate byte size of the buffered events. */
  get bytes(): number {
    return this._bytes;
  }

  /** Highest byte size the queue reached over its lifetime. */
  get peakBytes(): number {
    return this._peakBytes;
  }

  /** How many events have been dropped by eviction. */
  get droppedCount(): number {
    return this._dropped;
  }

  /** Dropped-event counts broken down by event type. */
  get droppedByType(): Readonly<Partial<Record<StreamEvent['type'], number>>> {
    return this._droppedByType;
  }

  /** True once a test-result (`complete`) event had to be shed — real live-data loss. */
  get lostResults(): boolean {
    return this._lostResults;
  }

  /** Append one event to the back of the queue, then evict if over budget. */
  enqueue(event: StreamEvent): void {
    const size = estimateSize(event);
    this.items.push({ event, size });
    this._bytes += size;
    this.afterGrow();
  }

  /**
   * Put events back at the front (oldest position), preserving their order, then
   * evict. Used to re-queue a failed flush ahead of anything that arrived while
   * it was in flight, and to replay events reloaded from the on-disk buffer.
   */
  prepend(events: StreamEvent[]): void {
    if (events.length === 0) return;
    const head: Item[] = [];
    let added = 0;
    for (const event of events) {
      const size = estimateSize(event);
      head.push({ event, size });
      added += size;
    }
    this.items = head.concat(this.items);
    this._bytes += added;
    this.afterGrow();
  }

  /** Remove and return every queued event, resetting the size counter. */
  takeAll(): StreamEvent[] {
    const out = this.items.map((it) => it.event);
    this.items = [];
    this._bytes = 0;
    return out;
  }

  /** Read the queued events without removing them. */
  snapshot(): StreamEvent[] {
    return this.items.map((it) => it.event);
  }

  /** Drop every queued event without counting it as an eviction. */
  clear(): void {
    this.items = [];
    this._bytes = 0;
  }

  private afterGrow(): void {
    if (this._bytes > this._peakBytes) this._peakBytes = this._bytes;
    this.evict();
  }

  // Shed events tier by tier, oldest-first within a tier, until the buffer fits
  // its budget. A single event larger than the whole budget is kept rather than
  // leaving the queue empty, so the most recent result always survives.
  private evict(): void {
    if (this.maxBytes <= 0 || !Number.isFinite(this.maxBytes)) return;
    for (let tier = 0; tier <= CRITICAL_TIER && this._bytes > this.maxBytes; tier++) {
      let i = 0;
      while (i < this.items.length && this._bytes > this.maxBytes) {
        // Never shed the last remaining event at the critical tier: keeping one
        // oversized result beats dropping it and emptying the buffer.
        if (tier === CRITICAL_TIER && this.items.length <= 1) break;
        const it = this.items[i];
        if (DROP_TIER[it.event.type] === tier) {
          this.items.splice(i, 1);
          this._bytes -= it.size;
          this._dropped++;
          this._droppedByType[it.event.type] = (this._droppedByType[it.event.type] ?? 0) + 1;
          if (tier === CRITICAL_TIER) this._lostResults = true;
        } else {
          i++;
        }
      }
    }
  }
}

// UTF-16 length is a cheap, close-enough proxy for the JSON line's footprint;
// exact UTF-8 byte counting is not worth the cost on the enqueue hot path.
function estimateSize(event: StreamEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}
