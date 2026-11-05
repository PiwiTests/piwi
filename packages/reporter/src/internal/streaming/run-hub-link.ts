import * as net from 'node:net';
import type { FullConfig, TestCase, TestResult } from '@playwright/test/reporter';
import { stripAnsi } from '@piwitests/core/error-parse';
import { lineReader, parseRecordChannel } from '@piwitests/core/ide-recorder';
import { hideSecretsInText } from '@piwitests/core/mask';
import {
  MAX_RUN_FAILURE_TEXT,
  RUN_CHANNEL_ENV,
  type RunCounts,
  type RunMainToHub,
} from '@piwitests/core/run-channel';
import { runChannelRef } from '../config/editors.js';

/**
 * The run's own connection to the hub its workers reach (`PIWI_RUN_CHANNEL`, the editor's or the desktop app's;
 * `RunMainToHub` of `@piwitests/core/run-channel`), from `onBegin` to `onEnd`, so the hub knows how far the run is
 * before and between its workers: how many tests the run holds (`run-begin`), how many ended for good and how
 * (`run-progress`, four times a second at most, the latest counts alone), and how the run ended, with its first
 * failure's title and error line through `hideSecretsInText` (`run-end`). It reads nothing the hub says and never
 * waits on it: a connection that does not open, or closes (a hub that predates it closes it at its first line), leaves
 * the run as without it.
 */

/** The least time between two `run-progress` lines. */
const PROGRESS_MS = 250;
/** How long `onEnd` waits for the connection to close once it said how the run ended. */
const CLOSE_MS = 500;

export class RunHubLink {
  private readonly counts: RunCounts = { done: 0, failed: 0, flaky: 0, skipped: 0 };
  private failure: { title: string; error: string | null } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sentAt = -Infinity;

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
    // Nothing the hub says is read: its lines are let go.
    socket.on(
      'data',
      lineReader(
        () => {},
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
    });
    return link;
  }

  /** An attempt ended: its test counts once it ended for good, by the outcome of its last attempt. */
  testEnded(test: TestCase, result: TestResult): void {
    const outcome = test.outcome();
    if (outcome === 'unexpected' && result.retry < test.retries && result.status !== 'interrupted') return;
    this.counts.done++;
    if (outcome === 'unexpected') {
      this.counts.failed++;
      this.failure ??= {
        title: hideSecretsInText(test.titlePath().filter(Boolean).slice(1).join(' › ')).slice(0, MAX_RUN_FAILURE_TEXT),
        error: firstLine(result.error?.message),
      };
    } else if (outcome === 'flaky') this.counts.flaky++;
    else if (outcome === 'skipped') this.counts.skipped++;
    this.progress();
  }

  /** The run ended (`status`, Playwright's): the hub hears how, and the connection closes, `CLOSE_MS` at most. */
  async end(status: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    if (!socket) return;
    const known = ['passed', 'failed', 'timedout', 'interrupted'].includes(status);
    this.send({
      type: 'run-end',
      status: known ? (status as 'passed') : 'other',
      failure: this.failure,
      ...this.counts,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_MS);
      timer.unref?.();
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
