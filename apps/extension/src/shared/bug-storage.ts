import {
  BUG_EVIDENCE_LIMITS,
  type BugConsoleEntry,
  type BugContext,
  type BugFailedRequest,
  type BugScreenshot,
} from '@piwitests/core/bug-report';
import { sessionArea } from './session-area.js';
import type { FallbackReason } from './cdp-input.js';
import type { RelayedEntries } from './bug-relay.js';

/**
 * A recording's evidence, in `chrome.storage.session` beside the recording
 * itself (`recording-storage.ts`).
 *
 * Kept under its own keys rather than inside `RecordingState`: every captured
 * step rewrites that state, and a screenshot is hundreds of kilobytes that
 * would be copied on each keystroke. Screenshots have a key of their own for
 * the same reason, since console entries arrive far more often.
 */
const EVIDENCE_KEY = 'piwiBugEvidence';
const SCREENSHOTS_KEY = 'piwiBugScreenshots';
/** What the background worker collects through the debugging protocol; only the worker writes it. */
export const CDP_EVIDENCE_KEY = 'piwiBugCdpEvidence';

/**
 * Why the background worker took no screenshot for a bug report: the tab has
 * no `activeTab` grant (`not-granted`), it is not the one in front
 * (`not-in-front`), or the browser failed for another reason (`failed`).
 */
export type ScreenshotFailure = 'not-granted' | 'not-in-front' | 'failed';

/** Whether a recording collects through the debugging protocol, and why not when it does not. */
export interface DebuggingState {
  state: 'on' | 'off';
  reason: FallbackReason | null;
  /** When a session that was on ended: what the page noted before then, the session collected. */
  endedAt?: number;
}

export interface CdpEvidence {
  console: BugConsoleEntry[];
  consoleDropped: number;
  requests: BugFailedRequest[];
  requestsDropped: number;
  debugging: DebuggingState | null;
}

export function emptyCdpEvidence(): CdpEvidence {
  return { console: [], consoleDropped: 0, requests: [], requestsDropped: 0, debugging: null };
}

export interface StoredBugEvidence {
  console: BugConsoleEntry[];
  consoleDropped: number;
  requests: BugFailedRequest[];
  requestsDropped: number;
  /** The outline taken at the last marked step, or at Finish when nothing was marked. */
  outline: string | null;
  /** Why the last screenshot could not be taken, until one is. */
  screenshotNote: string | null;
  /** The page's context, taken at Finish. */
  context: BugContext | null;
  /** How many screenshots are kept, so the HUD need not read them to count them. */
  screenshots: number;
  /** Whether the evidence comes through the debugging protocol (Chromium), as the worker last said. */
  debugging?: DebuggingState | null;
}

export interface StoredBugScreenshot {
  moment: BugScreenshot['moment'];
  step: number | null;
  takenAt: number;
  /** A `data:image/png;base64,…` URL. */
  dataUrl: string;
}

const EMPTY: StoredBugEvidence = {
  console: [],
  consoleDropped: 0,
  requests: [],
  requestsDropped: 0,
  outline: null,
  screenshotNote: null,
  context: null,
  screenshots: 0,
};

/** What the page relayed, as this document stores it. */
async function getPageEvidence(): Promise<StoredBugEvidence> {
  const stored = await sessionArea().get(EVIDENCE_KEY);
  const value = stored[EVIDENCE_KEY];
  return value && typeof value === 'object' ? { ...EMPTY, ...(value as StoredBugEvidence) } : { ...EMPTY };
}

function merge<T extends { time: number }>(a: T[], b: T[], limit: number): { kept: T[]; dropped: number } {
  const all = [...a, ...b].sort((x, y) => x.time - y.time);
  return { kept: all.slice(0, limit), dropped: Math.max(0, all.length - limit) };
}

/** The recording's evidence: what the page relayed and what the worker collected through the protocol. */
export async function getBugEvidence(): Promise<StoredBugEvidence> {
  const [page, stored] = await Promise.all([getPageEvidence(), sessionArea().get(CDP_EVIDENCE_KEY)]);
  const cdp = stored[CDP_EVIDENCE_KEY] as CdpEvidence | undefined;
  if (!cdp) return page;
  const console = merge(page.console, cdp.console, BUG_EVIDENCE_LIMITS.console);
  const requests = merge(page.requests, cdp.requests, BUG_EVIDENCE_LIMITS.requests);
  return {
    ...page,
    console: console.kept,
    consoleDropped: page.consoleDropped + cdp.consoleDropped + console.dropped,
    requests: requests.kept,
    requestsDropped: page.requestsDropped + cdp.requestsDropped + requests.dropped,
    debugging: cdp.debugging,
  };
}

/**
 * Serializes writes within one document, as `appendRecordingEvent` does: each
 * one reads the whole value and writes it back, and entries arrive in bursts.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function queued<T>(write: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(write);
  writeQueue = run.catch(() => undefined);
  return run;
}

async function writeEvidence(change: (current: StoredBugEvidence) => StoredBugEvidence): Promise<StoredBugEvidence> {
  const next = change(await getPageEvidence());
  await sessionArea().set({ [EVIDENCE_KEY]: next });
  return next;
}

function update(change: (current: StoredBugEvidence) => StoredBugEvidence): Promise<StoredBugEvidence> {
  return queued(() => writeEvidence(change));
}

/** Adds console entries and failed requests, keeping the first of each up to the limit and counting the rest. */
export function appendBugEntries(entries: {
  console?: BugConsoleEntry[];
  requests?: BugFailedRequest[];
}): Promise<StoredBugEvidence> {
  return update((current) => {
    const consoleEntries = [...current.console];
    const requests = [...current.requests];
    let { consoleDropped, requestsDropped } = current;
    for (const e of entries.console ?? []) {
      if (consoleEntries.length < BUG_EVIDENCE_LIMITS.console) consoleEntries.push(e);
      else consoleDropped++;
    }
    for (const r of entries.requests ?? []) {
      if (requests.length < BUG_EVIDENCE_LIMITS.requests) requests.push(r);
      else requestsDropped++;
    }
    return { ...current, console: consoleEntries, consoleDropped, requests, requestsDropped };
  });
}

export function setBugEvidenceFields(
  fields: Partial<Pick<StoredBugEvidence, 'outline' | 'screenshotNote' | 'context'>>,
): Promise<StoredBugEvidence> {
  return update((current) => ({ ...current, ...fields }));
}

export async function getBugScreenshots(): Promise<StoredBugScreenshot[]> {
  const stored = await sessionArea().get(SCREENSHOTS_KEY);
  const value = stored[SCREENSHOTS_KEY];
  return Array.isArray(value) ? (value as StoredBugScreenshot[]) : [];
}

/**
 * Keeps a screenshot, at most `BUG_EVIDENCE_LIMITS.screenshots`: once full, a
 * new one replaces the last, so the latest moment (usually Finish) is always
 * there. Clears the note saying why one was missing. In the same queue as the
 * other writes, so two screenshots taken at once are both kept. Rejects when
 * session storage has no room for it.
 */
export function addBugScreenshot(shot: StoredBugScreenshot): Promise<void> {
  return queued(async () => {
    const shots = await getBugScreenshots();
    if (shots.length >= BUG_EVIDENCE_LIMITS.screenshots) shots[shots.length - 1] = shot;
    else shots.push(shot);
    await sessionArea().set({ [SCREENSHOTS_KEY]: shots });
    await writeEvidence((current) => ({ ...current, screenshotNote: null, screenshots: shots.length }));
  });
}

export async function clearBugEvidence(): Promise<void> {
  await sessionArea().remove(EVIDENCE_KEY);
  await sessionArea().remove(SCREENSHOTS_KEY);
  await sessionArea().remove(CDP_EVIDENCE_KEY);
}

/**
 * Hands the entries a page relayed for the recording or the replay `token`
 * names to the background worker, as the page is left: one message, which the
 * worker finishes whatever becomes of the page (`background/relay-left.ts`).
 */
export function storeAsPageLeaves(token: string, entries: RelayedEntries): void {
  try {
    void Promise.resolve(chrome.runtime.sendMessage({ type: 'piwi-relay-left', token, entries })).catch(
      () => undefined,
    );
  } catch {
    // The extension context is gone: nothing is left to store them.
  }
}
