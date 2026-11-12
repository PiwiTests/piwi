import type { BrowserContext, Page } from '@playwright/test';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import { stubChromeI18n } from './i18n-stub.js';

/**
 * record-panel.ts reads/writes chrome.storage.session and .local directly —
 * real access needs a genuine content-script injection (background's
 * setAccessLevel call). Driving the bundle via page.addScriptTag (the same
 * shortcut session-panel.spec.ts uses) runs in the page's own main world
 * instead, with no chrome.* APIs at all, so this stubs a minimal
 * chrome.storage backed by `window.name` — one of the few things that
 * survives a real cross-page navigation in the same tab, which a plain
 * in-memory stub (reset by addInitScript re-running on every new document)
 * would not. `chrome.runtime.sendMessage` answers `{ ok: true }`, or the
 * seeded `responses` entry for the message's type (the service worker's
 * screenshot, for instance), and `onMessage` keeps its listeners so a test can
 * play the part of the service worker fanning a stop out with
 * `chrome.tabs.sendMessage` (see `dispatchRuntimeMessage`).
 */
export async function stubChromeStorage(
  context: BrowserContext,
  seed: {
    session?: Record<string, unknown>;
    local?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await context.addInitScript((initialSeed) => {
    function load(): { session: Record<string, unknown>; local: Record<string, unknown> } {
      if (!window.name) return { session: initialSeed.session ?? {}, local: initialSeed.local ?? {} };
      try {
        const parsed = JSON.parse(window.name);
        return { session: parsed.session ?? {}, local: parsed.local ?? {} };
      } catch {
        return { session: {}, local: {} };
      }
    }
    function persist(data: { session: Record<string, unknown>; local: Record<string, unknown> }): void {
      window.name = JSON.stringify(data);
    }
    if (!window.name) persist(load());

    function makeArea(area: 'session' | 'local') {
      return {
        get: async (key: string) => {
          const data = load();
          return { [key]: data[area][key] };
        },
        set: async (values: Record<string, unknown>) => {
          const data = load();
          Object.assign(data[area], values);
          persist(data);
        },
        remove: async (key: string) => {
          const data = load();
          delete data[area][key];
          persist(data);
        },
      };
    }

    const listeners: Array<(message: unknown) => void> = [];
    (globalThis as any).__piwiTestRuntimeListeners = listeners;
    (globalThis as any).chrome = {
      storage: { session: makeArea('session'), local: makeArea('local') },
      runtime: {
        sendMessage: async (message: { type?: string } | undefined) =>
          initialSeed.responses?.[message?.type ?? ''] ?? { ok: true },
        getManifest: () => ({ version: '0.0.0-test' }),
        onMessage: {
          addListener: (fn: (message: unknown) => void) => {
            listeners.push(fn);
          },
        },
      },
    };
  }, seed);
  await stubChromeI18n(context);
}

/**
 * Plays the service worker's `chrome.tabs.sendMessage` fan-out — the only way
 * a stop reaches a content script — or the popup's own messages to the page,
 * each `messages` in turn in one task. Answers what each listener sent back.
 */
export async function dispatchRuntimeMessage(page: Page, ...messages: unknown[]): Promise<unknown[]> {
  return page.evaluate(async (all) => {
    const answers: Array<Promise<unknown>> = [];
    for (const msg of all) {
      for (const fn of (globalThis as any).__piwiTestRuntimeListeners ?? []) {
        answers.push(
          new Promise((resolve) => {
            // A listener that answers later says so by returning true.
            if (fn(msg, {}, resolve) !== true) resolve(undefined);
          }),
        );
      }
    }
    return Promise.all(answers);
  }, messages);
}

export async function setRecordingActive(page: Page, active: boolean): Promise<void> {
  await page.evaluate(async (isActive) => {
    const chromeApi = (globalThis as any).chrome;
    const stored = await chromeApi.storage.session.get('piwiRecording');
    await chromeApi.storage.session.set({ piwiRecording: { ...stored.piwiRecording, active: isActive } });
  }, active);
}

export async function readStoredEvents(page: Page): Promise<RawCaptureEvent[]> {
  const result = await page.evaluate(async () => (globalThis as any).chrome.storage.session.get('piwiRecording'));
  const state = result.piwiRecording as { events?: RawCaptureEvent[] } | undefined;
  return state?.events ?? [];
}

/**
 * The stored events' text alone: every string value, with numbers (timestamps, coordinates, sizes) left out, so a
 * check that no secret was kept looks only at what a page could have written.
 */
export function storedText(events: RawCaptureEvent[]): string {
  return JSON.stringify(events, (_key, value: unknown) => (typeof value === 'number' ? undefined : value));
}
