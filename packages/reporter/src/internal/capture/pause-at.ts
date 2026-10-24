import * as path from 'node:path';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { isInsidePath, parsePairing, type EditorSendPayload } from '@piwitests/core/editor-send';
import { pauseAnswered, showPauseBar, takePauseState, type PauseBarArg, type PauseChoice } from '@piwitests/picker-dom';
import { isCi } from './inspect-on-failure.js';
import { pickLocator, type PickedLocator, type PickerProbe } from './pick-on-failure.js';
import { internalCall } from './quiet-capture.js';
import { PIWI_LOCAL_DEBUG_ENV } from '../config/env.js';

/**
 * Breakpoints from the editor: `PIWI_PAUSE_AT` lists lines (`file:line`,
 * semicolon-separated, relative to the working directory or absolute), and a
 * call on one of them that acts on or checks the page (a navigation, a click, a
 * key press, an assertion) stops before it runs, through Playwright's debugger
 * (`context.debugger`), with Piwi's pause bar in the browser: Resume, Step,
 * Pick a locator, Finish. A locator picked there is folded into the run's
 * snapshots, printed, and posted to the editor that started the run
 * (`PIWI_EDITOR_SEND`, its Send to editor pairing address) with the line it was
 * picked at.
 *
 * Local-only, like the failure-time overlay (`inspect-on-failure.ts`): a
 * headed browser, never under CI, never under Playwright's Inspector
 * (`PWDEBUG`). Every attempt pauses.
 */

/** The lines a run pauses at, keyed the way `captureCallerLocation` writes a call site, without its column. */
export class PauseSet {
  constructor(private readonly lines: ReadonlySet<string>) {}

  get size(): number {
    return this.lines.size;
  }

  /** Whether a call site (`file:line:col`, as `captureCallerLocation` writes it) is on one of the lines. */
  matches(callerLocation: string | null): boolean {
    if (!callerLocation) return false;
    const col = callerLocation.lastIndexOf(':');
    return col > 0 && this.lines.has(callerLocation.slice(0, col));
  }
}

export const NO_BREAKPOINTS = new PauseSet(new Set());

/** A file of `PIWI_PAUSE_AT` written as `captureCallerLocation` writes one: relative to `cwd`, with forward slashes. */
function callSiteFile(file: string, cwd: string): string {
  const slashed = file.replace(/\\/g, '/');
  const absolute = path.isAbsolute(file) || path.isAbsolute(slashed) || /^[A-Za-z]:\//.test(slashed);
  let rel = absolute ? path.relative(cwd, file) : path.normalize(slashed);
  rel = rel.split(path.sep).join('/').replace(/\\/g, '/');
  if (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
}

/**
 * The place of a debugger stop (`pausedDetails().location`, an absolute file) as a call site, `file:line:col`
 * relative to `cwd` the way `captureCallerLocation` writes one. Null for a place outside the user's code, which has no
 * line.
 */
export function stopCallSite(
  location: { file: string; line?: number; column?: number },
  cwd: string = process.cwd(),
): string | null {
  if (!location.line) return null;
  return `${callSiteFile(location.file, cwd)}:${location.line}:${location.column ?? 0}`;
}

/** A call site without its column (`file:line`): the key a stop finds the locator call on its line by. */
export function callSiteLine(callSite: string): string {
  const col = callSite.lastIndexOf(':');
  return col > 0 ? callSite.slice(0, col) : callSite;
}

const ignoredLogged = new Set<string>();

/**
 * Read `PIWI_PAUSE_AT`: `tests/login.spec.ts:42;tests/pages/checkout.page.ts:9`. An entry without a line is skipped
 * and logged once per process.
 */
export function parsePauseAt(value: string | undefined, cwd: string = process.cwd()): PauseSet {
  if (!value?.trim()) return NO_BREAKPOINTS;
  const lines = new Set<string>();
  for (const raw of value.split(';')) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = /^(.+):(\d+)$/.exec(entry);
    const line = m ? Number(m[2]) : 0;
    if (!m?.[1] || line < 1) {
      if (!ignoredLogged.has(entry)) {
        ignoredLogged.add(entry);
        console.log(`[piwi] ${PIWI_LOCAL_DEBUG_ENV.pauseAt}: ignoring "${entry}": expected file:line`);
      }
      continue;
    }
    lines.add(`${callSiteFile(m[1], cwd)}:${line}`);
  }
  return lines.size ? new PauseSet(lines) : NO_BREAKPOINTS;
}

let parsed: { value: string | undefined; set: PauseSet } | null = null;

/** The lines this process pauses at, read again only when `PIWI_PAUSE_AT` changes. */
export function currentPauseSet(): PauseSet {
  const value = process.env[PIWI_LOCAL_DEBUG_ENV.pauseAt];
  if (!parsed || parsed.value !== value) parsed = { value, set: parsePauseAt(value) };
  return parsed.set;
}

/** Everything the pause gate reads, as plain values. */
export interface PauseGate {
  /** Raw `CI` env value. Anything except unset/empty/`'false'` counts as CI. */
  ci: string | undefined;
  /** `testInfo.project.use.headless`: must be explicitly `false` (headed). */
  headless: unknown;
  /** Raw `PWDEBUG` env value: Playwright's Inspector drives the debugger unless it is unset, empty, `0`, `false` or `console`. */
  pwdebug?: string | undefined;
}

export function pauseGateFromTestInfo(testInfo: TestInfo): PauseGate {
  const use = (testInfo.project?.use ?? {}) as { headless?: unknown };
  return { ci: process.env.CI, headless: use.headless, pwdebug: process.env.PWDEBUG };
}

/** Why a run with breakpoints does not pause; null when it does. */
export function pauseSkipReason(gate: PauseGate): string | null {
  if (isCi(gate.ci)) return 'running under CI — breakpoints pause local runs only';
  if (gate.headless !== false)
    return 'the browser is headless — re-run with --headed (or set use: { headless: false })';
  if (gate.pwdebug && !['0', 'false', 'console'].includes(gate.pwdebug))
    return "Playwright's Inspector runs the test (PWDEBUG) — run without --debug";
  return null;
}

/** Why the pause bar shows at a stop: a breakpoint's line, the first call after Step, or `page.pause()`. */
export type StopReason = 'breakpoint' | 'step' | 'page-pause';

/** How the debugger goes on from a stop: `next` stops again before the next call, `resume` runs on freely. */
export type GoOn = 'next' | 'resume';

/** The answers that end a stop. */
export type PauseAnswer = Exclude<PauseChoice, 'pick' | 'record'>;

/** What an attempt pauses at: the run's breakpoints, a Step asked at the last stop, and Finish. */
export interface PauseState {
  set: PauseSet;
  /** The next stop in the user's code shows, whatever its line. */
  step: boolean;
  /** No stop shows any more in this attempt, but at `page.pause()`. */
  finished: boolean;
}

/**
 * What the worker does at a debugger stop on `callSite` (null outside the user's code): show the bar, at a
 * breakpoint's line or the first stop after Step (which that stop uses up), or let the call go on at once.
 */
export function atStop(state: PauseState, callSite: string | null): { show: StopReason } | { go: GoOn } {
  if (callSite && !state.finished) {
    if (state.step) {
      state.step = false;
      return { show: 'step' };
    }
    if (state.set.matches(callSite)) return { show: 'breakpoint' };
  }
  return { go: goOn(state) };
}

/**
 * How the debugger goes on from a stop, once the bar's `answer` applies: it keeps stopping before every call while
 * breakpoints remain or a Step waits, so the next breakpoint's line is seen; it runs on freely otherwise.
 */
export function goOn(state: PauseState, answer?: PauseAnswer): GoOn {
  if (answer === 'step') state.step = true;
  else if (answer === 'finish') state.finished = true;
  return !state.finished && (state.step || state.set.size > 0) ? 'next' : 'resume';
}

/** One stop the bar showed, as the `piwi-pauses` attachment lists it. */
export interface PauseRecord {
  /** The call the stop held, as Playwright titles it: `Click getByRole('button', { name: 'Pay' })`. */
  title: string;
  /** Its call site, `file:line:col` relative to the working directory. */
  location: string;
  reason: StopReason;
  /** When the stop began, in epoch ms. */
  startedAt: number;
  /** How long it held the call, in ms. */
  duration: number;
}

/** The part of Playwright's `context.debugger` the pause drives. */
interface ContextDebugger {
  on(event: 'pausedstatechanged', listener: () => void): unknown;
  pausedDetails(): { location: { file: string; line?: number; column?: number }; title: string } | null;
  requestPause(): Promise<void>;
  next(): Promise<void>;
  resume(): Promise<void>;
}

/** A context's debugger; null on a Playwright without one. */
export function contextDebugger(context: BrowserContext): ContextDebugger | null {
  const dbg = (context as unknown as { debugger?: Partial<ContextDebugger> }).debugger;
  return typeof dbg?.requestPause === 'function' && typeof dbg.on === 'function' ? (dbg as ContextDebugger) : null;
}

const WATCHED = new WeakSet<BrowserContext>();

/**
 * Hand each stop of a context's debugger to `onStop`, once per context. In a headed browser Playwright opens its
 * Inspector at a stop: `PW_CODEGEN_NO_INSPECTOR` keeps it closed in this worker, since Piwi's bar answers the stops.
 * False on a Playwright without a debugger.
 */
export function watchStops(context: BrowserContext, onStop: (context: BrowserContext) => void): boolean {
  const dbg = contextDebugger(context);
  if (!dbg) return false;
  if (WATCHED.has(context)) return true;
  WATCHED.add(context);
  process.env.PW_CODEGEN_NO_INSPECTOR ??= '1';
  dbg.on('pausedstatechanged', () => onStop(context));
  return true;
}

/**
 * Steer a context's debugger, as an internal call so it is no step of the test: `pause` before its next call, or go
 * on from a stop. Never throws: a debugger already paused, no longer paused or closed is left as it is.
 */
export async function steerDebugger(context: BrowserContext, how: 'pause' | GoOn): Promise<void> {
  const dbg = contextDebugger(context);
  if (!dbg) return;
  try {
    await internalCall(context, () =>
      how === 'pause' ? dbg.requestPause() : how === 'next' ? dbg.next() : dbg.resume(),
    );
  } catch {
    // Nothing to steer.
  }
}

type IgnoreTimeouts = { _setIgnoreTimeouts?: (ignore: boolean) => void };

/**
 * Hold the test timeout while `run` runs, through the test runner's own counter (a Playwright internal,
 * feature-detected), as the runner does for a stop of a context the test made. A stop in a context made before the
 * test, in a `beforeAll`, is held this way only.
 */
export async function withTestTimeoutHeld<T>(testInfo: TestInfo, run: () => Promise<T>): Promise<T> {
  const set = (testInfo as unknown as IgnoreTimeouts)._setIgnoreTimeouts;
  if (typeof set !== 'function') return run();
  set.call(testInfo, true);
  try {
    return await run();
  } finally {
    set.call(testInfo, false);
  }
}

/** Where the bar says a test is paused: the file's name and the line, `login.spec.ts:42`. */
export function pausePlace(callerLocation: string): string {
  const fileLine = callSiteLine(callerLocation);
  return fileLine.slice(fileLine.lastIndexOf('/') + 1);
}

/** The place a pick belongs to, for the editor: a path relative to the run without `..`, and the line. */
export function pickPlace(callerLocation: string): { file: string; line: number } | null {
  const m = /^(.+):(\d+):\d+$/.exec(callerLocation);
  if (!m) return null;
  const file = m[1]!;
  if (!isInsidePath(file)) return null;
  return { file, line: Number(m[2]) };
}

/** The body posted to the editor for a locator picked at `callerLocation`. */
export function pickPayload(locator: string, callerLocation: string): EditorSendPayload {
  const at = pickPlace(callerLocation);
  return at ? { kind: 'locator', text: locator, at } : { kind: 'locator', text: locator };
}

let postFailureLogged = false;

/**
 * Post a picked locator to the editor that started the run (`PIWI_EDITOR_SEND`). A pairing that does not parse, a
 * refused or failed post is logged once per process; nothing is thrown.
 */
export async function postPickToEditor(
  pairingAddress: string | undefined,
  payload: EditorSendPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!pairingAddress) return false;
  const logOnce = (why: string) => {
    if (postFailureLogged) return;
    postFailureLogged = true;
    console.log(`[piwi] Could not send the picked locator to the editor: ${why}.`);
  };
  const pairing = parsePairing(pairingAddress);
  if (!pairing) {
    logOnce(`${PIWI_LOCAL_DEBUG_ENV.editorSend} is not a pairing address`);
    return false;
  }
  try {
    const response = await fetchImpl(pairing.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return true;
    logOnce(`the editor answered ${response.status}`);
  } catch (error) {
    logOnce(error instanceof Error ? error.message : String(error));
  }
  return false;
}

/** Test-only: forget that a post failure was logged. */
export function resetPauseLogs(): void {
  postFailureLogged = false;
  skipLogged = false;
  ignoredLogged.clear();
}

let skipLogged = false;

/** Say once per process why a run with breakpoints does not pause. */
export function logPauseSkipOnce(reason: string): void {
  if (skipLogged) return;
  skipLogged = true;
  console.log(`[piwi] ${PIWI_LOCAL_DEBUG_ENV.pauseAt} is set but breakpoints are skipped: ${reason}`);
}

/** Where a test is stopped: the call site, the call about to run, and the element it acts on. */
export interface PausePoint {
  /** The call site, `file:line:col` relative to the working directory. */
  location: string;
  /** The call about to run, as Playwright titles it: `Click getByRole('button', { name: 'Pay' })`. */
  call: string;
  /** The attempt, 1-based, when the test is retried; null on the first attempt. */
  attempt: number | null;
  /**
   * The element the call acts on, highlighted while stopped; null for none. Its highlight may answer something to
   * `dispose()` of, which hides it.
   */
  target: { highlight?: () => Promise<unknown> } | null;
}

/** What Playwright says when a navigation took away the document a call ran in. */
const NAVIGATED = /Execution context was destroyed|Cannot find context with specified id/;
/** How many navigations in a row the pause bar is shown again after. */
const MAX_NAVIGATED = 10;

/** How long the highlight may take before the bar shows without it. */
const HIGHLIGHT_MS = 2000;

/**
 * Show the pause bar at a stop: highlight the element, show the bar and wait for its answer. **Pick a locator** runs
 * the picker and shows the bar again; `onPick` receives each confirmed pick. With `onRecord` (the editor that started
 * the run can record), **Record here** hands the page to it and shows the bar again once the recording ended. Returns
 * the answer that ends the stop: `resume`, `step` or `finish`; `resume` when the page breaks, never throwing. The bar
 * and the highlight are gone once it returns. Every page call it makes must run inside an internal call.
 */
export async function pauseHere(
  page: Page,
  point: PausePoint,
  probe: PickerProbe,
  onPick: (pick: PickedLocator) => void | Promise<void>,
  onRecord?: () => Promise<void>,
): Promise<PauseAnswer> {
  let shown: unknown = null;
  try {
    const highlight = point.target?.highlight;
    if (typeof highlight === 'function') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      shown = await Promise.race([
        Promise.resolve()
          .then(() => highlight.call(point.target))
          .catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), HIGHLIGHT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    const arg: PauseBarArg = {
      place: pausePlace(point.location),
      attempt: point.attempt,
      action: point.call,
      locator: null,
      record: !!onRecord,
    };
    console.log(
      `[piwi] Paused at ${callSiteLine(point.location)} before ${point.call}` +
        `: Resume, Step, Pick a locator${onRecord ? ', Record here' : ''} or Finish in the browser (Esc resumes).`,
    );
    // A navigation that lands while the bar is drawn or read takes its document away: the bar comes back in the next
    // one, a few times in a row at most. A closed page, or anything else, resumes.
    let navigated = 0;
    for (;;) {
      try {
        await page.evaluate(showPauseBar, arg);
        await page.waitForFunction(pauseAnswered, undefined, { timeout: 0, polling: 250 });
        const choice = (await page.evaluate(takePauseState)) as PauseChoice | null;
        navigated = 0;
        if (choice === 'resume' || choice === 'step' || choice === 'finish') return choice;
        if (choice === 'record' && onRecord) {
          await onRecord().catch(() => undefined);
          continue;
        }
        if (choice !== 'pick') continue;
        const picked = await pickLocator(page, probe, null).catch(() => null);
        if (picked) await onPick(picked);
      } catch (error) {
        if (page.isClosed() || !NAVIGATED.test(String(error)) || ++navigated > MAX_NAVIGATED) throw error;
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      }
    }
  } catch {
    return 'resume';
  } finally {
    try {
      const dispose = (shown as { dispose?: () => Promise<void> } | null)?.dispose;
      // Feature-detected: an older Playwright has neither a disposable highlight nor `page.hideHighlight`.
      const hide = (page as unknown as { hideHighlight?: () => Promise<void> }).hideHighlight;
      if (typeof dispose === 'function') await dispose.call(shown);
      else if (typeof hide === 'function') await hide.call(page);
    } catch {
      // The page may be gone.
    }
  }
}
