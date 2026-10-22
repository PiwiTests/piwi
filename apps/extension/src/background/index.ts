import {
  startRecording,
  getRecordingState,
  discardRecording,
  getRecordIntent,
  clearRecordIntent,
  decideRecordIntent,
  serveAppendRecordingEvent,
  serveUpdateRecording,
  type RecordingMode,
} from '../shared/recording-storage.js';
import {
  getReplayState,
  getReplayTab,
  newReplayState,
  setReplayState,
  setReplayTab,
  type ReplayState,
} from '../shared/replay-storage.js';
import { pageKey } from '@piwitests/core/page-key';
import { parseSteps, sessionFromSteps } from '@piwitests/core/steps';
import { postToEditor } from '../shared/piwi-client.js';
import { editorOriginPattern, getEditorPairing } from '../shared/editor-pairing.js';
import { hostPattern } from '../shared/web-origin.js';
import { moveLegacySecrets } from '../shared/legacy-secrets.js';
import type { SendToEditorResult } from '../shared/editor-send.js';
import type { ScreenshotFailure } from '../shared/bug-storage.js';
import { parsePairing, type EditorSendPayload } from '@piwitests/core/editor-send';
import { BUILD_ID } from '../shared/build-id.js';
import { serveSessionStorage, sessionArea } from '../shared/session-area.js';
import { LANGUAGE_KEY, initI18n, isLanguage, t } from '../shared/i18n.js';
import { refreshLanguageChoice, storeLanguageChoice } from './language-choice.js';
import {
  handleBugSendTarget,
  handleGetBugReport,
  handleListBugReports,
  handleSendBugReport,
  handleShareReproduction,
  handleShareTarget,
} from './bug-reports.js';
import {
  CONDITIONS_KEY,
  isCondition,
  isCpuRate,
  isThrottle,
  type ConditionsState,
  type ConditionsVia,
} from '../shared/request-conditions.js';
import {
  applyThroughDebugger,
  clearTabViewport,
  onConditionsDebuggerLost,
  releaseConditionsDebugger,
  setTabViewport,
} from './cdp-conditions.js';
import { handleDesktopRepro, handleDesktopReproStatus, handleDesktopTarget } from './desktop-repro.js';
import { handleRefreshCatalog, handleRefreshLocatorIndex } from './project-refresh.js';
import { fromExtensionPage } from './senders.js';
import {
  handleReplayDriver,
  handleReplayInput,
  handleReplayViewport,
  releaseReplayDebugger,
  releaseReplayTab,
} from './cdp-replay.js';
import { debuggerAvailable, tabsHolding } from './debugger.js';
import { tabZoom } from './viewport-emulation.js';
import {
  clearViewsWithRecording,
  handleGetStepViews,
  handleReplayStepView,
  handleStepView,
  prepareReplayViews,
} from './step-views.js';
import { handleRelayLeft } from './relay-left.js';
import { connectionChanged, syncInstanceMarker } from './instance-marker.js';
import {
  captureThroughDebugger,
  collectsThroughDebugger,
  onBugDebuggerLost,
  startBugDebugger,
  stopBugDebugger,
} from './cdp-evidence.js';

/**
 * The Options language, read at startup and again whenever it changes. Every
 * handler that answers with a text waits for it first.
 */
let i18nReady = initI18n();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && LANGUAGE_KEY in changes) i18nReady = initI18n();
});

// A secret an older version kept where content scripts can read it moves to the secret area as the worker starts.
void moveLegacySecrets();

// The connected instance's pages carry the marker the dashboard looks for (`instance-marker.ts`).
void syncInstanceMarker();
chrome.storage.onChanged.addListener((changes, area) => {
  if (connectionChanged(changes, area)) void syncInstanceMarker();
});
chrome.permissions.onRemoved.addListener(() => {
  void syncInstanceMarker();
});

// An update ships new texts: the stored copy of the chosen catalog is read again.
chrome.runtime.onInstalled.addListener(() => {
  void refreshLanguageChoice().catch((err: unknown) => console.warn('[Piwi Picker] language catalog refresh:', err));
});

async function handleSetLanguage(code: unknown): Promise<{ ok: boolean; error?: string }> {
  if (code !== null && !isLanguage(code)) return { ok: false, error: String(code) };
  try {
    await storeLanguageChoice(code);
    i18nReady = initI18n();
    await i18nReady;
    await showStateBadge();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const RECORDING_BADGE_COLOR = '#dc2626';
const REPLAY_BADGE_COLOR = '#7c3aed';

/**
 * The toolbar badge for what runs now: a recording, else a replay, else
 * nothing. Decided from the stored states, never from the badge's own text,
 * which depends on the language.
 */
async function showStateBadge(): Promise<void> {
  await i18nReady;
  const [recording, replay] = await Promise.all([getRecordingState(), getReplayState()]);
  if (recording.active) {
    await chrome.action.setBadgeText({ text: t(recording.mode === 'bug' ? 'badge_bug' : 'badge_recording') });
    await chrome.action.setBadgeBackgroundColor({ color: RECORDING_BADGE_COLOR });
  } else if (replay && (replay.status === 'running' || replay.status === 'paused')) {
    await chrome.action.setBadgeText({ text: t('badge_replay') });
    await chrome.action.setBadgeBackgroundColor({ color: REPLAY_BADGE_COLOR });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

/**
 * Service worker: the keyboard-shortcut trigger for picking (the toolbar
 * icon's click opens the popup instead, per `action.default_popup` in the
 * manifest — the popup injects the content script itself, needing no
 * message through here). `chrome.commands` firing is itself the qualifying
 * user gesture for `activeTab`, so this can inject directly.
 */
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'pick-element') return;
  void runPickCommand(tab);
});

async function runPickCommand(tab?: chrome.tabs.Tab): Promise<void> {
  // The event usually carries the tab, but not on every platform or path —
  // falling back to the active tab beats silently doing nothing, which is
  // indistinguishable from the shortcut not being bound at all.
  const tabId = tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['pick.js'] });
  } catch (err) {
    // Restricted page (chrome://, the Web Store, the PDF viewer): nothing to
    // inject into. Logged rather than left as an unhandled rejection.
    console.warn('[Piwi Picker] the pick shortcut cannot run on this page:', err);
  }
}

// chrome.storage.session defaults to extension-page-only access; the pick
// session and the recording (`recording-storage.ts`) are read and
// written directly from content scripts, so this widens access once at
// startup rather than routing every storage call through a background
// message handler.
//
// Kept as a promise because this worker is torn down when idle and restarted
// on demand: a content script injected at `document_start` can easily run
// before the restart has applied the wider access level, and a session-storage
// read from a content script *throws* until it has. `piwi-ping` below lets a
// content script wait for exactly that (see `shared/session-access.ts`) —
// without it the recorder's HUD would fail to appear at random.
//
// Called inside `.then` because Firefox has no `setAccessLevel`: calling it
// directly throws there, synchronously, which would stop this script before any
// listener below is registered. Content scripts in Firefox reach session
// storage through `piwi-session-storage` instead (see `shared/session-area.ts`).
const sessionAccessReady = Promise.resolve()
  .then(() => chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }))
  .catch(() => undefined);

const RECORD_SCRIPT_ID = 'piwi-record-panel';
/** The bug recording's main-world script: console errors and failed requests, registered only while one runs. */
const BUG_EVIDENCE_SCRIPT_ID = 'piwi-bug-evidence';
const RECORDING_SCRIPT_IDS = [RECORD_SCRIPT_ID, BUG_EVIDENCE_SCRIPT_ID];

/**
 * Unregisters whichever of `ids` are registered. Chrome refuses the whole call
 * when one of the ids is not registered, as the bug recording's script is not
 * during an actions recording.
 */
async function unregisterScripts(ids: string[]): Promise<void> {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (registered.length > 0) await chrome.scripting.unregisterContentScripts({ ids: registered.map((s) => s.id) });
  } catch {
    // Nothing registered to remove.
  }
}

/**
 * `chrome.scripting.registerContentScripts`/`unregisterContentScripts` and
 * `chrome.action.*` aren't reachable from a content script, so the recorder
 * routes its start/stop through here even though `popup.ts` and
 * `record-panel.ts` could otherwise talk to `chrome.storage` directly (and
 * do, for everything else). The popup requests the host permission itself
 * (it needs to happen inside its own click handler to count as a user
 * gesture) and only sends the already-granted origin pattern here.
 */
async function handleStartRecording(
  originPattern: string,
  tabId: number,
  mode: RecordingMode,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await startRecording(originPattern, mode);
    // Best-effort: a previous recording that ended without a clean `stop`
    // (crashed tab, browser killed mid-session) can leave a stale
    // registration behind — `persistAcrossSessions: false` means it never
    // survives a full browser restart, only the current one.
    await unregisterScripts(RECORDING_SCRIPT_IDS);
    // A bug recording also runs a script in the page's main world, the only
    // place that sees the page's console and its fetch/XHR calls, under the
    // same origin grant and only for as long as the recording.
    const bugScripts: chrome.scripting.RegisteredContentScript[] =
      mode === 'bug'
        ? [
            {
              id: BUG_EVIDENCE_SCRIPT_ID,
              js: ['bug-evidence-main.js'],
              matches: [originPattern],
              runAt: 'document_start',
              world: 'MAIN',
              persistAcrossSessions: false,
            },
          ]
        : [];
    await chrome.scripting.registerContentScripts([
      ...bugScripts,
      {
        id: RECORD_SCRIPT_ID,
        js: ['record-panel.js'],
        matches: [originPattern],
        runAt: 'document_start',
        persistAcrossSessions: false,
      },
    ]);
    // The registration above only applies to *future* navigations — the
    // already-loaded current page needs its own one-off injection.
    if (mode === 'bug') {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['bug-evidence-main.js'], world: 'MAIN' });
    }
    // Chrome: the console, the requests and screenshots through the debugging protocol, in the tab the report
    // starts in. The page's script above stays registered for the other tabs, and takes over if this fails.
    if (mode === 'bug') await startBugDebugger(tabId, originPattern);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['record-panel.js'] });
    await i18nReady;
    await chrome.action.setBadgeText({ text: t(mode === 'bug' ? 'badge_bug' : 'badge_recording') });
    await chrome.action.setBadgeBackgroundColor({ color: RECORDING_BADGE_COLOR });
    return { ok: true };
  } catch (err) {
    // `startRecording` has already written `active: true`, so a failure after it
    // would leave a recording that captures nothing while the popup offers
    // "Stop recording (0)". Unwind everything this function may have put in place:
    // the debugging session first, since letting it go writes what it still holds.
    await stopBugDebugger().catch(() => undefined);
    await discardRecording().catch(() => undefined);
    await unregisterScripts(RECORDING_SCRIPT_IDS);
    await showStateBadge().catch(() => undefined);
    return { ok: false, error: err instanceof Error ? err.message : t('common_recordingStartFailed') };
  }
}

/**
 * Guards against starting the same recording twice.
 *
 * A first "Record actions" click resolves its grant down two paths that both
 * land here: the popup's own `piwi-start-recording` message (when the popup
 * survives the permission prompt) and `chrome.permissions.onAdded` (when the
 * prompt closed it). `startInFlight` is set synchronously before the first
 * await, so a second trigger arriving mid-start sees it and bails; the
 * persisted `active` flag covers the two arriving far enough apart — or the
 * worker being torn down between them — that the flag has already reset.
 */
let startInFlight = false;

async function startRecordingOnce(
  originPattern: string,
  tabId: number,
  mode: RecordingMode,
): Promise<{ ok: boolean; error?: string }> {
  if (startInFlight) return { ok: true };
  startInFlight = true;
  try {
    if ((await getRecordingState()).active) return { ok: true };
    return await handleStartRecording(originPattern, tabId, mode);
  } finally {
    startInFlight = false;
    // The intent has done its job (or failed to) — never leave it to revive a
    // recording on some later, unrelated grant.
    await clearRecordIntent().catch(() => undefined);
  }
}

/**
 * Finishes a recording the popup asked for but couldn't start itself.
 *
 * The popup requests the host permission inside its click (the only place the
 * gesture is live), but the prompt takes focus and closes the popup on a
 * first-time grant — killing the code that would have sent
 * `piwi-start-recording`. The popup leaves a `RecordIntent` in session storage
 * before requesting; this fires when the grant lands and picks the intent back
 * up. `decideRecordIntent` filters out grants that aren't ours (the options
 * page granting the Piwi instance origin fires the same event) and intents too
 * old to still be this prompt's answer.
 */
async function handlePermissionAdded(addedOrigins: string[]): Promise<void> {
  const decision = decideRecordIntent(await getRecordIntent(), addedOrigins, Date.now());
  if (decision.action === 'ignore') return;
  if (decision.action === 'clear') {
    await clearRecordIntent().catch(() => undefined);
    return;
  }
  await startRecordingOnce(decision.originPattern, decision.tabId, decision.mode);
}

// The person cancelled the debugging bar during a bug recording: the recorder's page relay takes over.
onBugDebuggerLost(async () => {
  const { grantedOriginPattern, active } = await getRecordingState();
  if (active) await notifyRecorderTabs(grantedOriginPattern, undefined, { type: 'piwi-bug-debugger-lost' });
});

// A bug recording's step screenshots go with it.
clearViewsWithRecording();

chrome.permissions.onAdded.addListener((permissions) => {
  void handlePermissionAdded(permissions.origins ?? []);
  void syncInstanceMarker();
});

/**
 * Tells every tab still running the recorder that capture is over, so each one
 * drops its HUD and its "this tab is being recorded" border.
 *
 * `chrome.tabs.sendMessage`, since `chrome.runtime.sendMessage` reaches
 * extension pages and this worker but never a content script. Scoped to the
 * origin the user granted for this recording — the only tabs the script was
 * ever registered for, and the only ones this extension has host access to.
 */
async function notifyRecorderTabs(
  originPattern: string | null,
  exceptTabId?: number,
  message: { type: string; paused?: boolean } = { type: 'piwi-recording-stopped' },
): Promise<void> {
  if (!originPattern) return;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: originPattern });
  } catch {
    return; // Malformed pattern, or access revoked mid-recording — nothing to notify.
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null || tab.id === exceptTabId) return;
      // A tab with no recorder attached (never navigated into the recording,
      // or already torn down) rejects with "no receiving end" — expected.
      await chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
    }),
  );
}

async function handleRecordingStopped(senderTabId?: number): Promise<void> {
  // Read before unregistering: the granted pattern is the only record of which
  // tabs could be running the recorder.
  const { grantedOriginPattern } = await getRecordingState();
  await stopBugDebugger();
  await unregisterScripts(RECORDING_SCRIPT_IDS);
  // A replay still running keeps its badge.
  await showStateBadge();
  // The sender, if it was a content script, has already torn itself down.
  await notifyRecorderTabs(grantedOriginPattern, senderTabId);
}

/**
 * A screenshot of the tab a bug recording runs in, for its report.
 *
 * In Chrome, through the recording's debugging session (`Page.captureScreenshot`):
 * at any moment and on any page of the recording. Without it (Firefox, a
 * session refused or cancelled), `captureVisibleTab`, which needs `<all_urls>`
 * or the `activeTab` grant: the recorder's per-origin host permission is not
 * enough. `activeTab` is granted by opening the popup on the tab (as the Report
 * a bug click does) or by the keyboard shortcut, and lasts until the tab
 * navigates; outside it Chrome refuses, and the report says there is no
 * screenshot rather than asking for a wider permission.
 */
async function handleBugScreenshot(
  tab: chrome.tabs.Tab | undefined,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string; reason: ScreenshotFailure }> {
  await i18nReady;
  if (tab?.id == null || tab.windowId == null) {
    return { ok: false, error: t('common_screenshotNoTab'), reason: 'failed' };
  }
  const viaDebugger = await captureThroughDebugger(tab.id);
  if (viaDebugger) return { ok: true, dataUrl: viaDebugger };
  if (!tab.active) return { ok: false, error: t('common_screenshotTabHidden'), reason: 'not-in-front' };
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { ok: true, dataUrl };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Chrome and Firefox name the grant they want: `activeTab` (or `<all_urls>`).
    return { ok: false, error, reason: /activeTab|all_urls/i.test(error) ? 'not-granted' : 'failed' };
  }
}

/** Slow down or fail a request: the main-world wrapper and its isolated-world relay, registered while a condition is on. */
const CONDITION_SCRIPT_IDS = ['piwi-conditions-main', 'piwi-conditions'];

async function getConditionsState(): Promise<ConditionsState | null> {
  const value = (await sessionArea().get(CONDITIONS_KEY))[CONDITIONS_KEY] as ConditionsState | undefined;
  return value && typeof value.tabId === 'number' && Array.isArray(value.conditions) ? value : null;
}

/** Setting and clearing the conditions run one at a time, so a quick on then off ends off. */
let conditionsQueue: Promise<unknown> = Promise.resolve();

function inConditionsQueue<T>(work: () => Promise<T>): Promise<T> {
  const run = conditionsQueue.then(work);
  conditionsQueue = run.catch(() => undefined);
  return run;
}

/**
 * Turns the conditions off: the scripts are unregistered, the debugging
 * session is let go, and the tab they were on reloads, since its `fetch` and
 * XHR stay wrapped until it does.
 */
function clearConditions(reload: boolean): Promise<void> {
  return inConditionsQueue(() => clearConditionsNow(reload));
}

async function clearConditionsNow(reload: boolean): Promise<void> {
  const state = await getConditionsState();
  await sessionArea().remove(CONDITIONS_KEY);
  await unregisterScripts(CONDITION_SCRIPT_IDS);
  if (state) await releaseConditionsDebugger(state.tabId).catch(() => undefined);
  if (reload && state) await chrome.tabs.reload(state.tabId).catch(() => undefined);
}

/**
 * Registers the scripts for the conditions' origin and injects them into the
 * tab's page now: the banner always, the page's `fetch`/XHR wrapper only when
 * the conditions go through it rather than through the debugging protocol.
 */
async function registerConditionScripts(state: ConditionsState, pattern: string): Promise<void> {
  const viaPage = state.via !== 'debugger';
  await unregisterScripts(CONDITION_SCRIPT_IDS);
  await chrome.scripting.registerContentScripts([
    ...(viaPage
      ? [
          {
            id: CONDITION_SCRIPT_IDS[0]!,
            js: ['request-conditions-main.js'],
            matches: [pattern],
            runAt: 'document_start' as const,
            world: 'MAIN' as const,
            persistAcrossSessions: false,
          },
        ]
      : []),
    {
      id: CONDITION_SCRIPT_IDS[1]!,
      js: ['request-conditions.js'],
      matches: [pattern],
      runAt: 'document_start',
      persistAcrossSessions: false,
    },
  ]);
  const target = { tabId: state.tabId };
  if (viaPage) await chrome.scripting.executeScript({ target, files: ['request-conditions-main.js'], world: 'MAIN' });
  await chrome.scripting.executeScript({ target, files: ['request-conditions.js'] });
}

/**
 * Puts conditions on one tab, from the Piwi panel, which has asked for the
 * page's origin inside the click: requests to slow down or fail, the whole
 * page's network, the CPU. In Chrome and Edge they go through the debugging
 * protocol (every request, and the throttling); without it, the requests'
 * conditions go through the page's `fetch`/XHR wrapper, registered for the
 * origin so the tab's next pages keep them, and throttling is not offered.
 * Nothing on turns them all off.
 */
function handleSetConditions(message: SetConditionsMessage): Promise<{ ok: boolean; error?: string }> {
  return inConditionsQueue(() => setConditionsNow(message));
}

interface SetConditionsMessage {
  tabId?: unknown;
  origin?: unknown;
  conditions?: unknown;
  throttle?: unknown;
  cpuRate?: unknown;
}

async function setConditionsNow(message: SetConditionsMessage): Promise<{ ok: boolean; error?: string }> {
  await i18nReady;
  const pattern = replayOriginPattern(message.origin);
  const conditions = Array.isArray(message.conditions) ? message.conditions.filter(isCondition) : [];
  const throttle = isThrottle(message.throttle) ? message.throttle : null;
  const cpuRate = isCpuRate(message.cpuRate) ? message.cpuRate : null;
  if (!pattern || typeof message.tabId !== 'number') return { ok: false, error: t('devtools_conditionsNoPage') };
  if (conditions.length === 0 && !throttle && !cpuRate) {
    await clearConditionsNow(true);
    return { ok: true };
  }
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ok: false, error: t('devtools_conditionsNeedAccess') };
  }
  // Only on a tab that shows the origin they are for.
  if (originOf((await chrome.tabs.get(message.tabId).catch(() => null))?.url) !== message.origin) {
    return { ok: false, error: t('devtools_conditionsNoPage') };
  }
  // Conditions apply to one tab: the tab that had them lets go, and reloads when its `fetch` and XHR were wrapped.
  const previous = await getConditionsState();
  if (previous && previous.tabId !== message.tabId) await clearConditionsNow(previous.via !== 'debugger');
  const base: ConditionsState = {
    tabId: message.tabId,
    origin: message.origin as string,
    conditions,
    throttle,
    cpuRate,
    lost: null,
  };
  let via: ConditionsVia = 'page';
  if (debuggerAvailable()) {
    try {
      await applyThroughDebugger(base);
      via = 'debugger';
    } catch (err) {
      await releaseConditionsDebugger(base.tabId).catch(() => undefined);
      if (throttle || cpuRate) {
        return { ok: false, error: t('devtools_emulationRefused', { error: err instanceof Error ? err.message : '' }) };
      }
    }
  } else if (throttle || cpuRate) {
    return { ok: false, error: t('devtools_emulationUnavailable') };
  }
  try {
    const state: ConditionsState = { ...base, via };
    await sessionArea().set({ [CONDITIONS_KEY]: state });
    await registerConditionScripts(state, pattern);
    return { ok: true };
  } catch (err) {
    await clearConditionsNow(false);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// The person cancelled the debugging bar: the requests' conditions go on through the page's wrapper, and the
// throttling, which needs the protocol, ends. The panel and the banner say so.
onConditionsDebuggerLost((tabId, reason) => {
  void inConditionsQueue(async () => {
    const state = await getConditionsState();
    if (!state || state.tabId !== tabId) return;
    const pattern = replayOriginPattern(state.origin);
    const next: ConditionsState = { ...state, throttle: null, cpuRate: null, via: 'page', lost: reason };
    await sessionArea().set({ [CONDITIONS_KEY]: next });
    if (state.conditions.length > 0 && pattern) await registerConditionScripts(next, pattern).catch(() => undefined);
    else await unregisterScripts(CONDITION_SCRIPT_IDS);
  });
});

/** The origin of `url`; null for none or an address that is not one. */
function originOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

/** The conditions for the tab asking, on the origin they were set for; none for any other tab. */
async function conditionsFor(
  tab: chrome.tabs.Tab | undefined,
  url: string | undefined,
): Promise<ConditionsState['conditions']> {
  const state = await getConditionsState();
  if (!state || tab?.id !== state.tabId) return [];
  return originOf(url) === state.origin ? state.conditions : [];
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void getConditionsState().then((state) => {
    if (state?.tabId === tabId) void clearConditions(false);
  });
  void clearTabViewport(tabId);
  void endReplayOfClosedTab(tabId);
});

/** The narrowest and the widest viewport a window is opened at, in CSS pixels. */
const VIEWPORT_MIN = 200;
const VIEWPORT_MAX = 4000;

/** The tab's content size, once the browser has laid the window out, and changed from `before` when given. */
async function tabSize(
  tabId: number,
  before: { width: number; height: number } | null = null,
): Promise<{ width: number; height: number } | null> {
  let last: { width: number; height: number } | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.width && tab.height) {
      last = { width: tab.width, height: tab.height };
      if (!before || last.width !== before.width || last.height !== before.height) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return last;
}

/**
 * Sets the viewport of the tab itself through the debugging protocol, as
 * DevTools' device toolbar does, until the DevTools panel resets it or the tab closes.
 */
async function handleSetTabViewport(message: {
  tabId?: unknown;
  width?: unknown;
  height?: unknown;
}): Promise<{ ok: boolean; error?: string }> {
  await i18nReady;
  const { tabId, width, height } = message;
  const size = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= VIEWPORT_MIN && value <= VIEWPORT_MAX;
  if (typeof tabId !== 'number' || !size(width) || !size(height)) {
    return { ok: false, error: t('devtools_viewportInvalid', { min: VIEWPORT_MIN, max: VIEWPORT_MAX }) };
  }
  if (!debuggerAvailable()) return { ok: false, error: t('devtools_viewportHereUnavailable') };
  const result = await setTabViewport({ tabId, width: width as number, height: height as number });
  return result.ok ? result : { ok: false, error: t('devtools_viewportHereRefused', { error: result.error }) };
}

/**
 * Opens `url` in a new window whose viewport, not its outer frame, measures
 * `width` × `height`: the window is created at that size, then grown by the
 * difference between its outer size and its tab's. Viewport only: no touch,
 * device pixel ratio or user agent.
 */
async function handleOpenViewport(message: {
  url?: unknown;
  width?: unknown;
  height?: unknown;
}): Promise<{ ok: true; width: number; height: number } | { ok: false; error: string }> {
  await i18nReady;
  const { url, width, height } = message;
  const size = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= VIEWPORT_MIN && value <= VIEWPORT_MAX;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || !size(width) || !size(height)) {
    return { ok: false, error: t('devtools_viewportInvalid', { min: VIEWPORT_MIN, max: VIEWPORT_MAX }) };
  }
  try {
    const w = width as number;
    const h = height as number;
    // Placed where the current window is: a window mostly off the screen is refused.
    const base = await chrome.windows.getLastFocused().catch(() => null);
    const created = await chrome.windows.create({
      url,
      width: w,
      height: h,
      left: base?.left ?? 0,
      top: base?.top ?? 0,
      type: 'normal',
      focused: true,
    });
    const tabId = created?.tabs?.[0]?.id;
    if (created?.id == null || tabId == null)
      return { ok: false, error: t('devtools_viewportInvalid', { min: VIEWPORT_MIN, max: VIEWPORT_MAX }) };
    // The window's size as set, which `windows.get` may not report yet, and the viewport it gave.
    let outer = { width: created.width ?? w, height: created.height ?? h };
    let inner = await tabSize(tabId);
    for (let pass = 0; inner && pass < 4 && (inner.width !== w || inner.height !== h); pass++) {
      // The frame around the viewport: toolbars, borders, scrollbars.
      const frameWidth = Math.max(0, outer.width - inner.width);
      const frameHeight = Math.max(0, outer.height - inner.height);
      outer = { width: w + frameWidth, height: h + frameHeight };
      await chrome.windows.update(created.id, outer);
      inner = await tabSize(tabId, inner);
    }
    return { ok: true, width: inner?.width ?? w, height: inner?.height ?? h };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const REPLAY_SCRIPT_ID = 'piwi-replay-panel';
/** The main-world script that sees the page's console and failed requests, for as long as a replay runs. */
const REPLAY_EVIDENCE_SCRIPT_ID = 'piwi-replay-evidence';
const REPLAY_SCRIPT_IDS = [REPLAY_SCRIPT_ID, REPLAY_EVIDENCE_SCRIPT_ID];

function replayOriginPattern(origin: unknown): string | null {
  if (typeof origin !== 'string') return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin === origin ? hostPattern(origin) : null;
  } catch {
    return null;
  }
}

/** Replay starts, one at a time, so two cannot interleave their scripts' registrations. */
let replayStartQueue: Promise<unknown> = Promise.resolve();

/**
 * Starts a replay of a steps document on one origin: the steps are checked
 * again here, the state goes to session storage, and the replay script is
 * registered for the origin so every page the replay reaches continues it.
 * It needs the origin's host permission, which Replay in the popup requests
 * and a bug recording on the same site already holds.
 */
function handleStartReplay(
  message: StartReplayMessage,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; error?: string }> {
  const run = replayStartQueue.then(() => startReplayNow(message, sender));
  replayStartQueue = run.catch(() => undefined);
  return run;
}

interface StartReplayMessage {
  steps?: unknown;
  origin?: unknown;
  stepMode?: unknown;
  inject?: unknown;
  startOn?: unknown;
  bugReportId?: unknown;
  runFailedStep?: unknown;
  views?: unknown;
  recordingViews?: unknown;
  keepViews?: unknown;
}

async function startReplayNow(
  message: StartReplayMessage,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; error?: string }> {
  await i18nReady;
  const tab = sender.tab;
  const pattern = replayOriginPattern(message.origin);
  if (!pattern || tab?.id == null) return { ok: false, error: t('common_replayNeedsPage') };
  const parsed = parseSteps(message.steps);
  if (!parsed.ok) return { ok: false, error: t('common_replayNotSteps', { error: parsed.errors[0] ?? '' }) };
  if (parsed.steps.steps.length === 0) return { ok: false, error: t('common_replayNoSteps') };
  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ok: false, error: t('common_replayNeedsAccess') };
  }
  try {
    const origin = message.origin as string;
    const first = sessionFromSteps(parsed.steps, origin).steps[0];
    const startPage =
      typeof message.startOn === 'string' && message.startOn.startsWith(`${origin}/`) && first?.action === 'goto'
        ? { recorded: first.value ?? first.pageUrl, actual: message.startOn }
        : null;
    const bugReportId =
      typeof message.bugReportId === 'number' && Number.isInteger(message.bugReportId) ? message.bugReportId : null;
    const failed = message.runFailedStep;
    const runFailedStep =
      typeof failed === 'number' && Number.isInteger(failed) && failed >= 0 && failed < parsed.steps.steps.length
        ? failed
        : null;
    const replay = newReplayState(
      parsed.steps,
      origin,
      message.stepMode === true,
      Date.now(),
      startPage,
      bugReportId,
      runFailedStep,
    );
    // A replay under a request condition says so, while it runs and in its verdict.
    const conditions = await conditionsFor(tab, tab.url);
    await prepareReplayViews(message);
    await setReplayState(conditions.length ? { ...replay, conditions } : replay);
    // Started from the page it plays on, the replay is that tab's; from an extension page, the first tab to ask.
    if (!fromExtensionPage(sender)) await setReplayTab({ replayId: replay.id, tabId: tab.id });
    await releaseReplayDebugger();
    await unregisterScripts(REPLAY_SCRIPT_IDS);
    await chrome.scripting.registerContentScripts([
      {
        id: REPLAY_EVIDENCE_SCRIPT_ID,
        js: ['bug-evidence-main.js'],
        matches: [pattern],
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: false,
      },
      {
        id: REPLAY_SCRIPT_ID,
        js: ['replay-panel.js'],
        matches: [pattern],
        runAt: 'document_idle',
        persistAcrossSessions: false,
      },
    ]);
    // The page already loaded, where a replay that starts on it runs its first steps.
    await chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ['bug-evidence-main.js'], world: 'MAIN' })
      .catch(() => undefined);
    if (message.inject === true)
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['replay-panel.js'] });
    // A recording still going keeps its badge; the replay's shows once it ends.
    await showStateBadge();
    return { ok: true };
  } catch (err) {
    await unregisterScripts(REPLAY_SCRIPT_IDS);
    return { ok: false, error: err instanceof Error ? err.message : t('common_replayStartFailed') };
  }
}

/** From a pick or recording panel: post to the paired editor, which inserts at its cursor. */
async function handleSendToEditor(payload: EditorSendPayload): Promise<SendToEditorResult> {
  await i18nReady;
  const stored = await getEditorPairing();
  // Checked as a pasted pairing is: a loopback address and a token.
  const pairing = stored ? parsePairing(`${stored.url}#${stored.token}`) : null;
  if (!pairing) return { ok: false, error: t('options_editorInvalid') };
  if (!(await chrome.permissions.contains({ origins: [editorOriginPattern(pairing)] }))) {
    return { ok: false, error: t('options_editorPermission') };
  }
  return postToEditor(pairing, payload);
}

/**
 * A tab the replay attached to that left the replay's origin, or a replay that
 * ended without saying so (its tab closed mid-page): the session is let go, so
 * the debugging bar never stays up after the replay.
 */
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url || !tabsHolding('replay').includes(tabId)) return;
  void getReplayState().then((state) => {
    let sameOrigin = false;
    try {
      sameOrigin = !!state && new URL(change.url!).origin === state.origin;
    } catch {
      sameOrigin = false;
    }
    if (!state || (state.status !== 'running' && state.status !== 'paused') || !sameOrigin) {
      void releaseReplayTab(tabId);
    }
  });
});

/** The replay script has stored its final state: the badge follows what still runs, a recording perhaps. */
async function handleReplayFinished(): Promise<void> {
  await releaseReplayDebugger();
  await unregisterScripts(REPLAY_SCRIPT_IDS);
  await showStateBadge();
}

/** Claims of a replay's tab, one at a time, so two tabs asking together cannot both get it. */
let replayTabQueue: Promise<unknown> = Promise.resolve();

/**
 * Whether the sender's tab plays the replay: the tab it was started in, else
 * the first tab to ask. The replay's other tabs on its origin leave it alone;
 * one stopped while its own tab was on another site ends when another tab asks.
 */
function handleReplayTab(message: { replayId?: unknown }, tab: chrome.tabs.Tab | undefined): Promise<{ ok: boolean }> {
  const answer = replayTabQueue.then(async () => {
    const state = await getReplayState();
    if (tab?.id == null || !state || state.id !== message.replayId) return { ok: false };
    const bound = await getReplayTab();
    if (bound?.replayId === state.id) {
      if (bound.tabId === tab.id) return { ok: true };
      const running = state.status === 'running' || state.status === 'paused';
      if (running && bound.opened?.includes(tab.id) && (await stepOpenedTab(state, bound.tabId, tab))) {
        await moveReplay(state.id, bound.tabId, tab.id);
        return { ok: true };
      }
      if (!running) await endReplay(state);
      return { ok: false };
    }
    await setReplayTab({ replayId: state.id, tabId: tab.id });
    return { ok: true };
  });
  replayTabQueue = answer.catch(() => undefined);
  return answer;
}

/**
 * Whether a tab the replay's tab opened shows the page the replay's step
 * happened on, while the replay's tab does not: the last step opened its page
 * there. A step handed to the person may be what they opened it with, and the
 * page is then the next step's. A tab merely opened beside it (Chrome names
 * the tab in front as the opener of a new one) leaves the replay where it is.
 */
async function stepOpenedTab(state: ReplayState, replayTabId: number, tab: chrome.tabs.Tab): Promise<boolean> {
  const steps = sessionFromSteps(state.steps, state.origin).steps;
  const handed = state.handOver?.step === state.position;
  // A step whose page is not known (made from a test run, after a click that may navigate) names no page to follow.
  const pages = steps
    .slice(state.position, state.position + (handed ? 2 : 1))
    .flatMap((s) => (s.pageUrl ? [pageKey(s.pageUrl)] : []));
  const there = tab.url ? pageKey(tab.url) : null;
  if (there === null || !pages.includes(there)) return false;
  const left = await chrome.tabs.get(replayTabId).catch(() => null);
  return !left?.url || pageKey(left.url) !== there;
}

/**
 * A step opened its page in a new tab, and the replay goes on there: the tab
 * it leaves gets its debugging session and its size back, and its page lets
 * go of the replay.
 */
async function moveReplay(replayId: string, from: number, to: number): Promise<void> {
  await setReplayTab({ replayId, tabId: to });
  await releaseReplayTab(from);
  await chrome.tabs.sendMessage(from, { type: 'piwi-replay-moved', replayId }).catch(() => undefined);
}

/** The most tabs a replay's tab is remembered to have opened; the latest are kept. */
const OPENED_TABS_KEPT = 20;

// A tab the replay's tab opens while the replay runs may take the replay on, once its page asks (`handleReplayTab`).
chrome.tabs.onCreated.addListener((tab) => {
  const { id, openerTabId } = tab;
  if (id == null || openerTabId == null) return;
  replayTabQueue = replayTabQueue
    .then(async () => {
      const [state, bound] = await Promise.all([getReplayState(), getReplayTab()]);
      if (!state || (state.status !== 'running' && state.status !== 'paused')) return;
      if (bound?.replayId !== state.id || bound.tabId !== openerTabId) return;
      await setReplayTab({ ...bound, opened: [...(bound.opened ?? []), id].slice(-OPENED_TABS_KEPT) });
    })
    .catch(() => undefined);
});

/** Ends a replay no page of its tab will finish: nothing of it stays registered or attached. */
async function endReplay(state: ReplayState): Promise<void> {
  if (state.finished) return;
  await setReplayState({ ...state, status: state.status === 'done' ? 'done' : 'stopped', finished: true });
  await handleReplayFinished();
}

/** Whether a message about the stored replay comes from its tab, or from any tab while none plays it. */
async function fromReplayTab(tab: chrome.tabs.Tab | undefined): Promise<boolean> {
  const [state, bound] = await Promise.all([getReplayState(), getReplayTab()]);
  return !state || bound?.replayId !== state.id || bound.tabId === tab?.id;
}

/** The replay's tab was closed: the replay ends there. */
async function endReplayOfClosedTab(tabId: number): Promise<void> {
  const [state, bound] = await Promise.all([getReplayState(), getReplayTab()]);
  if (state && bound?.replayId === state.id && bound.tabId === tabId) await endReplay(state);
}

// A tab the browser swaps for another (a prerendered page shown) keeps playing the replay.
chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  void replayTabQueue.then(async () => {
    const bound = await getReplayTab();
    if (bound?.tabId === removedTabId) await setReplayTab({ ...bound, tabId: addedTabId });
  });
});

/**
 * Messages only the extension's own pages send: each names a tab or an
 * address to act on, which a content script never chooses.
 */
const EXTENSION_PAGE_MESSAGES = new Set([
  'piwi-start-recording',
  'piwi-set-tab-viewport',
  'piwi-clear-tab-viewport',
  'piwi-open-viewport',
  'piwi-set-conditions',
  'piwi-set-language',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (EXTENSION_PAGE_MESSAGES.has(message?.type) && !fromExtensionPage(sender)) {
    sendResponse({ ok: false });
    return undefined;
  }
  if (message?.type === 'piwi-ping') {
    // Resolves only once session storage is readable from content scripts —
    // the whole point of the ping. The build lets the caller tell whether this
    // worker predates a rebuild (see `shared/build-id.ts`).
    void sessionAccessReady.then(() => sendResponse({ ok: true, build: BUILD_ID }));
    return true;
  }
  if (message?.type === 'piwi-session-storage') {
    // A content script in Firefox, which has no session storage of its own.
    void serveSessionStorage(message).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-append-recording-event') {
    // The recorder in Firefox — see `appendRecordingEvent`.
    void serveAppendRecordingEvent(message.event).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-update-recording') {
    // The recorder's Pause and title in Firefox, in the same queue as its appends, see `updateRecording`.
    void serveUpdateRecording(message).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-start-recording') {
    // Through the dedupe guard, not `handleStartRecording` directly: on a
    // first-time grant `chrome.permissions.onAdded` may already be starting the
    // same recording (see `startRecordingOnce`).
    void startRecordingOnce(message.originPattern, message.tabId, message.mode === 'bug' ? 'bug' : 'actions').then(
      sendResponse,
    );
    return true; // keep the message channel open for the async response
  }
  if (message?.type === 'piwi-start-replay') {
    void handleStartReplay(message, sender).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-replay-tab') {
    void handleReplayTab(message, sender.tab).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-replay-driver') {
    void handleReplayDriver(message, sender.tab).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-replay-input') {
    void handleReplayInput(message, sender.tab).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-tab-zoom') {
    // The zoom of the sender's tab, which a bug recording keeps with each viewport size.
    const tabId = sender.tab?.id;
    void (tabId != null ? tabZoom(tabId) : Promise.resolve(1)).then((zoom) => sendResponse({ zoom }));
    return true;
  }
  if (message?.type === 'piwi-replay-viewport') {
    void handleReplayViewport(message, sender.tab).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-set-tab-viewport') {
    void handleSetTabViewport(message).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-clear-tab-viewport') {
    if (typeof message.tabId !== 'number') return undefined;
    void clearTabViewport(message.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'piwi-open-viewport') {
    void handleOpenViewport(message).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-set-conditions') {
    void handleSetConditions(message).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-get-conditions') {
    // `forPage`: what the page's own wrapper applies, none when the debugging protocol applies them.
    void Promise.all([conditionsFor(sender.tab, sender.url), getConditionsState()]).then(([conditions, state]) =>
      sendResponse({
        conditions,
        forPage: state?.via === 'debugger' ? [] : conditions,
        throttle: state?.tabId === sender.tab?.id ? (state?.throttle ?? null) : null,
        cpuRate: state?.tabId === sender.tab?.id ? (state?.cpuRate ?? null) : null,
      }),
    );
    return true;
  }
  if (message?.type === 'piwi-clear-conditions') {
    void clearConditions(true).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'piwi-set-language') {
    // From the Options page: store the chosen catalog, or follow the browser again.
    void handleSetLanguage(message.code ?? null).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-replay-finished') {
    void fromReplayTab(sender.tab).then(async (ours) => {
      if (ours) await handleReplayFinished();
      sendResponse({ ok: ours });
    });
    return true;
  }
  if (message?.type === 'piwi-bug-evidence-source') {
    sendResponse({ debugger: collectsThroughDebugger(sender.tab?.id) });
    return undefined;
  }
  if (message?.type === 'piwi-relay-left') {
    void handleRelayLeft(message).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === 'piwi-bug-screenshot') {
    void handleBugScreenshot(sender.tab).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-bug-step-view') {
    // Answered once the screenshot is taken, before it is kept: the recorder hides its panel until then.
    void handleStepView(message, sender.tab, (ok) => sendResponse({ ok }));
    return true;
  }
  if (message?.type === 'piwi-bug-step-views') {
    void handleGetStepViews(message).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-replay-step-view') {
    void handleReplayStepView(message).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-send-to-editor') {
    void handleSendToEditor(message.payload).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-bug-send-target') {
    void i18nReady.then(() => handleBugSendTarget(sender.tab)).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-send-bug-report') {
    void i18nReady.then(() => handleSendBugReport(message, sender.tab)).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-list-bug-reports') {
    void i18nReady.then(() => handleListBugReports(sender.tab)).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-share-target') {
    void handleShareTarget().then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-share-reproduction') {
    void i18nReady.then(() => handleShareReproduction(message)).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-desktop-target') {
    void handleDesktopTarget().then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-desktop-repro') {
    void i18nReady.then(() => handleDesktopRepro(message)).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-desktop-repro-status') {
    void i18nReady.then(() => handleDesktopReproStatus(message.id)).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-get-bug-report') {
    void i18nReady.then(() => handleGetBugReport(message.id, sender.tab)).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-refresh-catalog') {
    void i18nReady.then(() => handleRefreshCatalog(message, sender)).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-open-coverage') {
    // From the pick panel: open "Tested elements" in the tab the pick ran in.
    const tabId = sender.tab?.id;
    if (tabId == null) return undefined;
    void chrome.scripting
      .executeScript({ target: { tabId }, files: ['coverage-overlay.js'] })
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }
  if (message?.type === 'piwi-open-options') {
    // Content scripts can't open the options page themselves.
    void chrome.runtime.openOptionsPage().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'piwi-refresh-locator-index') {
    void i18nReady.then(() => handleRefreshLocatorIndex(message, sender)).then(sendResponse);
    return true;
  }
  if (message?.type === 'piwi-recording-stopped') {
    // Also received here even though a content script or the popup already
    // wrote `active: false` to storage directly — this handler owns the
    // chrome.scripting/chrome.action side effects, and the fan-out to every
    // other tab still showing the recorder, regardless of who requested the
    // stop.
    void handleRecordingStopped(sender.tab?.id).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'piwi-recording-paused' && typeof message.paused === 'boolean') {
    // The bar's Pause or Resume, already in the recording: the recording's other tabs show it and stop capturing too.
    const paused: boolean = message.paused;
    void getRecordingState()
      .then(({ grantedOriginPattern }) =>
        notifyRecorderTabs(grantedOriginPattern, sender.tab?.id, { type: 'piwi-recording-paused', paused }),
      )
      .catch(() => undefined)
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  return undefined;
});
