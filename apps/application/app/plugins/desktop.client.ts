/**
 * Desktop shell integration.
 *
 * The dashboard runs unchanged inside the Tauri webview, but a webview is a
 * single window with no browser chrome, so a few web affordances need routing
 * through the native shell:
 *   - external links (`https://…`, GitHub, the docs) have nowhere to open — the
 *     webview would either navigate away from the app or silently drop the
 *     `target="_blank"` new-window request, so we hand them to the OS browser;
 *   - the Web Notification API is unavailable / permission-denied in the
 *     webview, so we shim it onto native OS notifications;
 *   - the shell restarts the bundled server when it stops, and gives up after
 *     repeated crashes: a toast says so, since the API stops answering meanwhile.
 *
 * All of this activates only when the native bridge is actually present —
 * plain browsers (including one opened at the same loopback URL) have no
 * bridge, so the shared web build is unaffected. File downloads (the OpenAPI
 * spec) are handled separately by `useDesktopDownload`, wired at the button
 * that triggers them.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const core = tauriCore();
  if (!core) return; // no bridge — not running inside the desktop shell

  installExternalLinkHandler(core);
  installNativeNotifications(core);
  installErrorForwarding(core);
  installServerStatus();

  // Vue's own error channels don't reach window.onerror — hook them explicitly
  // so a render/lifecycle error or a Nuxt app error also lands in the log. The
  // hooks must return void, so forward fire-and-forget (never return the promise).
  const forwardVueError = (label: string, value: unknown): void => {
    core.invoke('desktop_log', { level: 'error', message: `${label}: ${describeError(value)}` }).catch(() => {});
  };
  nuxtApp.hook('vue:error', (err, _instance, info) => {
    forwardVueError(`vue:error [${info}]`, err);
  });
  nuxtApp.hook('app:error', (err) => {
    forwardVueError('app:error', err);
  });
});

interface Bridge {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

/**
 * Say what the shell's `server-status` events report about the bundled server:
 * `restarting` once it stopped, `ready` once the shell started it again,
 * `crashed` once the shell gave up on it. One toast, updated in place.
 */
function installServerStatus() {
  const events = tauriEvent();
  if (!events) return;
  const toast = useToast();
  const id = 'desktop-server-status';
  void events.listen<string>('server-status', ({ payload }) => {
    if (payload === 'restarting') {
      toast.add({ id, title: 'The local server stopped', description: 'Restarting it…', color: 'warning' });
    } else if (payload === 'ready') {
      toast.add({ id, title: 'The local server restarted', description: undefined, color: 'success' });
    } else if (payload === 'crashed') {
      toast.add({
        id,
        title: 'The local server keeps stopping',
        description: 'Quit and relaunch the app, or open its logs from the tray.',
        color: 'error',
        duration: 0,
      });
    }
  });
}

/** Render an error/rejection reason as one string, keeping the stack when there is one. */
function describeError(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ? `${value.name}: ${value.message}\n${value.stack}` : `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Forward front-end runtime errors to the shell's server log (`desktop_log`).
 * A webview is a separate process whose console never reaches the Node sidecar's
 * stdout, so uncaught errors, promise rejections, CSP violations and
 * `console.error` are invisible in a shipped build — this routes them to the
 * same `logs/server.log` the user can open from the tray, so a reported issue
 * leaves a trace on disk. Desktop-only: the shared web build has no bridge and
 * never installs any of this.
 */
function installErrorForwarding(core: Bridge) {
  const forward = (level: 'error' | 'warn', message: string) =>
    core.invoke('desktop_log', { level, message }).catch(() => {});

  // Uncaught errors and (in capture phase) failed resource loads.
  window.addEventListener(
    'error',
    (event) => {
      if (event.error || event.message) {
        const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
        forward('error', `Uncaught ${describeError(event.error ?? event.message)}${where}`);
        return;
      }
      const el = event.target as (Element & { src?: string; href?: string }) | null;
      const url = el?.src || el?.href;
      if (url) forward('error', `Failed to load resource: ${url}`);
    },
    true,
  );

  window.addEventListener('unhandledrejection', (event) => {
    forward('error', `Unhandled promise rejection: ${describeError(event.reason)}`);
  });

  // CSP violations are how a blocked script/style/frame shows up — the exact
  // signal for a policy that stops the dashboard's own code from running.
  document.addEventListener('securitypolicyviolation', (event) => {
    const at = event.sourceFile ? ` at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}` : '';
    forward('error', `CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || '(inline)'}${at}`);
  });

  // Errors from our sandboxed snapshot/picker iframes: they run on an opaque
  // origin and can reach us only over postMessage, so their own window.onerror
  // never reaches this document (see snapshot-picker-script.ts).
  window.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; message?: unknown; stack?: unknown } | null;
    if (data && data.type === 'piwiError' && typeof data.message === 'string') {
      forward('error', `picker iframe: ${data.message}${data.stack ? ` — ${String(data.stack)}` : ''}`);
    }
  });

  // Mirror console.error / console.warn, preserving the original call so the
  // devtools console still shows them when it is open.
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        forward(level, args.map(describeError).join(' '));
      } catch {
        /* logging must never break the caller */
      }
    };
  }
}

/**
 * Open cross-origin `http(s)` / `mailto:` links in the user's default browser
 * instead of navigating the app window away from itself. Same-origin links
 * (SPA routes, in-app anchors, and same-origin file links handled elsewhere)
 * are left untouched so Vue Router / the download handler still see them.
 */
function installExternalLinkHandler(core: Bridge) {
  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;

      let url: URL;
      try {
        url = new URL(anchor.href);
      } catch {
        return;
      }

      const isWeb = url.protocol === 'http:' || url.protocol === 'https:';
      const isExternalWeb = isWeb && url.origin !== window.location.origin;
      const isMail = url.protocol === 'mailto:';
      if (!isExternalWeb && !isMail) return;

      event.preventDefault();
      core.invoke('desktop_open_external', { url: anchor.href }).catch(() => {});
    },
    true, // capture — beat Vue Router's own click handling
  );
}

/**
 * Replace `window.Notification` with a shim that shows native OS notifications
 * through the shell. The dashboard's notification code checks `'Notification' in
 * window`, reads `Notification.permission`, and constructs `new Notification()`;
 * routing those through the shell makes browser-channel notifications work in
 * the desktop app without touching a dozen call sites. (Native click-to-open is
 * platform-dependent and not wired — the notification still displays.)
 *
 * Every notification shown while the window is hidden or unfocused also bumps
 * the ambient unread state — a dock/taskbar badge where the platform has one,
 * and the tray tooltip everywhere. Focusing the window clears it.
 */
function installNativeNotifications(core: Bridge) {
  let unread = 0;

  window.addEventListener('focus', () => {
    if (unread === 0) return;
    unread = 0;
    core.invoke('desktop_set_activity', { count: 0, status: null }).catch(() => {});
  });

  class NativeNotification extends EventTarget {
    static readonly permission: NotificationPermission = 'granted';
    static requestPermission(): Promise<NotificationPermission> {
      return Promise.resolve('granted');
    }

    onclick: ((this: Notification, ev: Event) => unknown) | null = null;
    onclose: ((this: Notification, ev: Event) => unknown) | null = null;
    onerror: ((this: Notification, ev: Event) => unknown) | null = null;
    onshow: ((this: Notification, ev: Event) => unknown) | null = null;
    readonly title: string;
    readonly body: string;

    constructor(title: string, options?: NotificationOptions) {
      super();
      this.title = title;
      this.body = options?.body ?? '';
      core.invoke('desktop_notify', { title, body: this.body }).catch(() => {});
      if (document.hidden || !document.hasFocus()) {
        unread += 1;
        const status = this.body.split('\n')[0] || this.title;
        core.invoke('desktop_set_activity', { count: unread, status }).catch(() => {});
      }
    }

    close() {}
  }

  try {
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: NativeNotification,
    });
  } catch {
    // A locked-down webview may refuse the redefinition — degrade silently.
  }
}
