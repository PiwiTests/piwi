/**
 * Code from a stopped test: the actions a client (`piwi/stopAction`, `piwi/stopRequests`, `piwi/locatorAtCaret`) and
 * Piwi Picker (the hub's commands) start at a stop of a run the editor started, each ending the same way: the worker
 * does the page's part through internal calls, this service renders the code (`stop-code.ts`), and the client writes
 * it above the stopped line (`piwi/stopCode`), whichever surface asked. Pick a locator and Record here go where the
 * pause bar's go (the client's Send to editor listener, `piwi/recordRequested`). Assert runs the check panel in the
 * test's page through a hand-off in its `check` mode (`check`); Assert a region has the worker pick the region and read
 * its ARIA snapshot (`region`); Mock a request asks the worker for the one response chosen among those its test kept.
 * The code goes above the stopped statement where it stands now: the stopped line, the run's, mapped through the edits
 * made since the run started (`lineNow`, `run-lines.ts`), the code Piwi wrote at an earlier action included. An action
 * that writes code is refused when the client writes none, and before it starts when nothing can be written at the
 * stopped line; the code never goes to Piwi Picker. Every command names the stop it answers (`since`).
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionFromEvents, type RawCaptureEvent } from '@piwitests/core/recording';
import type {
  LocatorAtCaretParams,
  LocatorAtCaretResult,
  RunControlResult,
  StopActionParams,
  StopActionResult,
  StopCode,
  StopRequestsParams,
  StopRequestsResult,
} from './protocol.js';
import type { Handoff } from './recorder/handoff.js';
import type { RecordingSessions } from './recorder/sessions.js';
import type { LineNow } from './run-lines.js';
import { NO_CODE, type RunSessions, type StopRef } from './run-sessions.js';
import { caretLocator, renderStopCode, stopCodeRefusal, stopPage, type StopCodeInput } from './stop-code.js';

/** What the code of a file is written from: its text as the editor holds it, and what its rendering reads. */
export interface StopTarget {
  /** The file's URI as the workspace names it. */
  uri: string;
  text: string;
  /** The open document's version; null for the file as saved. */
  version: number | null;
  preferLocators: ReadonlySet<string>;
  /** The module `expect` is imported from when the file lacks it. */
  expectModule: string;
}

export interface StopActionsOptions {
  sessions: RunSessions;
  recordings: RecordingSessions;
  /** Whether the client writes the code (`InitializationOptions.stopCode`). */
  writesCode(): boolean;
  /** Sends the client the code to write. */
  notify(code: StopCode): void;
  /** A sentence for the client about a run's folder: a code that could not be made, after the action started. */
  notice(root: string | null, message: string): void;
  /** What a file's code is written from; null for a file no Playwright config of the workspace holds. */
  target(file: string): StopTarget | null;
  /** Where a stop's line, the run's, stands in the file's text now (`RunLines.lineNow`); why it cannot be told. */
  lineNow(stop: StopRef, target: StopTarget): LineNow;
  /** The editor's display language, for the check panel. */
  language(): string | null;
}

/** What each action writes, as a sentence names it. */
const WRITTEN: Record<StopCode['action'], string> = {
  assert: 'the check',
  'assert-region': "the region's ARIA snapshot",
  mock: 'the mock',
};

function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function refuse(message: string): RunControlResult {
  return { ok: false, message };
}

/** Why a command that names no stop is refused. */
const NEEDS_STOP = 'The command needs the stop it answers.';

export class StopActions {
  /** The runs a code was sent for: the first code of a run says the test goes on with the code it started with. */
  private readonly told = new Set<string>();

  constructor(private readonly options: StopActionsOptions) {}

  /** `piwi/stopAction`, and the hub's intents and `mock`. */
  async action(params: StopActionParams): Promise<StopActionResult> {
    const { sessions } = this.options;
    if (typeof params?.since !== 'string' || !params.since) return refuse(NEEDS_STOP);
    const stop = { ref: params.ref, worker: params.worker ?? null, since: params.since };
    switch (params.action) {
      case 'pick':
      case 'record':
        return sessions.intent({ ...stop, what: params.action });
      case 'assert':
      case 'assert-region': {
        // Nothing starts in the test's window when its code could not be written.
        if (!this.options.writesCode()) return refuse(NO_CODE);
        const at = sessions.stopOf(stop);
        if ('message' in at) return at;
        const place = this.place(at);
        if ('refusal' in place) return refuse(place.refusal);
        const cannot = stopCodeRefusal(place.target.text, place.line);
        if (cannot) return refuse(cannot);
        return sessions.intent({ ...stop, what: params.action });
      }
      case 'mock': {
        if (!this.options.writesCode()) return refuse(NO_CODE);
        const id = params.request;
        if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
          return refuse('Mock a request needs the response to mock: one of those the test kept.');
        }
        const asked = await sessions.mock(stop, id);
        if ('message' in asked) return asked;
        if (!asked.answer.ok || !asked.answer.response) return refuse(asked.answer.message);
        return this.write(asked.stop, { action: 'mock', response: asked.answer.response });
      }
      default:
        return refuse(`Piwi does not know the action ${JSON.stringify((params as { action?: unknown }).action)}.`);
    }
  }

  /** `piwi/stopRequests`, and the hub's `requests`: the responses the stopped test kept, without their bodies. */
  async requests(params: StopRequestsParams): Promise<StopRequestsResult> {
    if (typeof params?.since !== 'string' || !params.since) return { ok: false, message: NEEDS_STOP, requests: [] };
    const answer = await this.options.sessions.requests({
      ref: params.ref,
      worker: params.worker ?? null,
      since: params.since,
    });
    return { ok: answer.ok, message: answer.message, requests: answer.requests };
  }

  /**
   * `piwi/locatorAtCaret`: the matches on the stopped page of the locator at the caret's line, outlined there. The
   * chain must start from the page the test stopped on: the expression the code written at the stop runs on, in the
   * stopped file (`page`, `this.page`); another (`adminPage`), or one in another file, may be another page, and is
   * refused.
   */
  async locatorAtCaret(params: LocatorAtCaretParams): Promise<LocatorAtCaretResult> {
    const { sessions } = this.options;
    if (typeof params?.since !== 'string' || !params.since) {
      return { ok: false, message: NEEDS_STOP, locator: null, count: null };
    }
    const stop = { ref: params.ref, worker: params.worker ?? null, since: params.since };
    const clear = async (message: string, ok: boolean): Promise<LocatorAtCaretResult> => {
      const answer = await sessions.locator(stop, null);
      return answer.ok ? { ok, message, locator: null, count: null } : { ...answer, locator: null };
    };
    if (typeof params.uri !== 'string' || typeof params.line !== 'number') return clear('The outline is gone.', true);
    const file = uriToPath(params.uri);
    const target = file ? this.options.target(file) : null;
    if (!file || !target || !Number.isInteger(params.line) || params.line < 0) {
      return clear('No Playwright config of this workspace holds this file.', false);
    }
    const found = caretLocator(target.text, params.line);
    if ('refusal' in found) return clear(found.refusal, false);
    const at = sessions.stopOf(stop);
    if ('message' in at) return { ...at, locator: null, count: null };
    const stopped = uriToPath(at.uri);
    if (!stopped || path.relative(stopped, file) !== '') {
      return clear(
        `The test is stopped in ${path.basename(stopped ?? at.uri)}: ${found.page} here may be another page than the one it stopped on, so Piwi counts a locator of that file.`,
        false,
      );
    }
    const place = this.place(at);
    if ('refusal' in place) return clear(place.refusal, false);
    const page = stopPage(place.target.text, place.line);
    if ('refusal' in page) return clear(page.refusal, false);
    if (page.page !== found.page) {
      return clear(
        `The test is stopped on ${page.page}: ${found.page} may be another page, so Piwi counts a locator that starts from ${page.page}.`,
        false,
      );
    }
    const answer = await sessions.locator(stop, found.locator);
    return { ok: answer.ok, message: answer.message, locator: found.locator, count: answer.count };
  }

  /** A worker sent the region picked at its stop: its `toMatchAriaSnapshot` goes to the client. */
  region(stop: StopRef, locator: string, snapshot: string): void {
    const written = this.write(stop, { action: 'assert-region', locator, snapshot });
    if (!written.ok) this.options.notice(stop.root, written.message);
  }

  /**
   * A test asked for one check at its stop (Assert): the check panel runs in its page (`RecordingSessions.check`), and
   * the check made there goes to the client. Refused when the test went on from the stop, when the client writes no
   * code, or when nothing can be written at the stopped line.
   */
  check(handoff: Handoff): void {
    const named = handoff.stop;
    const stop = named ? this.options.sessions.stopAt(named.ref, named.worker, named.stop) : null;
    // The test hears why, and so does the client, which Assert told it had started; of a stop that ended, the test alone.
    const refused = (message: string) => {
      handoff.socket.end(`${JSON.stringify({ type: 'refused', message })}\n`);
      if (stop) this.options.notice(stop.root, `Nothing was checked: ${message}`);
    };
    if (!stop) return refused('the test went on.');
    if (!this.options.writesCode()) return refused(NO_CODE);
    const place = this.place(stop);
    if ('refusal' in place) return refused(place.refusal);
    const cannot = stopCodeRefusal(place.target.text, place.line);
    if (cannot) return refused(cannot);
    const startedAt = Date.now();
    const missing = this.options.recordings.check(handoff, {
      file: place.file,
      language: this.options.language(),
      onCheck: (event: RawCaptureEvent) => {
        const written = this.write(stop, { action: 'assert', session: sessionFromEvents([event], startedAt) });
        if (!written.ok) this.options.notice(stop.root, written.message);
      },
      onEnd: () => {},
    });
    if (missing) this.options.notice(stop.root, `Nothing was checked: ${missing}`);
  }

  /** The file a stop's code is written in, what it is written from, and the stopped line as it stands now; why not. */
  private place(stop: StopRef): { file: string; target: StopTarget; line: number } | { refusal: string } {
    const file = uriToPath(stop.uri);
    const target = file ? this.options.target(file) : null;
    if (!file || !target) return { refusal: `No Playwright config of this workspace holds ${stop.uri}.` };
    const now = this.options.lineNow(stop, target);
    return 'refusal' in now ? now : { file, target, line: now.line };
  }

  /** Render the code for a stop and send it to the client; why not otherwise. */
  private write(stop: StopRef, input: StopCodeInput): RunControlResult {
    if (!this.options.writesCode()) return refuse(NO_CODE);
    const place = this.place(stop);
    if ('refusal' in place) return refuse(place.refusal);
    const { file, target } = place;
    const rendered = renderStopCode(target.text, place.line, input, {
      preferLocators: target.preferLocators,
      expectModule: target.expectModule,
    });
    if ('refusal' in rendered) return refuse(rendered.refusal);
    const action = input.action;
    const first = !this.told.has(stop.ref);
    this.told.add(stop.ref);
    while (this.told.size > 50) this.told.delete(this.told.values().next().value!);
    const where = `${path.basename(file)}:${rendered.line + 1}`;
    const message =
      `Piwi wrote ${WRITTEN[action]} above ${where}.` +
      (first ? ' The stopped test goes on with the code it started with: the new lines run next time.' : '');
    this.options.notify({
      ref: stop.ref,
      worker: stop.worker,
      since: stop.since,
      action,
      uri: target.uri,
      version: target.version,
      line: rendered.line,
      code: rendered.code,
      edits: rendered.edits,
      message,
      warnings: rendered.warnings,
    });
    return { ok: true, message };
  }
}
