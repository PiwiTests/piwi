import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from '@playwright/test';
import { stubChromeI18n } from './i18n-stub.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

/**
 * The replay script, driven the way `record.spec.ts` drives the recorder: the
 * built bundle runs in the page with a stubbed `chrome.storage` kept in
 * `window.name`, which survives the replay's own navigations in the tab. The
 * bundle is added as an init script, as the background script's registration
 * adds it to every page of the origin.
 */
export async function stubChrome(
  context: BrowserContext,
  session: Record<string, unknown>,
  language = 'en',
): Promise<void> {
  await context.addInitScript((seed) => {
    function load(): { session: Record<string, unknown> } {
      if (!window.name) return { session: seed };
      try {
        return { session: JSON.parse(window.name).session ?? {} };
      } catch {
        return { session: {} };
      }
    }
    function persist(data: { session: Record<string, unknown> }): void {
      window.name = JSON.stringify(data);
    }
    if (!window.name) persist(load());
    const area = {
      get: async (key: string) => ({ [key]: load().session[key] }),
      set: async (values: Record<string, unknown>) => {
        const data = load();
        Object.assign(data.session, values);
        persist(data);
      },
      remove: async (key: string) => {
        const data = load();
        delete data.session[key];
        persist(data);
      },
    };
    (globalThis as any).chrome = {
      storage: { session: area, local: area },
      runtime: {
        sendMessage: async () => ({ ok: true }),
        onMessage: {
          addListener: (fn: (message: unknown) => void) => {
            ((globalThis as any).__piwiTestRuntimeListeners ??= []).push(fn);
          },
        },
      },
    };
  }, session);
  await stubChromeI18n(context, language);
  await context.addInitScript({ path: path.join(DIST, 'replay-panel.js') });
}
