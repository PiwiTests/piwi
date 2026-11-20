import { describe, it, expect, beforeEach } from 'vitest';
import {
  IDE_CHROME_GLOBAL,
  IDE_DISPATCH_GLOBAL,
  IDE_RECORDER_BINDING,
  IDE_SETTINGS_KEY,
  type IdeRecorderRequest,
} from '@piwitests/core/ide-recorder';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import { createIdeChrome, installIdeHost, type RecorderBinding } from '../../src/ide/host.js';
import { BUILD_ID } from '../../src/shared/build-id.js';
import { initI18n, t } from '../../src/shared/i18n.js';
import { getIdeSettings, ideHostInstalled } from '../../src/shared/ide-build.js';
import { appendRecordingEvent, getRecordingState } from '../../src/shared/recording-storage.js';
import { isExtensionContext } from '../../src/shared/secret-store.js';
import { ensureSessionAccess, resetSessionAccessForTests } from '../../src/shared/session-access.js';
import { hasSessionArea } from '../../src/shared/session-area.js';
import { readCatalog } from './setup-i18n.js';

/** A launcher that keeps every request it gets and answers each with `answer`. */
function launcher(answer: (request: IdeRecorderRequest) => unknown = () => undefined): {
  requests: IdeRecorderRequest[];
  binding: RecorderBinding;
} {
  const requests: IdeRecorderRequest[] = [];
  // The binding copies what it is given, as a page's call to Node does.
  const binding: RecorderBinding = async (request) => {
    requests.push(structuredClone(request));
    return answer(structuredClone(request));
  };
  return { requests, binding };
}

const click: RawCaptureEvent = {
  kind: 'click',
  target: null,
  value: null,
  checked: null,
  inputType: null,
  isPasswordField: false,
  pageUrl: 'https://shop.test/',
  timestamp: 1,
};

beforeEach(() => resetSessionAccessForTests());

describe('the IDE bundle’s chrome', () => {
  it('reads and writes chrome.storage.local through the launcher', async () => {
    const { requests, binding } = launcher((request) =>
      request.kind === 'local-get' ? { piwiConnection: { instanceUrl: '' } } : undefined,
    );
    const chrome = createIdeChrome(binding);
    expect(await chrome.storage.local.get('piwiConnection')).toEqual({ piwiConnection: { instanceUrl: '' } });
    await chrome.storage.local.get(['piwiLanguage', IDE_SETTINGS_KEY]);
    await chrome.storage.local.get({ piwiLanguage: null });
    await chrome.storage.local.get();
    await chrome.storage.local.set({ piwiCatalogCache: {} });
    await chrome.storage.local.remove('piwiCatalogCache');
    await chrome.storage.local.remove(['piwiCatalogCache', 'piwiLocatorIndexCache']);
    expect(requests).toEqual([
      { kind: 'local-get', keys: 'piwiConnection' },
      { kind: 'local-get', keys: ['piwiLanguage', IDE_SETTINGS_KEY] },
      { kind: 'local-get', keys: { piwiLanguage: null } },
      { kind: 'local-get', keys: null },
      { kind: 'local-set', items: { piwiCatalogCache: {} } },
      { kind: 'local-remove', keys: 'piwiCatalogCache' },
      { kind: 'local-remove', keys: ['piwiCatalogCache', 'piwiLocatorIndexCache'] },
    ]);
  });

  it('answers a read with no items when the launcher answers anything but an object', async () => {
    for (const answer of [undefined, null, 'items', 3]) {
      const chrome = createIdeChrome(launcher(() => answer).binding);
      expect(await chrome.storage.local.get('piwiLanguage')).toEqual({});
    }
  });

  it('sends each runtime message to the launcher and answers with its reply', async () => {
    const { requests, binding } = launcher(() => ({ ok: true }));
    const chrome = createIdeChrome(binding);
    expect(await chrome.runtime.sendMessage({ type: 'piwi-recording-stopped' })).toEqual({ ok: true });
    expect(requests).toEqual([{ kind: 'message', message: { type: 'piwi-recording-stopped' } }]);
  });

  it('rejects a call the binding rejects, as a message the browser cannot deliver rejects', async () => {
    const chrome = createIdeChrome(async () => {
      throw new Error('Target page, context or browser has been closed');
    });
    await expect(chrome.runtime.sendMessage({ type: 'piwi-ping' })).rejects.toThrow('closed');
    await expect(chrome.storage.local.get('piwiLanguage')).rejects.toThrow('closed');
  });

  it('keeps the runtime listeners, and sends them nothing', async () => {
    const { requests, binding } = launcher();
    const chrome = createIdeChrome(binding);
    const listener = () => undefined;
    chrome.runtime.onMessage.addListener(listener);
    expect(chrome.runtime.onMessage.hasListener(listener)).toBe(true);
    chrome.runtime.onMessage.removeListener(listener);
    expect(chrome.runtime.onMessage.hasListener(listener)).toBe(false);
    expect(requests).toEqual([]);
  });

  it('names the build as its version, and points getURL at no page’s origin', () => {
    const chrome = createIdeChrome(launcher().binding);
    expect(chrome.runtime.getManifest()).toEqual({ version: BUILD_ID });
    expect(new URL(chrome.runtime.getURL('/')).hostname).toMatch(/\.invalid$/);
    expect(chrome.runtime.getURL('popup.html')).toBe(new URL('popup.html', chrome.runtime.getURL('/')).href);
  });

  it('shows no text of its own: the launcher hands the catalog over chrome.storage.local', () => {
    const chrome = createIdeChrome(launcher().binding);
    expect(chrome.i18n.getMessage('common_stop')).toBe('');
    expect(chrome.i18n.getUILanguage()).toBe('en');
  });

  it('has no session storage and no dom', () => {
    const chrome = createIdeChrome(launcher().binding);
    expect(chrome.storage).not.toHaveProperty('session');
    expect(chrome).not.toHaveProperty('dom');
  });
});

describe('the recorder over the IDE bundle’s chrome', () => {
  it('keeps its recording through messages to the launcher, one per append', async () => {
    const state = { active: true, events: [], startedAt: 1, grantedOriginPattern: null };
    const { requests, binding } = launcher((request) => {
      if (request.kind !== 'message') return undefined;
      const message = request.message as { type: string };
      if (message.type === 'piwi-session-storage') return { ok: true, items: { piwiRecording: state } };
      if (message.type === 'piwi-append-recording-event') return { ok: true, state: { ...state, events: [click] } };
      return { ok: true };
    });
    (globalThis as { chrome?: unknown }).chrome = createIdeChrome(binding);

    expect(hasSessionArea()).toBe(false);
    await ensureSessionAccess();
    expect(await getRecordingState()).toEqual(state);
    expect((await appendRecordingEvent(click)).events).toEqual([click]);
    expect(requests).toEqual([
      { kind: 'message', message: { type: 'piwi-ping' } },
      { kind: 'message', message: { type: 'piwi-session-storage', op: 'get', key: 'piwiRecording' } },
      { kind: 'message', message: { type: 'piwi-append-recording-event', event: click } },
    ]);
  });

  it('shows its texts in the language the launcher hands over', async () => {
    const french = readCatalog('fr');
    (globalThis as { chrome?: unknown }).chrome = createIdeChrome(
      launcher((request) =>
        request.kind === 'local-get' ? { piwiLanguage: { code: 'fr', messages: french } } : undefined,
      ).binding,
    );
    await initI18n();
    expect(t('common_stop')).toBe(french.common_stop!.message);
  });

  it('reads the launcher’s settings field by field', async () => {
    const answers: unknown[] = [
      { file: 'checkout.spec.ts', testIdAttribute: 'data-test' },
      { file: '  ', testIdAttribute: 3 },
      'checkout.spec.ts',
      undefined,
    ];
    const settings = [];
    for (const answer of answers) {
      (globalThis as { chrome?: unknown }).chrome = createIdeChrome(
        launcher((request) => (request.kind === 'local-get' ? { [IDE_SETTINGS_KEY]: answer } : undefined)).binding,
      );
      settings.push(await getIdeSettings());
    }
    expect(settings).toEqual([
      { file: 'checkout.spec.ts', testIdAttribute: 'data-test' },
      { file: null, testIdAttribute: null },
      { file: null, testIdAttribute: null },
      { file: null, testIdAttribute: null },
    ]);
  });

  it('is no extension page: the secrets stay out of reach', () => {
    (globalThis as { chrome?: unknown }).chrome = createIdeChrome(launcher().binding);
    expect(isExtensionContext()).toBe(false);
  });
});

describe('installIdeHost', () => {
  it('installs the host read-only over the launcher’s binding', async () => {
    const { requests, binding } = launcher(() => ({ ok: true }));
    const scope: Record<string, unknown> = { [IDE_RECORDER_BINDING]: binding };
    expect(installIdeHost(scope)).toBe(true);
    const chrome = scope[IDE_CHROME_GLOBAL] as ReturnType<typeof createIdeChrome>;
    await chrome.runtime.sendMessage({ type: 'piwi-ping' });
    expect(requests).toEqual([{ kind: 'message', message: { type: 'piwi-ping' } }]);
    expect(() => {
      scope[IDE_CHROME_GLOBAL] = {};
    }).toThrow(TypeError);
    expect(scope[IDE_CHROME_GLOBAL]).toBe(chrome);
    // Loaded again in the same page, the bundle keeps the host it has.
    expect(installIdeHost(scope)).toBe(true);
    expect(scope[IDE_CHROME_GLOBAL]).toBe(chrome);
  });

  it('hands the recorder’s listeners each message the launcher dispatches', () => {
    const { binding } = launcher();
    const scope: Record<string, unknown> = { [IDE_RECORDER_BINDING]: binding };
    installIdeHost(scope);
    const chrome = scope[IDE_CHROME_GLOBAL] as ReturnType<typeof createIdeChrome>;
    const heard: unknown[] = [];
    const failing = () => {
      throw new Error('a listener that fails');
    };
    chrome.runtime.onMessage.addListener(failing);
    chrome.runtime.onMessage.addListener((message) => void heard.push(message));
    const dispatch = scope[IDE_DISPATCH_GLOBAL] as (message: unknown) => void;
    dispatch({ type: 'piwi-recording-paused', paused: true });
    expect(heard).toEqual([{ type: 'piwi-recording-paused', paused: true }]);
    expect(() => {
      scope[IDE_DISPATCH_GLOBAL] = () => {};
    }).toThrow(TypeError);
  });

  it('keeps calling the binding it found, whatever the page does with the global later', async () => {
    const { requests, binding } = launcher();
    const scope: Record<string, unknown> = { [IDE_RECORDER_BINDING]: binding };
    installIdeHost(scope);
    scope[IDE_RECORDER_BINDING] = () => Promise.reject(new Error('not the launcher'));
    await (scope[IDE_CHROME_GLOBAL] as ReturnType<typeof createIdeChrome>).storage.local.get('piwiLanguage');
    expect(requests).toEqual([{ kind: 'local-get', keys: 'piwiLanguage' }]);
  });

  it('installs nothing without the binding, and leaves the recorder inert', () => {
    const scope: Record<string, unknown> = {};
    expect(installIdeHost(scope)).toBe(false);
    expect(scope).toEqual({});
    expect(installIdeHost({ [IDE_RECORDER_BINDING]: 'not a function' })).toBe(false);
    // Importing the host ran it over the test's own global, which has no binding: the recorder does not start.
    expect(IDE_CHROME_GLOBAL in globalThis).toBe(false);
    expect(ideHostInstalled()).toBe(false);
  });
});
