/// <reference lib="WebWorker" />
/**
 * Demo-mode service worker.
 *
 * Intercepts fetch requests that target the API routes used by the Nuxt app
 * and handles them entirely in-browser using sql.js (WASM SQLite) + Drizzle
 * ORM.  This eliminates the need for any real server in the static demo build.
 *
 * How it integrates with the app:
 *   1. `$fetch` prefixes every `/api/…` call with the app's base URL,
 *      `[demoBase]/api/…` (e.g. `/piwi-dashboard/demo/api/projects`),
 *      which falls inside the service worker's registration scope.
 *   2. This service worker intercepts those fetch events, queries the
 *      in-browser SQLite database, and returns JSON responses.
 *
 * The service worker is only registered in demo mode (controlled by the
 * @vite-pwa/nuxt module configuration in nuxt.config.ts).
 */

import { handleDemoRequest } from '../demo/api/router';
import { configureDemoDb, resetDemoDb } from '../demo/db.client';
import { DEMO_USER_COOKIE } from '../demo/demo-users';
import { type ErrorCode, errorCodeForStatus } from '#shared/utils/error-codes';

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

// Minimal shape of the Cookie Store API this worker uses. It is not in every
// browser's worker types (and absent entirely in some, e.g. Firefox), so it is
// typed and accessed defensively rather than assumed present.
interface CookieStoreLike {
  get(name: string): Promise<{ value: string } | null | undefined>;
}
const cookieStore = (self as unknown as { cookieStore?: CookieStoreLike }).cookieStore;

// The "act as" demo identity published by the page via postMessage — the
// fallback the fetch handler reads when the Cookie Store API is unavailable.
let postedActingUserId: number | null = null;

// Resolve the demo user a request should act as. An explicit header wins (the
// API playground sets one directly); otherwise fall back to the cookie the
// demo-fetch plugin sets, then to the last postMessage. Returns null for the
// default identity.
async function resolveActingUserId(request: Request): Promise<number | null> {
  const header = request.headers.get('x-demo-user-id');
  if (header) return Number(header) || null;
  try {
    const cookie = await cookieStore?.get(DEMO_USER_COOKIE);
    if (cookie?.value) return Number(cookie.value) || null;
  } catch {
    // Cookie Store API not available in this worker; use the postMessage value.
  }
  return postedActingUserId;
}

// Derive the base URL from the service worker's own location.
// e.g. if SW is at https://host/piwi-dashboard/demo/sw.js
//   SW_DIR_URL = 'https://host/piwi-dashboard/demo/'
//   API_PREFIX  = '/piwi-dashboard/demo/api/'
const SW_DIR_URL = self.location.href.replace(/\/[^/]*$/, '/');
const API_PREFIX = new URL(SW_DIR_URL).pathname.replace(/\/+$/, '') + '/api/';
// The registration scope path (trailing slash), e.g. '/demo/'.
const SCOPE_PATH = new URL(SW_DIR_URL).pathname;
// The generated single-page app shell, served for in-scope navigations.
const APP_SHELL_URL = SW_DIR_URL + 'index.html';
// The bundled trace viewer has its own service worker + entry HTML; never
// hand it the SPA shell.
const TRACE_VIEWER_PREFIX = SCOPE_PATH + 'trace-viewer/';

// Configure the db module to locate WASM + seed SQL relative to the SW.
configureDemoDb(SW_DIR_URL);

// ── Lifecycle ──────────────────────────────────────────────────────────────

self.addEventListener('install', () => {
  // Take control immediately so the very first navigation after registration
  // is already intercepted without a second page load.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim all open clients so existing tabs benefit from the SW right away.
  event.waitUntil(self.clients.claim());
});

// ── Reset handling ───────────────────────────────────────────────────────────
// The page's "reset demo" action wipes IndexedDB from the window context, but
// this service worker holds its OWN long-lived in-memory SQLite instance (a
// separate db.client module copy) that would otherwise keep answering queries
// with the old, possibly obsolete-schema data after the reload. Drop it here so
// the next query re-seeds from the freshly-wiped IndexedDB, then acknowledge on
// the message port so the page can reload only once the reset has taken effect.
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; id?: number | null } | undefined;
  if (data?.type === 'piwi-demo-user') {
    postedActingUserId = typeof data.id === 'number' ? data.id : null;
    return;
  }
  if (data?.type !== 'piwi-demo-reset') return;
  event.waitUntil(
    resetDemoDb()
      .catch((e) => console.error('[Demo SW] reset failed', e))
      .then(() => event.ports?.[0]?.postMessage({ type: 'piwi-demo-reset-done' })),
  );
});

// ── Fetch interception ─────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Serve the SPA shell for top-level navigations within our scope. The demo
  // is a static client-only SPA, so a deep-link reload (e.g. /demo/projects/123)
  // has no matching static file — without this it would fall through to the
  // static host's 404 handling and land the user back on the home page. Once the
  // shell loads, Vue Router reads the URL and renders the correct page directly.
  // API and trace-viewer paths are excluded (handled below / by their own SW).
  if (
    event.request.mode === 'navigate' &&
    url.origin === self.location.origin &&
    url.pathname.startsWith(SCOPE_PATH) &&
    !url.pathname.startsWith(API_PREFIX) &&
    !url.pathname.startsWith(TRACE_VIEWER_PREFIX)
  ) {
    event.respondWith(
      (async () => {
        try {
          // Revalidate the shell on every navigation. GitHub Pages serves
          // index.html with a short max-age and allows no cache-control
          // override, so `no-cache` forces a conditional request (304 when
          // unchanged) that always resolves to the current deploy's shell and
          // the content-hashed bundles it references.
          const shell = await fetch(APP_SHELL_URL, { credentials: 'same-origin', cache: 'no-cache' });
          if (shell.ok) return shell;
        } catch {
          // Offline or fetch failure — fall back to the original request below.
        }
        return fetch(event.request);
      })(),
    );
    return;
  }

  // Only handle requests to the demo-scoped API prefix.
  if (!url.pathname.startsWith(API_PREFIX)) return;

  // Map /piwi-dashboard/demo/api/… back to /api/…
  const apiPath = '/api/' + url.pathname.slice(API_PREFIX.length);
  const queryString = url.search ? url.search.slice(1) : undefined;
  const method = event.request.method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

  event.respondWith(
    (async () => {
      // The "act as" demo identity (applies that user's project affectations).
      const actingUserId = await resolveActingUserId(event.request);

      let body: unknown;
      if (method !== 'GET') {
        // The import endpoint uploads an archive, so multipart bodies reach the
        // router as `FormData`; everything else is JSON.
        const contentType = event.request.headers.get('content-type') ?? '';
        try {
          body = contentType.includes('multipart/form-data')
            ? await event.request.clone().formData()
            : await event.request.clone().json();
        } catch {
          body = undefined;
        }
      }

      let result: unknown;
      try {
        result = await handleDemoRequest(apiPath, method, body, queryString, actingUserId);
      } catch (e) {
        // Surface the real error message in the response body (instead of a
        // generic "Internal server error") so it shows up in the app's own
        // error UI and the page console — service worker console.error calls
        // are easy to miss since they live under a separate DevTools context.
        // Handlers throw DemoHttpError for client errors; those keep their
        // status code (400/403/404/409) instead of collapsing into a 500.
        const message = e instanceof Error ? e.message : String(e);
        const statusCode = (e as { statusCode?: number } | null)?.statusCode ?? 500;
        const errorCode = (e as { errorCode?: ErrorCode } | null)?.errorCode ?? errorCodeForStatus(statusCode);
        const data = (e as { data?: unknown } | null)?.data;
        const extra = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        console.error('[Demo SW] handler error for', apiPath, e);
        return new Response(JSON.stringify({ statusCode, message, data: { ...extra, errorCode } }), {
          status: statusCode,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (result === undefined) {
        return new Response(
          JSON.stringify({ statusCode: 404, message: 'Not found', data: { errorCode: 'NOT_FOUND' } }),
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      // Support binary responses from file handlers
      if (result && typeof result === 'object' && '_binary' in result) {
        const binary = result as unknown as { data: string; contentType: string };
        const decoded = Uint8Array.from(atob(binary.data), (c) => c.charCodeAt(0));
        return new Response(decoded, {
          status: 200,
          headers: { 'Content-Type': binary.contentType },
        });
      }

      // Pass through Response objects directly (SSE streams, etc.)
      if (result instanceof Response) {
        return result;
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    })(),
  );
});
