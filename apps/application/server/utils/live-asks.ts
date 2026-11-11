import { randomBytes } from 'node:crypto';
import {
  ASK_TO_WATCH_MS,
  parseLiveAsk,
  parseLiveAskAnswer,
  type LiveAsk,
  type LiveAskAnswer,
} from '@piwitests/core/live-view';
import { isCiRun, type LiveAskView, type LiveViewRunState } from '#shared/live-view';
import { runEventBus, type GlobalRunEvent } from './run-events';

/**
 * **Ask to watch**, on the instance: a signed-in reader of a running run that is not shared live asks its developer to
 * share it, once per `ASK_TO_WATCH_MS` at most on one run. The asks wait here, in memory alone, until the run's
 * reporter takes the oldest one not handed over in the answer of its next stream request (`handOver`: `ask` of the
 * events, heartbeat and live resources answers), once. The developer answers where the run was launched: `not-now`
 * comes back in the body of a later request (`askAnswer`), and a share shows as a worker of the run opening its live
 * view stream, which makes each ask of the run that waits `shared`. Each change goes to the person who asked, on the
 * run's event stream (`live-ask`). A person keeps one ask per run, the latest; the asks end with the run, and with
 * their project's live view or Ask to watch turned off. Bounded per run and in all, the oldest dropped first.
 */

/** The most asks kept of one run: one per person, the latest. */
export const MAX_ASKS_PER_RUN = 32;
/** The most asks kept, of every run. */
export const MAX_ASKS = 2000;

/** What ends a run's asks: its tests are done, or it will never run them. */
const RUN_ENDS: ReadonlySet<GlobalRunEvent['type']> = new Set([
  'run-finalizing',
  'run-finished',
  'run-cancelled',
  'run-submitted',
]);

interface PendingAsk {
  id: string;
  runId: number;
  projectId: number;
  userId: number;
  by: string;
  /** When it was asked, by `now`. */
  at: number;
  /** It went out in an answer to the run's reporter. */
  handedOver: boolean;
  answer: LiveAskView['answer'];
}

/** A person's ask taken (`ask`), or refused until they may ask again (`waitMs`). */
export type AskOutcome = { ok: true; ask: LiveAskView } | { ok: false; waitMs: number };

/** What the run's event stream carries of an ask as it changes: its view, and who asked, whom alone it goes to. */
export interface LiveAskEvent extends LiveAskView {
  userId: number;
}

export class LiveAsks {
  /** By `runId:userId`, oldest first. */
  private readonly asks = new Map<string, PendingAsk>();

  constructor(
    private readonly publish: (runId: number, event: LiveAskEvent) => void = (runId, event) =>
      runEventBus.publish(runId, { type: 'live-ask', data: event }),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `userId`, named `by`, asks to watch the run: refused within `ASK_TO_WATCH_MS` of their last ask of it, else kept
   * in place of that one. The caller checks first that the run may be asked about.
   */
  ask(runId: number, projectId: number, userId: number, by: string): AskOutcome {
    const key = askKey(runId, userId);
    const now = this.now();
    const before = this.asks.get(key);
    if (before && now - before.at < ASK_TO_WATCH_MS) return { ok: false, waitMs: before.at + ASK_TO_WATCH_MS - now };
    const id = randomBytes(12).toString('base64url');
    const read = parseLiveAsk({ id, by }) ?? { id, by: 'A teammate' };
    const pending: PendingAsk = {
      id,
      runId,
      projectId,
      userId,
      by: read.by,
      at: now,
      handedOver: false,
      answer: null,
    };
    this.asks.delete(key);
    const ofRun = this.ofRun(runId);
    if (ofRun.length >= MAX_ASKS_PER_RUN) this.asks.delete(askKey(runId, ofRun[0]!.userId));
    while (this.asks.size >= MAX_ASKS) this.asks.delete(this.asks.keys().next().value!);
    this.asks.set(key, pending);
    this.changed(pending, now);
    return { ok: true, ask: this.view(pending, now) };
  }

  /** The run's oldest ask not handed over to its reporter and not answered, now handed over; null for none. */
  handOver(runId: number): LiveAsk | null {
    const next = this.ofRun(runId).find((pending) => !pending.handedOver && pending.answer === null);
    if (!next) return null;
    next.handedOver = true;
    return { id: next.id, by: next.by };
  }

  /** The field of a stream answer that hands the run's reporter its next ask (`handOver`): `{ ask }`, or nothing. */
  handOverAnswer(runId: number): { ask?: LiveAsk } {
    const ask = this.handOver(runId);
    return ask ? { ask } : {};
  }

  /**
   * The developer's answer to an ask of the run, as the reporter sent it (`askAnswer`, read with
   * `parseLiveAskAnswer`): an ask of another run, one answered already, or no answer, changes nothing.
   */
  answer(runId: number, value: unknown): LiveAskAnswer | null {
    const answer = parseLiveAskAnswer(value);
    if (!answer) return null;
    const pending = this.ofRun(runId).find((kept) => kept.id === answer.id);
    if (!pending || pending.answer !== null) return null;
    pending.answer = answer.answer;
    this.changed(pending);
    return answer;
  }

  /** A worker of the run opened its live view stream: each ask of the run that waits is answered `shared`. */
  shareRun(runId: number): void {
    for (const pending of this.ofRun(runId)) {
      if (pending.answer !== null) continue;
      pending.answer = 'shared';
      this.changed(pending);
    }
  }

  /** The latest ask of `userId` on the run, as their run page shows it; null for none. */
  viewOf(runId: number, userId: number): LiveAskView | null {
    const pending = this.asks.get(askKey(runId, userId));
    return pending ? this.view(pending) : null;
  }

  /** The run ended: its asks are dropped. */
  endRun(runId: number): void {
    for (const pending of this.ofRun(runId)) this.asks.delete(askKey(runId, pending.userId));
  }

  /** The project turned its live view or Ask to watch off: the asks of its runs are dropped, none handed over. */
  endProject(projectId: number): void {
    for (const [key, pending] of this.asks) if (pending.projectId === projectId) this.asks.delete(key);
  }

  /** Drop the asks of each run that ends, as the run's lifecycle says. */
  followRuns(): () => void {
    return runEventBus.subscribeGlobal((event) => {
      if (RUN_ENDS.has(event.type)) this.endRun(event.runId);
    });
  }

  private ofRun(runId: number): PendingAsk[] {
    return [...this.asks.values()].filter((pending) => pending.runId === runId);
  }

  private view(pending: PendingAsk, now = this.now()): LiveAskView {
    return {
      id: pending.id,
      by: pending.by,
      answer: pending.answer,
      waitMs: Math.max(0, pending.at + ASK_TO_WATCH_MS - now),
    };
  }

  private changed(pending: PendingAsk, now = this.now()): void {
    this.publish(pending.runId, { ...this.view(pending, now), userId: pending.userId });
  }
}

function askKey(runId: number, userId: number): string {
  return `${runId}:${userId}`;
}

/** What a run and its project must be for the run's readers to ask its developer to share it. */
export interface AskableRun {
  status: string;
  metadata: unknown;
  /** The run holds a live view key (`liveViewRelay.holdsKey`). */
  keyed: boolean;
  /** The project's live view is on. */
  liveView: boolean;
  /** The project takes asks to watch. */
  askToWatch: boolean;
}

/**
 * Why the run's readers may not ask to watch it, as far as the run and its project go; null when they may: a running
 * run outside CI that holds a live view key, in a project with its live view and Ask to watch on. Whether it is shared
 * now, and who asks, the route checks.
 */
export function askRefusal(run: AskableRun): string | null {
  if (!run.liveView) return 'The live view is off for this project.';
  if (!run.askToWatch) return 'This project does not take asks to watch.';
  if (run.status !== 'running') return 'The run is not running.';
  if (isCiRun(run.metadata)) return 'A CI run is shared live as it runs: there is nothing to ask.';
  if (!run.keyed) return 'The run cannot be shared live: it holds no live view key.';
  return null;
}

/**
 * What the run's event bus says of its live view (`live-view`): whether the run holds a key, whether its project has
 * the live view on, and whether its readers may ask to watch it. The run's stream tells each viewer what that means for
 * them (`viewerLiveView`).
 */
export interface LiveViewBusState {
  keyed: boolean;
  enabled: boolean;
  /** `askRefusal` gives no reason. */
  askable: boolean;
}

/** The run's live view state as one viewer gets it: `asker`, the signed-in person watching, may ask, with their ask. */
export function viewerLiveView(
  state: LiveViewBusState,
  runId: number,
  asker: number | null,
  asks: LiveAsks = liveAsks,
): LiveViewRunState {
  return {
    keyed: state.keyed,
    enabled: state.enabled,
    canAsk: asker !== null && state.askable,
    ask: asker === null ? null : asks.viewOf(runId, asker),
  };
}

/** An ask's change as one viewer gets it: only the person who asked hears it (`asker`), without their id. */
export function viewerAskEvent(event: LiveAskEvent, asker: number | null): LiveAskView | null {
  if (asker === null || event.userId !== asker) return null;
  const { userId: _userId, ...view } = event;
  return view;
}

export const liveAsks = new LiveAsks();
liveAsks.followRuns();
