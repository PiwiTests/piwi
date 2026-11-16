/**
 * The running line of each lane of the runs the editor follows, as the client marks it (`piwi/runningLine`): the call
 * each lane's running test is in. A lane the client watches takes it from its call log (`fromLog`), every other lane
 * from the positions its worker sends (`fromPosition`), as `piwi.runningLines` chooses (`all`, `watched`, `off`). A
 * lane's line goes as its test ends or stops, its worker leaves or the run ends (`changed`); the lines that changed go
 * to the client together, at most once every `paceMs`.
 */
import type { RunningCall, RunningLine, RunningLinesChoice } from './protocol.js';

/** The lines of every lane go to the client together at most this often. */
export const RUNNING_LINES_PACE_MS = 250;

export interface RunningLinesOptions {
  /** The test the lane `lane` of the run `ref` runs now and its worker; null while it runs none (`laneRunning`). */
  laneRunning(ref: string, lane: number): { worker: number; test: string } | null;
  /** Whether the worker of that lane says where its running test is (`lanePositions`). */
  lanePositions(ref: string, lane: number): boolean;
  notify(line: RunningLine): Promise<void>;
  /** What the client marks: null for a client that marks no running line. */
  choice(): RunningLinesChoice | null;
  paceMs?: number;
}

type Lane = Omit<RunningLine, 'call'>;

const keyOf = (at: { ref: string; lane: number }) => `${at.ref}\n${at.lane}`;

export class RunningLines {
  /** The line last told of each lane that shows one. */
  private readonly shown = new Map<string, RunningLine>();
  /** The lines to tell at the next send, by lane. */
  private readonly pending = new Map<string, RunningLine>();
  /** The lanes whose line follows their call log: the lane the client watches. */
  private readonly logged = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RunningLinesOptions) {}

  /** Whether the client marks a running line: the watched lane's at least. */
  marks(): boolean {
    const choice = this.options.choice();
    return choice === 'all' || choice === 'watched';
  }

  /** Whether the client marks every lane's running line, which the workers' positions give. */
  wantsPositions(): boolean {
    return this.options.choice() === 'all';
  }

  /** The lane the client watches follows its call log from now on (`on`), or no longer. */
  follow(at: { ref: string; lane: number }, on: boolean): void {
    const key = keyOf(at);
    if (on) {
      this.logged.add(key);
      return;
    }
    if (!this.logged.delete(key)) return;
    // Its worker's positions take over; without them, its line goes with the watch.
    if (!this.wantsPositions() || !this.options.lanePositions(at.ref, at.lane)) this.clearLane(key);
  }

  /** The call log of a lane the client watches says where its running test is. */
  fromLog(at: Lane, call: RunningCall): void {
    if (this.marks()) this.set(at, call);
  }

  /** A worker said where its running test is: taken for a lane whose call log the client does not follow. */
  fromPosition(at: Lane, call: RunningCall): void {
    if (this.wantsPositions() && !this.logged.has(keyOf(at))) this.set(at, call);
  }

  /** A session changed: the line of a lane whose test ended or stopped, whose worker left or whose run ended goes. */
  changed(): void {
    for (const [key, line] of [...this.shown, ...this.pending]) {
      // A line waiting to be told replaces the one shown.
      if (!line.call || (this.pending.has(key) && this.pending.get(key) !== line)) continue;
      const running = this.options.laneRunning(line.ref, line.lane);
      if (running?.worker !== line.worker || running.test !== line.call.test) this.set(line, null, key);
    }
  }

  /** The choice changed: every line goes with `off`, and with `watched` each but the watched lane's. */
  switched(): void {
    const all = !this.marks();
    const watchedOnly = !this.wantsPositions();
    for (const key of new Set([...this.shown.keys(), ...this.pending.keys()])) {
      if (all || (watchedOnly && !this.logged.has(key))) this.clearLane(key);
    }
  }

  /** Every line goes, told to the client at once: the client stops. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.logged.clear();
    for (const key of new Set([...this.shown.keys(), ...this.pending.keys()])) this.clearLane(key);
    this.send();
  }

  private clearLane(key: string): void {
    const line = this.pending.get(key) ?? this.shown.get(key);
    if (line) this.set(line, null, key);
  }

  private set(at: Lane, call: RunningCall | null, key = keyOf(at)): void {
    const next: RunningLine = { ref: at.ref, lane: at.lane, worker: at.worker, call };
    const shown = this.shown.get(key);
    const same = shown
      ? shown.worker === next.worker && JSON.stringify(shown.call) === JSON.stringify(call)
      : call === null;
    if (same) this.pending.delete(key);
    else this.pending.set(key, next);
    if (this.pending.size) this.schedule();
  }

  /** Tell what changed now when nothing was told within `paceMs`, else at its end. */
  private schedule(): void {
    if (this.timer) return;
    const pace = this.options.paceMs ?? RUNNING_LINES_PACE_MS;
    this.send();
    if (pace <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending.size) this.schedule();
    }, pace);
    this.timer.unref?.();
  }

  private send(): void {
    for (const [key, line] of this.pending) {
      if (line.call) this.shown.set(key, line);
      else this.shown.delete(key);
      this.options.notify(line).catch(() => {});
    }
    this.pending.clear();
  }
}
