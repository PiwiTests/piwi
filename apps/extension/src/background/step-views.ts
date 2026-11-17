import { BUG_EVIDENCE_LIMITS } from '@piwitests/core/bug-report';
import type { ViewportBox } from '@piwitests/core/recording';
import { getRecordingState, RECORDING_KEY, type RecordingState } from '../shared/recording-storage.js';
import {
  clearRecordingViews,
  countRecordingViews,
  deleteRecordingView,
  getRecordingViews,
  getReplayView,
  putRecordingView,
  setReplayViews,
  type ReplayStepView,
  type StoredStepView,
} from '../shared/step-views.js';
import { getConnectionSettings } from '../shared/connection-settings.js';
import { fetchBugReportStepShot } from '../shared/piwi-client.js';
import { getReplayState } from '../shared/replay-storage.js';
import { sessionArea } from '../shared/session-area.js';
import { captureThroughDebugger } from './cdp-evidence.js';

/**
 * The page as each step of a recording began: the recorder asks for a
 * view once the page has settled after a step, or as an action starts when
 * none is left, under an id it makes up, and keeps the id on the step. The
 * worker takes the screenshot, through the recording's debugging session or,
 * without one, `captureVisibleTab` (which works under the `activeTab` grant
 * only), and keeps it as a JPEG the size of the viewport in CSS pixels.
 */

/** The widest a view is kept, in CSS pixels: a wider page is scaled down to it. */
const VIEW_MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.6;
/** An id as the recorder makes them. */
const VIEW_ID = /^[a-z0-9-]{1,40}$/;

function viewportOf(v: unknown): { width: number; height: number } | null {
  const size = v as { width?: unknown; height?: unknown } | null;
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 10_000;
  return size && ok(size.width) && ok(size.height) ? { width: size.width, height: size.height } : null;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A screenshot as a JPEG as wide as the viewport in CSS pixels, at most {@link VIEW_MAX_WIDTH}. */
async function viewJpeg(dataUrl: string, viewport: { width: number; height: number } | null): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const width = Math.max(1, Math.min(bitmap.width, viewport?.width ?? bitmap.width, VIEW_MAX_WIDTH));
  const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  return `data:image/jpeg;base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
}

async function captureTab(tab: chrome.tabs.Tab): Promise<string | null> {
  const viaDebugger = await captureThroughDebugger(tab.id!, 'jpeg');
  if (viaDebugger) return viaDebugger;
  if (!tab.active || tab.windowId == null) return null;
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 }).catch(() => null);
}

/**
 * Takes the view the recorder asked for in its tab and keeps it, up to the
 * number of step screenshots a report keeps. A view asked for again replaces
 * the one kept under its id, which no longer shows the page: when the new one
 * cannot be taken, the id is left with none. `captured` is called once the
 * screenshot is taken, before it is encoded and kept, so the recorder shows
 * its own surfaces again as soon as possible.
 */
export async function handleStepView(
  message: { id?: unknown; viewport?: unknown },
  tab: chrome.tabs.Tab | undefined,
  captured: (ok: boolean) => void,
): Promise<void> {
  const id = message.id;
  if (typeof id !== 'string' || !VIEW_ID.test(id) || tab?.id == null) return captured(false);
  const state = await getRecordingState();
  if (!state.active || !state.bugToken) return captured(false);
  await deleteRecordingView(id).catch(() => undefined);
  if ((await countRecordingViews().catch(() => Infinity)) >= BUG_EVIDENCE_LIMITS.stepShots) return captured(false);
  const takenAt = Date.now();
  const shot = await captureTab(tab);
  captured(!!shot);
  if (!shot) return;
  const viewport = viewportOf(message.viewport);
  try {
    await putRecordingView({ id, dataUrl: await viewJpeg(shot, viewport), takenAt, viewport });
  } catch (err) {
    console.warn('[Piwi Picker] step screenshot not kept:', err);
  }
}

/** The views the recorder kept for these ids, for the report's archive. */
export async function handleGetStepViews(message: { ids?: unknown }): Promise<StoredStepView[]> {
  const ids = Array.isArray(message.ids)
    ? message.ids.filter((id): id is string => typeof id === 'string' && VIEW_ID.test(id))
    : [];
  return getRecordingViews(ids.slice(0, BUG_EVIDENCE_LIMITS.stepShots)).catch(() => []);
}

/**
 * A recording that starts, or one discarded, leaves no view behind; nor does a
 * browser session that ended, whose recording and replay went with its
 * session storage (see {@link clearStaleViews}).
 */
export function clearViewsWithRecording(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = area === 'session' ? changes[RECORDING_KEY] : undefined;
    if (!change) return;
    const next = change.newValue as RecordingState | undefined;
    const previous = change.oldValue as RecordingState | undefined;
    if (!next || next.startedAt !== previous?.startedAt) void clearRecordingViews().catch(() => undefined);
  });
  void clearStaleViews();
}

/**
 * As the worker starts: the recording's views go when session storage holds
 * no recording, and the replay's when it holds no replay. Session storage is
 * emptied with the browser session, and no change is heard then.
 */
export async function clearStaleViews(): Promise<void> {
  const [recording, replay] = await Promise.all([
    sessionArea()
      .get(RECORDING_KEY)
      .then((stored) => stored[RECORDING_KEY])
      .catch(() => null),
    getReplayState().catch(() => null),
  ]);
  await Promise.all([
    recording === undefined ? clearRecordingViews().catch(() => undefined) : undefined,
    replay ? undefined : setReplayViews([]).catch(() => undefined),
  ]);
}

/** The step screenshots a replay can show, at most one per step of a steps document. */
const REPLAY_VIEWS_MAX = 200;
/** The largest image a replay keeps for a step, in characters of its data URL. */
const REPLAY_VIEW_MAX_LENGTH = 4 * 1024 * 1024;

function boxOf(v: unknown): ViewportBox | null {
  const b = v as Partial<ViewportBox> | null;
  return b && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))
    ? { x: b.x!, y: b.y!, width: b.width!, height: b.height! }
    : null;
}

function stepOf(v: unknown): number | null {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) < REPLAY_VIEWS_MAX ? (v as number) : null;
}

/**
 * The screenshots the replay starting now shows for the steps it hands to the
 * person: images read from the report's file (`views`), the recording's own
 * by view id (`recordingViews`), or the running replay's when it plays again
 * (`keepViews`). A replay started with none clears the last one's.
 */
export async function prepareReplayViews(message: {
  views?: unknown;
  recordingViews?: unknown;
  keepViews?: unknown;
}): Promise<void> {
  if (message.keepViews === true) return;
  let views: ReplayStepView[] = [];
  if (Array.isArray(message.views)) {
    views = message.views.slice(0, REPLAY_VIEWS_MAX).flatMap((v: unknown) => {
      const view = v as { step?: unknown; dataUrl?: unknown; box?: unknown; viewport?: unknown } | null;
      const step = stepOf(view?.step);
      const dataUrl = view?.dataUrl;
      if (step == null || typeof dataUrl !== 'string' || dataUrl.length > REPLAY_VIEW_MAX_LENGTH) return [];
      if (!/^data:image\/(jpeg|png);base64,/.test(dataUrl)) return [];
      return [{ step, dataUrl, box: boxOf(view!.box), viewport: viewportOf(view!.viewport) }];
    });
  } else if (Array.isArray(message.recordingViews)) {
    const refs = message.recordingViews.slice(0, REPLAY_VIEWS_MAX).flatMap((v: unknown) => {
      const ref = v as { step?: unknown; id?: unknown; box?: unknown } | null;
      const step = stepOf(ref?.step);
      return step != null && typeof ref?.id === 'string' && VIEW_ID.test(ref.id)
        ? [{ step, id: ref.id, box: boxOf(ref.box) }]
        : [];
    });
    const kept = new Map((await getRecordingViews(refs.map((r) => r.id)).catch(() => [])).map((v) => [v.id, v]));
    views = refs.flatMap((ref) => {
      const view = kept.get(ref.id);
      return view ? [{ step: ref.step, dataUrl: view.dataUrl, box: ref.box, viewport: view.viewport }] : [];
    });
  }
  await setReplayViews(views).catch(() => undefined);
}

/** The last step screenshot fetched from the instance, by replay and step: a hand-over asks again on each page. */
let fetchedView: { replayId: string; step: number; view: ReplayStepView | null } | null = null;

/**
 * The screenshot of a replayed step, for the person the replay hands it to:
 * the one the replay was started with, or, for a report from the connected
 * instance, the one the instance keeps, fetched only for the step the running
 * replay hands over, once. Null when the report has none.
 */
export async function handleReplayStepView(message: { step?: unknown }): Promise<ReplayStepView | null> {
  const step = stepOf(message.step);
  if (step == null) return null;
  const kept = await getReplayView(step).catch(() => null);
  if (kept) return kept;
  const replay = await getReplayState();
  const running = replay?.status === 'running' || replay?.status === 'paused';
  if (!replay?.bugReportId || !running || replay.handOver?.step !== step) return null;
  if (fetchedView?.replayId === replay.id && fetchedView.step === step) return fetchedView.view;
  const settings = await getConnectionSettings();
  if (!settings.instanceUrl.trim()) return null;
  const shot = await fetchBugReportStepShot(settings, replay.bugReportId, step);
  const view = shot ? { step, dataUrl: shot.dataUrl, box: boxOf(shot.box), viewport: viewportOf(shot.viewport) } : null;
  fetchedView = {
    replayId: replay.id,
    step,
    view: view && view.dataUrl.length <= REPLAY_VIEW_MAX_LENGTH ? view : null,
  };
  return fetchedView.view;
}
