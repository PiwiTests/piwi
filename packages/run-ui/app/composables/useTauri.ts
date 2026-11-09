/**
 * Access to the Tauri IPC bridge injected into the desktop shell's webview.
 *
 * The bundled dashboard is served over loopback and the desktop shell injects
 * `window.__TAURI__` (via `withGlobalTauri`), reachable only from the app's own
 * window — a plain browser at the same URL has no bridge. Everything here
 * feature-detects the bridge and no-ops when it is absent, so the shared web
 * build imports it harmlessly.
 */
interface TauriCore {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

interface TauriEvent {
  listen: <T = unknown>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
}

/** The native invoke bridge, or `null` when not running inside the desktop shell. */
export function tauriCore(): TauriCore | null {
  const g = globalThis as unknown as { __TAURI__?: { core?: TauriCore } };
  return g.__TAURI__?.core ?? null;
}

/** The native event bridge (shell → webview), or `null` outside the desktop shell. */
export function tauriEvent(): TauriEvent | null {
  const g = globalThis as unknown as { __TAURI__?: { event?: TauriEvent } };
  return g.__TAURI__?.event ?? null;
}

interface TauriWindowApi {
  getCurrentWindow: () => { label: string };
}

/**
 * The label of the shell window this page runs in — `main` for the dashboard
 * window, `aux-<n>` for a window opened with `desktop_open_window`,
 * `output-<name>_<n>` for a run's output window — or `null` outside the
 * desktop shell.
 */
export function tauriWindowLabel(): string | null {
  const g = globalThis as unknown as { __TAURI__?: { window?: TauriWindowApi } };
  try {
    return g.__TAURI__?.window?.getCurrentWindow().label ?? null;
  } catch {
    return null;
  }
}
