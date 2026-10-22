import type { RawCaptureEvent } from '@piwitests/core/recording';
import { clearBugEvidence } from './bug-storage.js';
import { hasSessionArea, sessionArea } from './session-area.js';
import { t } from './i18n.js';

/**
 * The running cross-page recording (event stream + on/off state), in
 * `chrome.storage.session` — same reasoning as `session-storage.ts`'s named
 * pick session: a working session for this browser run, not a saved file.
 * Reached through `sessionArea()`, since the recorder reads and writes it from
 * a content script — see `session-area.ts`.
 *
 * Stores the *raw* event stream, not pre-coalesced steps: `normalizeSteps`
 * (from `@piwitests/core/recording`) is the single source of truth for
 * turning events into steps, and it's cheap enough to re-run over the whole
 * stream on every read that keeping two representations in sync isn't worth
 * the risk of them drifting.
 */
export const RECORDING_KEY = 'piwiRecording';

/** `actions` records a flow; `bug` records a bug report, with its HUD and the page's console and failed requests. */
export type RecordingMode = 'actions' | 'bug';

export interface RecordingState {
  active: boolean;
  events: RawCaptureEvent[];
  startedAt: number | null;
  /** The origin pattern granted for this recording (e.g. `https://app.example.com/*`) — background re-registers the content script for it on every new tab/navigation. */
  grantedOriginPattern: string | null;
  /** Absent on a recording stored before bug reports existed, which reads as `actions`. */
  mode?: RecordingMode;
  /** A bug recording's token: the main-world evidence script's messages carry it, and the recorder ignores any that do not. */
  bugToken?: string | null;
  /** Paused from the recording bar, or from the editor that started the recording: nothing done in the browser is captured until it resumes. */
  paused?: boolean;
  /**
   * A recording of actions' title, for its spec and its steps file: the first page's own title as the recording
   * reaches it, then what the review panel's field holds. Null when the page had none; absent until the first page.
   */
  title?: string | null;
}

const EMPTY: RecordingState = { active: false, events: [], startedAt: null, grantedOriginPattern: null };

export function recordingMode(state: Pick<RecordingState, 'mode'>): RecordingMode {
  return state.mode === 'bug' ? 'bug' : 'actions';
}

function newBugToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getRecordingState(): Promise<RecordingState> {
  const stored = await sessionArea().get(RECORDING_KEY);
  const value = stored[RECORDING_KEY];
  return value && typeof value === 'object' ? (value as RecordingState) : { ...EMPTY };
}

async function setRecordingState(state: RecordingState): Promise<void> {
  await sessionArea().set({ [RECORDING_KEY]: state });
}

export async function startRecording(
  grantedOriginPattern: string,
  mode: RecordingMode = 'actions',
): Promise<RecordingState> {
  await clearBugEvidence();
  const state: RecordingState = {
    active: true,
    events: [],
    startedAt: Date.now(),
    grantedOriginPattern,
    mode,
    bugToken: mode === 'bug' ? newBugToken() : null,
  };
  await setRecordingState(state);
  return state;
}

export async function stopRecording(): Promise<RecordingState> {
  const current = await getRecordingState();
  const state: RecordingState = { ...current, active: false };
  await setRecordingState(state);
  return state;
}

export async function discardRecording(): Promise<void> {
  await sessionArea().remove(RECORDING_KEY);
  await clearBugEvidence();
}

/**
 * A "Record actions" click that still needs its host permission, parked in
 * `chrome.storage.session` so the *background* can finish starting the
 * recording after the popup is gone.
 *
 * The popup can't do it itself: `chrome.permissions.request` shows a prompt
 * that takes focus and closes the popup on a first-time grant, tearing down the
 * code that awaited the grant before it can message the worker, so a first
 * recording would need a second click. The popup writes this intent
 * inside the same click, then `chrome.permissions.onAdded` in the worker reads
 * it back when the grant lands (see `decideRecordIntent`). The popup opening
 * again and the DevTools pages asking for a site (`requestSiteAccess`) clear
 * it: by then that prompt is answered, and the next grant for the site is not
 * a recording's.
 */
const RECORD_INTENT_KEY = 'piwiRecordIntent';

export interface RecordIntent {
  /** The origin pattern the popup requested (e.g. `https://app.example.com/*`). */
  originPattern: string;
  /** Which recording the click asked for. */
  mode: RecordingMode;
  /** The tab the click applied to — the already-loaded page that needs the one-off inject. */
  tabId: number;
  /** When the popup requested the grant; a stale intent is ignored rather than reviving a recording on some later, unrelated grant. */
  createdAt: number;
}

/**
 * How long a parked intent stays actionable. A permission prompt is answered in
 * seconds; well past that, a matching grant is more likely an unrelated one
 * (the options page granting the instance origin, say) than a slow answer to
 * this prompt, so the worker ignores it instead of starting a surprise recording.
 */
export const RECORD_INTENT_TTL_MS = 30_000;

export async function setRecordIntent(intent: Omit<RecordIntent, 'createdAt'>): Promise<void> {
  await sessionArea().set({ [RECORD_INTENT_KEY]: { ...intent, createdAt: Date.now() } });
}

export async function getRecordIntent(): Promise<RecordIntent | null> {
  const stored = await sessionArea().get(RECORD_INTENT_KEY);
  const value = stored[RECORD_INTENT_KEY];
  if (!value || typeof value !== 'object') return null;
  const intent = value as Partial<RecordIntent>;
  if (typeof intent.originPattern !== 'string' || typeof intent.tabId !== 'number') return null;
  return {
    originPattern: intent.originPattern,
    mode: intent.mode === 'bug' ? 'bug' : 'actions',
    tabId: intent.tabId,
    createdAt: intent.createdAt ?? 0,
  };
}

export async function clearRecordIntent(): Promise<void> {
  await sessionArea().remove(RECORD_INTENT_KEY);
}

export type RecordIntentDecision =
  | { action: 'start'; originPattern: string; tabId: number; mode: RecordingMode }
  | { action: 'clear' }
  | { action: 'ignore' };

/**
 * Pure half of the worker's `chrome.permissions.onAdded` handler: given the
 * parked intent and the origins a grant just added, decide whether to start the
 * recording, drop a stale intent, or leave everything alone.
 *
 * - `ignore` when there's no intent, or the grant didn't include the intent's
 *   own origin — the options page granting the Piwi instance origin fires the
 *   same event and must not start a recording.
 * - `clear` when the intent is older than {@link RECORD_INTENT_TTL_MS}: the
 *   prompt was left long enough that this grant is unlikely to be its answer.
 * - `start` otherwise.
 */
export function decideRecordIntent(
  intent: RecordIntent | null,
  addedOrigins: string[],
  now: number,
): RecordIntentDecision {
  if (!intent) return { action: 'ignore' };
  if (!addedOrigins.includes(intent.originPattern)) return { action: 'ignore' };
  if (now - intent.createdAt > RECORD_INTENT_TTL_MS) return { action: 'clear' };
  return { action: 'start', originPattern: intent.originPattern, tabId: intent.tabId, mode: intent.mode ?? 'actions' };
}

/**
 * Serializes appends within one document.
 *
 * An append is read-modify-write against a single storage key, and every DOM
 * listener fires one independently: two events landing together would both read
 * the same array, both write their own copy, and whichever finished second
 * would discard the other's event. A click racing a `change`, or a keydown
 * racing a pending input, is enough.
 *
 * Per-document, which is where the bursts happen — the recorder attaches to the
 * main frame of each page, and a user interacts with one page at a time. Two
 * pages appending in the same instant can still interleave; making that
 * impossible would mean routing every append through the service worker, and
 * paying a message round-trip per keystroke to close a gap nothing has been
 * observed to hit.
 *
 * In Firefox that round-trip is paid anyway — its content scripts reach session
 * storage only through the background script (see `session-area.ts`) — so
 * there every append *is* routed through it, as one message: the background
 * runs this same function, where this queue then serializes every tab's
 * appends, and the field changes of {@link updateRecording} with them.
 */
let appendQueue: Promise<unknown> = Promise.resolve();

/**
 * Appends one captured event. A no-op when recording isn't active — a
 * content script can outlive the recording being stopped from the popup in
 * another tab, so every append re-checks live state instead of trusting a
 * flag cached at injection time.
 *
 * Rejects if the write fails (a full session-storage quota, most likely); the
 * caller is expected to surface that rather than drop it, since the alternative
 * is a recording that looks healthy and exports short.
 */
export async function appendRecordingEvent(event: RawCaptureEvent): Promise<RecordingState> {
  if (!hasSessionArea()) return appendViaBackground(event);
  const run = appendQueue.then(async () => {
    const current = await getRecordingState();
    if (!current.active) return current;
    const state: RecordingState = { ...current, events: [...current.events, event] };
    await setRecordingState(state);
    return state;
  });
  // The queue itself must never stay rejected, or one failed write would poison
  // every append after it; the rejection still reaches this call's own caller.
  appendQueue = run.catch(() => undefined);
  return run;
}

/** The fields of a recording that change while it runs or is reviewed, without touching its events. */
export type RecordingChange = Partial<Pick<RecordingState, 'paused' | 'title'>>;

/**
 * Whether `stored` is the recording that started at `startedAt`, the identity a
 * recording keeps from start to discard: never a recording that is gone, nor
 * one started after it.
 */
export function isRecordingStartedAt(stored: unknown, startedAt: number | null): stored is RecordingState {
  return (
    startedAt != null &&
    !!stored &&
    typeof stored === 'object' &&
    (stored as Partial<RecordingState>).startedAt === startedAt
  );
}

/**
 * Changes the own fields of the recording that started at `startedAt`, on the
 * stored state, in the order of the appends: behind the ones this document has
 * queued, or, in a Firefox content script, behind the ones it has sent the
 * background script, which applies both kinds through one queue. An append
 * that read the state before the change is written first, then the change on
 * top of it. Resolves to null, having written nothing, when that recording is
 * no longer the stored one: discarded, or replaced by a newer recording.
 */
export async function updateRecording(
  startedAt: number | null,
  change: RecordingChange,
): Promise<RecordingState | null> {
  if (!hasSessionArea()) return updateViaBackground(startedAt, change);
  const run = appendQueue.then(async () => {
    const stored = (await sessionArea().get(RECORDING_KEY))[RECORDING_KEY];
    if (!isRecordingStartedAt(stored, startedAt)) return null;
    const state: RecordingState = { ...stored, ...change };
    await setRecordingState(state);
    return state;
  });
  appendQueue = run.catch(() => undefined);
  return run;
}

export type AppendRecordingEventResponse = { ok: true; state: RecordingState } | { ok: false; error: string };

export type UpdateRecordingResponse = { ok: true; state: RecordingState | null } | { ok: false; error: string };

/**
 * A Firefox content script's append: one message, sent at once rather than
 * after this document's previous append settles. A get and a set sent
 * separately would leave a gap in which a click that navigates away unloads
 * the page before its set goes out, losing the step that caused the
 * navigation; once this message is sent, the background finishes the write
 * whatever happens to the page.
 */
async function appendViaBackground(event: RawCaptureEvent): Promise<RecordingState> {
  const response = (await chrome.runtime.sendMessage({ type: 'piwi-append-recording-event', event })) as
    | AppendRecordingEventResponse
    | undefined;
  if (!response?.ok) throw new Error(response?.error ?? t('common_workerNoAnswer'));
  return response.state;
}

/**
 * A Firefox content script's field change: one message, which the background
 * applies after the appends this document sent before it. A get and a set sent
 * separately would write back the events the get read, dropping an append the
 * background finished in between.
 */
async function updateViaBackground(startedAt: number | null, change: RecordingChange): Promise<RecordingState | null> {
  const response = (await chrome.runtime.sendMessage({ type: 'piwi-update-recording', startedAt, change })) as
    | UpdateRecordingResponse
    | undefined;
  if (!response?.ok) throw new Error(response?.error ?? t('common_workerNoAnswer'));
  return response.state;
}

/** The background script's half of {@link appendViaBackground}. */
export async function serveAppendRecordingEvent(event: unknown): Promise<AppendRecordingEventResponse> {
  if (!event || typeof event !== 'object') return { ok: false, error: 'Malformed recording event.' };
  try {
    return { ok: true, state: await appendRecordingEvent(event as RawCaptureEvent) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The background script's half of {@link updateViaBackground}: the recording's
 * start time, then `paused` and `title` only, each of its own type.
 */
export async function serveUpdateRecording(message: {
  startedAt?: unknown;
  change?: unknown;
}): Promise<UpdateRecordingResponse> {
  const { startedAt, change } = message;
  const { paused, title } = change && typeof change === 'object' ? (change as Record<string, unknown>) : {};
  const valid: RecordingChange = {};
  if (typeof paused === 'boolean') valid.paused = paused;
  if (typeof title === 'string' || title === null) valid.title = title;
  if (typeof startedAt !== 'number' || Object.keys(valid).length === 0)
    return { ok: false, error: 'Malformed recording change.' };
  try {
    return { ok: true, state: await updateRecording(startedAt, valid) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
