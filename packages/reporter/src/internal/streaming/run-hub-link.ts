import * as net from 'node:net';
import type { FullConfig, TestCase, TestResult } from '@playwright/test/reporter';
import { stripAnsi } from '@piwitests/core/error-parse';
import { lineReader, parseRecordChannel } from '@piwitests/core/ide-recorder';
import { hideSecretsInText } from '@piwitests/core/mask';
import {
  MAX_RUN_FAILURE_TEXT,
  RUN_CHANNEL_ENV,
  TERMINAL_REF_PREFIX,
  endedAtStopIn,
  parseHubToMain,
  readRunPage,
  type RunCounts,
  type RunMainToHub,
} from '@piwitests/core/run-channel';
import type { LiveAsk, LiveAskAnswer } from '@piwitests/core/live-view';
import { runChannelRef, startedByTestRunner } from '../config/hub.js';

/**
 * The run's own connection to the hub its workers reach (`PIWI_RUN_CHANNEL`, the editor's or the desktop app's;
 * `RunMainToHub` of `@piwitests/core/run-channel`), from `onBegin` to `onEnd`, so the hub knows how far the run is
 * before and between its workers: how many tests the run holds (`run-begin`), how many ended for good and how
 * (`run-progress`, four times a second at most, the latest counts alone), its page on the instance once it is known
 * (`run-page`, again when the stream opens another run than the global setup's), and how the run ended, with its first
 * failure's title and error line through `hideSecretsInText` (`run-end`), and a teammate's ask to watch the run
 * (`run-ask`). Each test counts once, by the outcome of its latest attempt: a serial group's retry counts its tests
 * again in place of their earlier outcome. A skipped test whose latest attempt was ended at a stop (End the test,
 * `ENDED_AT_STOP_REASON`) counts in `endedAtStop` too. Of what the hub says it reads the developer's answer to an ask
 * (`ask-answer`, `onAskAnswer`) alone, and it never waits on the hub but `CLOSE_MS` at the end, the connection held open
 * meanwhile so the run's process does not exit inside `onEnd`: a connection that does not open, or closes (a hub that
 * predates it closes it at its first line), leaves the run as without it.
 */

/** A test's outcome as counted: one of the counts, or `passed` for one that counts as done alone. */
type Counted = 'failed' | 'flaky' | 'skipped' | 'passed';

/** The least time between two `run-progress` lines. */
const PROGRESS_MS = 250;
/** How long `onEnd` waits for the connection to close once it said how the run ended. */
const CLOSE_MS = 500;

export class RunHubLink {
  private readonly counts: Required<RunCounts> = { done: 0, failed: 0, flaky: 0, skipped: 0, endedAtStop: 0 };
  /**
   * Each test counted, by Playwright's id, in the order first counted: its outcome, whether it was ended at a stop, and
   * its failure while it failed.
   */
  private readonly counted = new Map<
    string,
    { as: Counted; ended: boolean; failure: { title: string; error: string | null } | null }
  >();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sentAt = -Infinity;
  /** Called with the developer's answer to an ask to watch, as the hub says it. */
  onAskAnswer: ((answer: LiveAskAnswer) => void) | null = null;
  /** The page the hub last heard, and whether it heard how the run ended: nothing is sent after `run-end`. */
  private pageSent: string | null = null;
  private ended = false;

  private constructor(private socket: net.Socket | null) {}

  /** The link of a run whose environment names a hub and a ref (`runChannelRef`); null for a run without one. */
  static open(env: NodeJS.ProcessEnv, config: FullConfig, total: number, reporter: string): RunHubLink | null {
    const channel = parseRecordChannel(env[RUN_CHANNEL_ENV]);
    const ref = runChannelRef(env);
    if (!channel || !ref) return null;
    const socket = net.connect(channel.path);
    socket.setEncoding('utf8');
    socket.unref();
    const link = new RunHubLink(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (link.socket === socket) link.socket = null;
    });
    // Of what the hub says, the answer to an ask is read; the other lines are let go.
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseHubToMain(line);
          if (message) link.onAskAnswer?.({ id: message.id, answer: message.answer });
        },
        () => socket.destroy(),
      ),
    );
    const shard = config.shard ? { current: config.shard.current, total: config.shard.total } : null;
    link.send({
      type: 'run-begin',
      token: channel.token,
      ref,
      cwd: process.cwd(),
      pid: process.pid,
      playwright: config.version,
      reporter,
      total,
      workers: Math.max(1, config.workers),
      shard,
      // A run the reporter follows from outside the editor, which its own test runner started.
      ...(ref.startsWith(TERMINAL_REF_PREFIX) && startedByTestRunner(env) ? { runner: true as const } : {}),
    });
    return link;
  }

  /**
   * An attempt ended: its test counts once it ended for good, by the outcome of its latest attempt, in place of the
   * outcome it was counted with before (a serial group that runs again).
   */
  testEnded(test: TestCase, result: TestResult): void {
    const outcome = test.outcome();
    if (outcome === 'unexpected' && result.retry < test.retries && result.status !== 'interrupted') return;
    const as: Counted =
      outcome === 'unexpected'
        ? 'failed'
        : outcome === 'flaky'
          ? 'flaky'
          : outcome === 'skipped'
            ? 'skipped'
            : 'passed';
    const ended = as === 'skipped' && endedAtStopIn(result.annotations);
    const before = this.counted.get(test.id);
    if (before) {
      if (before.as !== 'passed') this.counts[before.as]--;
      if (before.ended) this.counts.endedAtStop--;
    } else this.counts.done++;
    if (as !== 'passed') this.counts[as]++;
    if (ended) this.counts.endedAtStop++;
    this.counted.set(test.id, {
      as,
      ended,
      // Its title as the workers name it: its describe blocks' titles, then its own.
      failure:
        as === 'failed'
          ? {
              title: hideSecretsInText(test.titlePath().slice(3).join(' › ')).slice(0, MAX_RUN_FAILURE_TEXT),
              error: firstLine(result.error?.message),
            }
          : null,
    });
    this.progress();
  }

  /**
   * The run's page on the instance (`id`, `url`): the hub hears each page that reads and differs from the last it
   * heard, until the run ended.
   */
  page(id: number | null | undefined, url: string | null | undefined): void {
    const page = readRunPage({ id, url });
    if (!page || this.ended) return;
    const key = `${page.id} ${page.url}`;
    if (this.pageSent === key) return;
    this.pageSent = key;
    this.send({ type: 'run-page', ...page });
  }

  /** A teammate asks to watch the run: the hub's tool asks the developer. False when no hub hears it. */
  ask(ask: LiveAsk): boolean {
    if (this.ended || !this.socket || this.socket.destroyed) return false;
    this.send({ type: 'run-ask', ...ask });
    return true;
  }

  /** The run ended (`status`, Playwright's): the hub hears how, and the connection closes, `CLOSE_MS` at most. */
  async end(status: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ended = true;
    const socket = this.socket;
    if (!socket) return;
    const known = ['passed', 'failed', 'timedout', 'interrupted'].includes(status);
    const failure = [...this.counted.values()].find((test) => test.failure)?.failure ?? null;
    this.send({ type: 'run-end', status: known ? (status as 'passed') : 'other', failure, ...this.counts });
    // Referenced again: the process stays up while `onEnd` waits for the connection to close.
    socket.ref();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_MS);
      socket.once('close', () => resolve());
      socket.end();
    });
    clearTimeout(timer);
  }

  /** The counts now, `PROGRESS_MS` after the last ones at the soonest. */
  private progress(): void {
    if (this.timer) return;
    const wait = this.sentAt + PROGRESS_MS - Date.now();
    const send = () => {
      this.timer = null;
      this.sentAt = Date.now();
      this.send({ type: 'run-progress', ...this.counts });
    };
    if (wait <= 0) return send();
    this.timer = setTimeout(send, wait);
    this.timer.unref?.();
  }

  private send(message: RunMainToHub): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(`${JSON.stringify(message)}\n`);
  }
}

/** The first line of an error's message, without its colors, its credentials hidden; null for none. */
function firstLine(message: string | undefined): string | null {
  const line = stripAnsi(message ?? '')
    .split('\n')
    .map((text) => text.trim())
    .find(Boolean);
  return line ? hideSecretsInText(line).slice(0, MAX_RUN_FAILURE_TEXT) : null;
}
