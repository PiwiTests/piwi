import { fallbackReasonOf, type FallbackReason } from '../shared/cdp-input.js';

/**
 * The extension's debugging sessions, one per tab at most, shared by the
 * features that need one: a replay's trusted input, a recording's
 * evidence, the request conditions and the viewport set from DevTools. Chrome
 * shows its "started debugging this browser" bar while a session is attached,
 * so a feature holds the session only while it runs, and the session is
 * detached as soon as no feature holds it.
 *
 * Firefox has no `chrome.debugger`: `debuggerAvailable()` is false there and
 * every feature keeps its own way of working without it.
 */

/** What holds a tab's session. */
export type DebugPurpose = 'replay' | 'bug' | 'conditions' | 'viewport';

const PROTOCOL_VERSION = '1.3';

type EventListener = (method: string, params: Record<string, unknown>) => void;
type LostListener = (tabId: number, purposes: DebugPurpose[], reason: FallbackReason) => void;

interface TabSession {
  purposes: Set<DebugPurpose>;
  listeners: Set<EventListener>;
}

const sessions = new Map<number, TabSession>();
/** Attaches in progress, so two features asking at once attach once. */
const attaching = new Map<number, Promise<{ ok: true } | { ok: false; reason: FallbackReason; error: string }>>();
/** The purposes waiting on an attach in progress; a release while it attaches takes its purpose out. */
const wanted = new Map<number, Set<DebugPurpose>>();
const lostListeners = new Set<LostListener>();

export function debuggerAvailable(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.debugger?.attach === 'function';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function attach(tabId: number): Promise<{ ok: true } | { ok: false; reason: FallbackReason; error: string }> {
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    return { ok: true };
  } catch (err) {
    const error = errorText(err);
    // A session this worker lost track of (it was restarted) still counts as ours: detach it and attach again.
    if (/already attached/i.test(error)) {
      try {
        await chrome.debugger.detach({ tabId });
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
        return { ok: true };
      } catch (again) {
        return { ok: false, reason: fallbackReasonOf(null, errorText(again)), error: errorText(again) };
      }
    }
    return { ok: false, reason: fallbackReasonOf(null, error), error };
  }
}

/**
 * Holds the tab's session for `purpose`, attaching when nothing holds it yet.
 * Fails with why (unavailable, refused by the browser) rather than throwing.
 */
export async function acquireDebugger(
  tabId: number,
  purpose: DebugPurpose,
): Promise<{ ok: true } | { ok: false; reason: FallbackReason; error: string }> {
  if (!debuggerAvailable()) return { ok: false, reason: 'unavailable', error: '' };
  const existing = sessions.get(tabId);
  if (existing) {
    existing.purposes.add(purpose);
    return { ok: true };
  }
  const waiting = wanted.get(tabId) ?? new Set<DebugPurpose>();
  waiting.add(purpose);
  wanted.set(tabId, waiting);
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = attach(tabId);
    attaching.set(tabId, pending);
  }
  const result = await pending;
  if (attaching.get(tabId) === pending) attaching.delete(tabId);
  const stillWanted = waiting.delete(purpose);
  if (waiting.size === 0 && wanted.get(tabId) === waiting) wanted.delete(tabId);
  if (!result.ok) return result;
  const session = sessions.get(tabId) ?? { purposes: new Set<DebugPurpose>(), listeners: new Set<EventListener>() };
  if (stillWanted) session.purposes.add(purpose);
  sessions.set(tabId, session);
  if (!stillWanted) {
    // Released while it attached: detached unless another purpose holds or still waits for the session.
    if (session.purposes.size === 0 && !wanted.has(tabId)) {
      sessions.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
    }
    return { ok: false, reason: 'lost', error: 'released' };
  }
  return { ok: true };
}

/** Lets go of the tab's session for `purpose`, and detaches when nothing else holds it. */
export async function releaseDebugger(tabId: number, purpose: DebugPurpose): Promise<void> {
  wanted.get(tabId)?.delete(purpose);
  const session = sessions.get(tabId);
  if (!session) return;
  session.purposes.delete(purpose);
  if (session.purposes.size > 0) return;
  sessions.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

/** Whether `purpose` holds the tab's session now. */
export function holdsDebugger(tabId: number, purpose: DebugPurpose): boolean {
  return sessions.get(tabId)?.purposes.has(purpose) ?? false;
}

/** The tabs whose session `purpose` holds, or is attaching for. */
export function tabsHolding(purpose: DebugPurpose): number[] {
  const tabs = new Set<number>();
  for (const [tabId, s] of sessions) if (s.purposes.has(purpose)) tabs.add(tabId);
  for (const [tabId, w] of wanted) if (w.has(purpose)) tabs.add(tabId);
  return [...tabs];
}

/** Sends one protocol command to the tab's session. Throws when there is none or the browser refuses it. */
export async function sendCommand<T = Record<string, unknown>>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!sessions.has(tabId)) throw new Error('not attached');
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

/** Calls `listener` with every protocol event of the tab's session until the returned function is called. */
export function onDebuggerEvent(tabId: number, listener: EventListener): () => void {
  const session = sessions.get(tabId);
  if (!session) return () => undefined;
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

/** Calls `listener` when a session ends without being released: the person cancelled it, or the tab closed. */
export function onDebuggerLost(listener: LostListener): void {
  lostListeners.add(listener);
}

if (debuggerAvailable()) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId == null) return;
    const session = sessions.get(source.tabId);
    if (!session) return;
    for (const listener of session.listeners) {
      try {
        listener(method, (params ?? {}) as Record<string, unknown>);
      } catch (err) {
        console.warn('[Piwi Picker] debugger event:', err);
      }
    }
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId != null) sessionEnded(source.tabId, String(reason));
  });
  // What Cancel on Chrome's debugging bar does, for the e2e suite, which cannot click the browser's own bar.
  (globalThis as { __piwiCancelDebugging?: (tabId: number) => Promise<void> }).__piwiCancelDebugging = async (
    tabId: number,
  ) => {
    if (!sessions.has(tabId)) return;
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    sessionEnded(tabId, 'canceled_by_user');
  };
}

/** A session the browser ended: whoever held it hears why. */
function sessionEnded(tabId: number, reason: string): void {
  const session = sessions.get(tabId);
  if (!session) return;
  sessions.delete(tabId);
  const why = fallbackReasonOf(reason, null);
  for (const listener of lostListeners) listener(tabId, [...session.purposes], why);
}
