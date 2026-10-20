import { clearRecordIntent } from '../shared/recording-storage.js';

/**
 * The tab DevTools inspects, as the extension's DevTools pages reach it:
 * `chrome.devtools.inspectedWindow.eval` in the page's world or, with
 * `useContentScriptContext`, in the extension's isolated world, and
 * `chrome.scripting` for the content scripts those evaluations call.
 */

export type EvalResult<T> = { ok: true; value: T } | { ok: false; code: string | null; message: string };

/** Evaluates `expression` in the inspected page, in the extension's content-script world with `contentScript`. */
export function evalInPage<T>(expression: string, options: { contentScript?: boolean } = {}): Promise<EvalResult<T>> {
  return new Promise((resolve) => {
    const evalOptions = options.contentScript ? { useContentScriptContext: true } : {};
    try {
      chrome.devtools.inspectedWindow.eval(expression, evalOptions, (value: unknown, exception) => {
        if (exception && (exception.isError || exception.isException)) {
          resolve({ ok: false, code: exception.code ?? null, message: exception.value ?? exception.description ?? '' });
        } else resolve({ ok: true, value: value as T });
      });
    } catch (err) {
      resolve({ ok: false, code: null, message: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function inspectedTabId(): number {
  return chrome.devtools.inspectedWindow.tabId;
}

/**
 * Firefox's `inspectedWindow.eval` has no `useContentScriptContext`: there the
 * DevTools pages reach the content script by message instead.
 */
export function hasContentScriptContext(): boolean {
  return !navigator.userAgent.includes('Firefox/');
}

/** Injects one of the extension's content scripts into the inspected tab's top frame. */
export async function injectContentScript(file: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await chrome.scripting.executeScript({ target: { tabId: inspectedTabId() }, files: [file] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The inspected page's origin, read in the page's world, which needs no permission. */
export async function inspectedOrigin(): Promise<string | null> {
  const result = await evalInPage<string>('location.origin');
  return result.ok && typeof result.value === 'string' ? result.value : null;
}

/** The host permission pattern for a web origin; null for any other page (`chrome://`, `about:`, a file). */
export { originPattern as sitePattern } from '../shared/web-origin.js';

/**
 * Asks for the origin's optional host permission. Call it inside a click: the
 * browser requires the gesture. Its grant is not a recording's: a "Record
 * actions" intent still parked is cleared with the request, or the grant would
 * start that recording.
 */
export async function requestSiteAccess(pattern: string): Promise<boolean> {
  try {
    const granted = chrome.permissions.request({ origins: [pattern] });
    void clearRecordIntent().catch(() => undefined);
    return await granted;
  } catch {
    return false;
  }
}
