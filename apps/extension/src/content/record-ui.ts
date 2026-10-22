import type { StepView } from '@piwitests/core/recording';
import type { PiwiSteps } from '@piwitests/core/steps';
import { copyWithFeedback } from '../shared/clipboard.js';

/** The recorder's page surfaces, shared by `record-panel.ts` and `bug-panel.ts`. */

export const HUD_HOST_ID = 'piwi-record-hud-host';
export const PANEL_HOST_ID = 'piwi-record-review-host';
export const FRAME_HOST_ID = 'piwi-record-frame-host';
/** A bug recording's dialogs (what is wrong, what is missing, which page), above the HUD. */
export const BUG_DIALOG_HOST_ID = 'piwi-bug-dialog-host';

/** A replay's panel, its file dialog, and its fake cursor. */
export const REPLAY_HUD_HOST_ID = 'piwi-replay-hud-host';
export const REPLAY_DIALOG_HOST_ID = 'piwi-replay-dialog-host';
export const CURSOR_HOST_ID = 'piwi-replay-cursor-host';
export const DESKTOP_DIALOG_HOST_ID = 'piwi-desktop-run-host';

export const OWN_HOST_IDS: ReadonlySet<string> = new Set([
  HUD_HOST_ID,
  PANEL_HOST_ID,
  FRAME_HOST_ID,
  BUG_DIALOG_HOST_ID,
  REPLAY_HUD_HOST_ID,
  REPLAY_DIALOG_HOST_ID,
  CURSOR_HOST_ID,
  DESKTOP_DIALOG_HOST_ID,
]);

export const SHARED_STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
`;

interface SurfaceGlobals {
  /** How many hides hold each of the recorder's surfaces, by host id: a global, since each injection of the recorder is its own module instance. */
  __piwiSurfaceHides?: Record<string, number>;
}

function surfaceHides(): Record<string, number> {
  const g = globalThis as SurfaceGlobals;
  g.__piwiSurfaceHides ??= {};
  return g.__piwiSurfaceHides;
}

/**
 * Hides the recorder's surfaces with these host ids until the returned
 * function is called, for a screenshot or a pick to show only the page. Hides
 * overlap: a surface shows again once the last one holding it ends, and a host
 * created meanwhile is mounted hidden (`mountSurface`).
 */
export function hideSurfaces(ids: readonly string[]): () => void {
  const hides = surfaceHides();
  for (const id of ids) {
    hides[id] = (hides[id] ?? 0) + 1;
    const host = document.getElementById(id);
    if (host) host.style.visibility = 'hidden';
  }
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    for (const id of ids) {
      hides[id] = Math.max(0, (hides[id] ?? 1) - 1);
      const host = document.getElementById(id);
      if (hides[id] === 0 && host) host.style.visibility = 'initial';
    }
  };
}

/** Adds a host of the recorder's to the page, hidden while a hide holds its id. */
export function mountSurface(host: HTMLElement): void {
  if ((surfaceHides()[host.id] ?? 0) > 0) host.style.visibility = 'hidden';
  document.documentElement.appendChild(host);
}

/** Whether an element belongs to the recorder's own UI rather than to the page. */
export function isOwnHost(element: Element): boolean {
  return OWN_HOST_IDS.has(element.id);
}

export async function copyToClipboard(text: string, btn: HTMLButtonElement): Promise<void> {
  await copyWithFeedback(text, btn);
}

/** `2026-09-27-14-03`, for file names. */
export function fileStamp(time: number): string {
  return new Date(time || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

/**
 * Asks the worker to replay `steps` in this tab, on this page's origin;
 * `recordingViews` are the step screenshots a bug recording took, which the
 * replay shows for a step it hands to the person. Answers why it could not
 * start.
 */
export async function startReplayHere(
  steps: PiwiSteps,
  recordingViews?: Array<StepView & { step: number }>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: 'piwi-start-replay',
      steps,
      origin: location.origin,
      stepMode: false,
      inject: true,
      ...(recordingViews ? { recordingViews } : {}),
    })) as { ok: boolean; error?: string } | undefined;
    return response ?? { ok: false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
