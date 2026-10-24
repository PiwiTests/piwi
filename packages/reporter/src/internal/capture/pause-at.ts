import * as path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { isInsidePath, parsePairing, type EditorSendPayload } from '@piwitests/core/editor-send';
import { pauseAnswered, showPauseBar, takePauseState, type PauseBarArg, type PauseChoice } from '@piwitests/picker-dom';
import { isCi } from './inspect-on-failure.js';
import { pickLocator, type PickedLocator, type PickerProbe } from './pick-on-failure.js';
import { PIWI_LOCAL_DEBUG_ENV } from '../config/env.js';

/**
 * Breakpoints from the editor: `PIWI_PAUSE_AT` lists lines (`file:line`,
 * semicolon-separated, relative to the working directory or absolute), and a
 * locator action or assertion whose call site is one of them pauses before it
 * runs, with Piwi's pause bar in the browser: Resume, Step, Pick a locator,
 * Finish. A locator picked there is folded into the run's snapshots, printed,
 * and posted to the editor that started the run (`PIWI_EDITOR_SEND`, its Send
 * to editor pairing address) with the line it was picked at.
 *
 * Local-only, like the failure-time overlay (`inspect-on-failure.ts`): a
 * headed browser, never under CI. Every attempt pauses.
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

const EMPTY = new PauseSet(new Set());

/** A file of `PIWI_PAUSE_AT` written as `captureCallerLocation` writes one: relative to `cwd`, with forward slashes. */
function callSiteFile(file: string, cwd: string): string {
  const slashed = file.replace(/\\/g, '/');
  const absolute = path.isAbsolute(file) || path.isAbsolute(slashed) || /^[A-Za-z]:\//.test(slashed);
  let rel = absolute ? path.relative(cwd, file) : path.normalize(slashed);
  rel = rel.split(path.sep).join('/').replace(/\\/g, '/');
  if (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
}

const ignoredLogged = new Set<string>();

/**
 * Read `PIWI_PAUSE_AT`: `tests/login.spec.ts:42;tests/pages/checkout.page.ts:9`. An entry without a line is skipped
 * and logged once per process.
 */
export function parsePauseAt(value: string | undefined, cwd: string = process.cwd()): PauseSet {
  if (!value?.trim()) return EMPTY;
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
  return lines.size ? new PauseSet(lines) : EMPTY;
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
}

export function pauseGateFromTestInfo(testInfo: TestInfo): PauseGate {
  const use = (testInfo.project?.use ?? {}) as { headless?: unknown };
  return { ci: process.env.CI, headless: use.headless };
}

/** Why a run with breakpoints does not pause; null when it does. */
export function pauseSkipReason(gate: PauseGate): string | null {
  if (isCi(gate.ci)) return 'running under CI — breakpoints pause local runs only';
  if (gate.headless !== false)
    return 'the browser is headless — re-run with --headed (or set use: { headless: false })';
  return null;
}

/**
 * The test timeout to set once a pause that began with `before` in place ends after `pausedMs`: the time the test had
 * left when it paused, given back, since the paused time counts as spent. Zero (no timeout) stays zero.
 */
export function rearmedTimeout(before: number, pausedMs: number): number {
  return before > 0 ? before + Math.max(0, Math.round(pausedMs)) : 0;
}

/** Where the bar says a test is paused: the file's name and the line, `login.spec.ts:42`. */
export function pausePlace(callerLocation: string): string {
  const col = callerLocation.lastIndexOf(':');
  const fileLine = col > 0 ? callerLocation.slice(0, col) : callerLocation;
  return fileLine.slice(fileLine.lastIndexOf('/') + 1);
}

/** An assertion's matcher as the test wrote it: `to.be.visible` is `toBeVisible`, `not.toBeVisible` when negated. */
export function assertionLabel(expression: string, isNot: boolean): string {
  const [first = '', ...rest] = expression.split('.').filter(Boolean);
  const name = first + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return `${isNot ? 'not.' : ''}${name || 'expect'}`;
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

/** Where a test pauses: the call site, the action about to run, and its locator. */
export interface PausePoint {
  /** The call site, `file:line:col` relative to the working directory. */
  location: string;
  /** The action, as `click` or `toBeVisible`. */
  action: string;
  /** The locator as source; null when unknown. */
  locator: string | null;
  /**
   * The element the action targets, highlighted while paused; null for none. Its highlight may answer something to
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
 * Pause before an action: highlight its element, lift the test timeout, show the pause bar and wait for its answer.
 * **Pick a locator** runs the picker and shows the bar again; `onPick` receives each confirmed pick. With `onRecord`
 * (the editor that started the run can record), **Record here** hands the page to it and shows the bar again once the
 * recording ended. Returns the choice that ends the pause: `resume`, `step` or `finish`; `resume` when the page
 * breaks, never throwing. The test timeout is given back the time it had left once the pause ends.
 */
export async function pauseHere(
  page: Page,
  testInfo: TestInfo,
  point: PausePoint,
  probe: PickerProbe,
  onPick: (pick: PickedLocator) => void | Promise<void>,
  onRecord?: () => Promise<void>,
): Promise<Exclude<PauseChoice, 'pick' | 'record'>> {
  const before = testInfo.timeout;
  const started = Date.now();
  let shown: unknown = null;
  try {
    testInfo.setTimeout(0);
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
      attempt: testInfo.retry > 0 ? testInfo.retry + 1 : null,
      action: point.action,
      locator: point.locator,
      record: !!onRecord,
    };
    console.log(
      `[piwi] Paused at ${point.location} before ${point.locator ? `${point.action} · ${point.locator}` : point.action}` +
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
    try {
      testInfo.setTimeout(rearmedTimeout(before, Date.now() - started));
    } catch {
      // The test may be over.
    }
  }
}
