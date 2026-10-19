# @piwitests/instrumentation-nitro

Nitro / Nuxt server plugin for [Piwi Dashboard](https://piwitests.dev) — captures Warning and Error log entries per HTTP request and delivers them to the Piwi Dashboard reporter via the `X-Piwi-Logs` response header.

During a Playwright test run, the reporter reads this header from every response and stores the entries alongside the network request. The entries are then available in the Piwi Dashboard test-case view and are included in the AI diagnosis context.

**Active in development and test only, by default.** Capture and probe verification run only outside production, using the same Development/Test allow-list as the ASP.NET package. Controlled by the `PIWI_TEST_LOGS_DISABLED` environment variable:

- unset — capture is on when `NODE_ENV` is `development` or `test`; off for any other value (`production`, `staging`, `prod`, …) and when `NODE_ENV` is not set at all, as when a built server is started with `node .output/server/index.mjs`
- `PIWI_TEST_LOGS_DISABLED=true` — capture is off everywhere
- `PIWI_TEST_LOGS_DISABLED=false` — capture is on even in production builds (useful for a production-mode test deployment)

## Installation

```bash
npm install @piwitests/instrumentation-nitro
```

## Usage

Create a file in your project's server plugins directory:

```typescript
// Nuxt: server/plugins/piwi-test-logs.ts
// Standalone Nitro: plugins/piwi-test-logs.ts
export { default } from '@piwitests/instrumentation-nitro'
```

That's all. Nitro auto-loads every file in that directory on startup (`server/plugins/` in a Nuxt app, `plugins/` under the Nitro `srcDir` in a standalone Nitro app).

[`examples/sample-app`](../../examples/sample-app) runs a standalone Nitro app with this package wired in (`backends/nitro/`), and a Playwright suite that checks what it sends: backend logs, the route manifest, server spans and server probes.

## Route manifest

Outside production, the plugin serves `GET /__piwi/manifest`: the routes the app declares. The Piwi reporter fetches it when a run starts and uploads it, so a declared route no test reaches becomes a **declared, never hit** gap in the Test Map. Nitro has no route table to read while it runs, so add the package's module, which reads it when the server is bundled (again on each rebuild in development):

```typescript
// Standalone Nitro: nitro.config.ts
export default defineNitroConfig({ modules: ['@piwitests/instrumentation-nitro/module'] })

// Nuxt: nuxt.config.ts
export default defineNuxtConfig({ nitro: { modules: ['@piwitests/instrumentation-nitro/module'] } })
```

The manifest then lists every route Nitro scanned (`routes/`, `api/`) and every handler the config declares, middleware and a fallback catch-all (`/**`) left out, each with its method (`GET` for a route that answers any method), its pattern (`/api/orders/:id`) and its file relative to the git repository. Without the module, it lists only the routes the server has answered since it started, which the reporter, reading it before any test runs, rarely sees. Nuxt pages are rendered by one catch-all route, so they are not listed: name them in a `piwi.manifest.json`.

## What gets captured

| Source                               | What is captured                               |
|--------------------------------------|------------------------------------------------|
| `consola.warn()` / `consola.error()` | Warning and Error entries logged via consola   |
| Unhandled H3/Nitro errors            | Errors thrown in route handlers and middleware |

> Only calls made through **consola** are captured — bare `console.warn()` / `console.error()` output is not. Nuxt server code typically logs via consola already; in a standalone Nitro app, `import { consola } from 'consola'` in your handlers.

Each captured entry contains:

| Field       | Description                                                                          |
|-------------|--------------------------------------------------------------------------------------|
| `timestamp` | Unix timestamp in milliseconds                                                       |
| `level`     | `"Warning"` or `"Error"`                                                             |
| `category`  | Logger tag/category (e.g. `"database"`)                                              |
| `message`   | Log message (truncated at 500 characters)                                            |
| `stack`     | Shrunk stack trace when an `Error` was logged (max 5 frames, internal frames dropped) |

Up to 50 entries per request are included, the first ones logged; an entry logged once the response ended (a timer or a lazy client the request started) is dropped. A request the server makes to itself while rendering a page (`$fetch` or `useFetch` during server-side rendering) adds its entries and spans to the page's request. The header is always emitted (with an empty array when no entries were captured) so the Piwi reporter can confirm the plugin is active.

## How it works

```
Playwright test
  └─ page.goto('/api/orders')
       └─ Nitro route handler runs
            ├─ consola.warn('Stock low')     ← captured via consola reporter
            └─ HTTP response
                 └─ X-Piwi-Logs: <gzip+base64 JSON>
                      └─ Piwi reporter reads header
                           └─ stored as serverLogs on the network request
                                └─ visible in test-case detail + AI diagnosis
```

The plugin wraps Nitro's root H3 handler and uses three mechanisms:

1. **`event.context._piwiLogs`** — a plain per-request array attached to the H3 event as the wrapped handler starts; everything captured for the request accumulates here.
2. **`AsyncLocalStorage.run()`** — scopes that buffer around the entire downstream chain (hooks, middleware, route handlers), so the process-global `consola` reporter always appends to the correct request's buffer.
3. **A patched `res.end`** — the header is written just before the response goes out, which covers **every** response, including H3 error responses that bypass Nitro's `beforeResponse` hook. Right before writing, unhandled errors are drained from `event.context.nitro.errors`, so thrown errors appear even when nothing logged via consola.

## Server probes — the `X-Piwi-Probe` header

The plugin accepts a signed fault instruction from a Piwi probe run (Test Map,
level two), so a passing test can be checked against the server's real error
path. A verified header is always recorded on the request scope
(`event.context._piwiProbe`); a fault is **applied** only once a project turns
server probes on (`PIWI_SERVER_PROBES=true`), which stays off by default.

The header is honored only outside production, under the **same guard as log
capture** (`PIWI_TEST_LOGS_DISABLED`), and only when a shared secret is set:

| Variable             | Effect                                                             |
|----------------------|-------------------------------------------------------------------|
| `PIWI_PROBE_SECRET`  | Shared HMAC secret. When unset, the probe header is ignored.      |
| `PIWI_SERVER_PROBES` | `true` to apply verified faults to the signed request.            |

**Faults applied** (to the one request the probe run signs — the reporter picks
the Nth match and signs that request, so the plugin applies the fault to any
request the header matches and the single-use nonce keeps it from repeating;
gated per project on the dashboard side): `throw`, `status`/`auth` (run the
server's error path with a
500/401), `delay`/`slow`/`slow-first` (+5s), `extreme` (empty default),
`data`/`drop-field`/`empty-body` (mutate the response before serialization), and
`dependency` (fail one outbound `$fetch` whose URL names the targeted
dependency; when no call matches, nothing is applied). The plugin reports
the fault it actually applied in `X-Piwi-Trace` (root-span `piwi.probe.applied`),
so a probe the server did not honor is recorded as **inconclusive**, never a pass.

**Entry condition.** Turn this on when the client probes (level one) report
"not-noticed" on at least one in ten probed pairs across your pilot projects —
that is the signal the suite has false comfort the network boundary cannot reveal.

**Header format.** `X-Piwi-Probe` carries a base64-encoded JSON envelope:

```jsonc
{
  "nonce": "<hex, single use>",
  "ts": 1700000000000,            // issued-at, Unix ms; honored within 60s
  "specJson": "{\"route\":\"POST /api/orders\",\"fault\":\"status-500\",\"nth\":1}",
  "sig": "<hex HMAC-SHA256>"      // over `${nonce}.${ts}.${specJson}` with PIWI_PROBE_SECRET
}
```

`specJson` is the exact JSON string that was signed (the plugin re-parses it
after the signature check, so no canonicalization is needed). A verified spec is
exposed on `event.context._piwiProbe` for future handler use. The signing and
verification helpers are exported (`signProbeMessage`, `verifyProbeHeader`).

> **Single-use nonces are tracked per process.** The plugin remembers honored
> nonces in memory to reject replays within the 60s TTL, so a header replayed to a
> *different* instance behind a load balancer — or after a restart — is not
> caught by the nonce check (the TTL and signature still bound it). Probe runs
> target a single instance, so this is not a concern in practice; run the probed
> server as one instance if you need the replay guard to be exact.

The root request span also carries the matched handler's source file as
`attrs['piwi.handler']` when Nitro exposes it, so the dashboard can attribute a
route to its handler by observation rather than by convention.

## Peer dependencies

| Package     | Version   |
|-------------|-----------|
| `nitropack` | `>=2.0.0` |
| `h3`        | `>=1.0.0` |
| `consola`   | `>=3.0.0` |

These are already installed in any Nuxt project — no extra installs needed.

## Building from source

```bash
cd integrations/nitro
npm run build   # emits dist/index.js + dist/index.d.ts
```

## License

MIT
