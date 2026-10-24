# Reporter — agent guide

Rules for working inside `packages/reporter/` (the published `@piwitests/reporter` package). Read
[`../../AGENTS.md`](../../AGENTS.md) first for repo-wide conventions, and **[`ARCHITECTURE.md`](ARCHITECTURE.md)** for the
full map: public/internal split, the two-process collect-and-submit data flow, the submit fallback ladder, and the
per-directory responsibilities.

## The contracts you can break

1. **Public API** — anything exported from `src/index.ts` (the single `.` entry). Changing it is a breaking change.
   Everything under `src/internal/` is private plumbing; change it freely.
2. **Wire types** (`src/types/wire.ts`) — the JSON exchanged with the server. A change here is a server-contract change
   and must land with the matching dashboard change; `apps/application/tests/unit/wire-shared-drift.test.ts` pins the two
   together.
3. **Side effects** — `PIWI_*` env vars (`internal/config/env.ts`; `PIWI_DASHBOARD_URL`, `PIWI_API_KEY` and
   `PIWI_PROJECT_NAME` also from the `.env` in the Playwright config's folder, below the environment), `piwi-*`
   attachment names (`internal/capture/attachments.ts`), temp files in `os.tmpdir()`, `[Piwi Dashboard]`-prefixed log
   output, the `__piwiProbeElement` global the capture fixtures install into every instrumented page
   (`internal/capture/capture-fixtures.ts`), the `beforeunload` listener code reach adds to each document of a covered
   page in its own isolated world, where the debugger stops to read the coverage as the document is left
   (`internal/capture/code-reach.ts`), the boxed stack prefix `internal/capture/quiet-capture.ts` registers
   for this package's `dist/` in each worker, the proxy every API request context is handed out behind
   (`internal/capture/api-requests.ts`: the `request` fixture's, any `playwright.request.newContext()`'s and
   `page.request`), and the editor's breakpoints (`internal/capture/pause-at.ts`): a headed local run with
   `PIWI_PAUSE_AT` steers each context's `context.debugger` to stop before every call it can stop at, shows the pause
   bar at a call on those lines, sets `PW_CODEGEN_NO_INSPECTOR` in the worker so Playwright's Inspector stays closed
   at those stops, and clears it while a `page.pause()` it leaves to Playwright runs (a listener on the Playwright
   connection's client instrumentation tells them apart), attaches a test's stops as `piwi-pauses` (the reporter takes
   their time out of the steps' durations and start times), and posts a locator picked meanwhile to the editor's
   `PIWI_EDITOR_SEND` address with the line, as `@piwitests/core/editor-send` reads it; with `PIWI_RECORD_CHANNEL`, the
   pause bar's **Record here** (and `page.pause()` in a headed run, patched by the capture fixtures) hands the page to
   the editor's recorder (`internal/capture/record-handoff.ts`): it relays each call of the recorder's binding over that
   local socket, as `@piwitests/core/ide-recorder` frames it, and loads the bundle the editor names. The recorder's host
   stays in the editor service: this package carries the relay alone. With `PIWI_RUN_CHANNEL` (the same socket) and
   `PIWI_ORIGIN_REF`, each worker keeps a run connection to the editor from its worker fixture's setup to its end
   (`internal/capture/run-channel.ts`, framed by `@piwitests/core/run-channel`): it says which test it runs and where
   it stops, takes the editor's Pause, Step, Resume, Finish, Run to a line and breakpoints (in place of
   `PIWI_PAUSE_AT`) through the same stop policy, and answers a request for an image of the stopped page with a JPEG
   screenshot taken through an internal call. While it is open a headless run stops too, held until the editor
   answers; a headed stop shows the bar as well, and the first answer wins. A stop no bar shows goes on when the
   connection closes, and one stop shows at a time in a worker.
4. **The desktop discovery file** — `~/.piwi/desktop.json` and its `{ url, token }` shape
   (`internal/config/desktop.ts`). The desktop shell writes it (`apps/desktop/src-tauri/src/lib.rs`) and this package reads
   it, on independent release cycles, so path and shape changes must land in both.
5. **Invisible capture.** Nothing the capture fixtures do may show up as the test's own: a Playwright method a
   wrapper forwards is called on its receiver (`callMethod` — never `fn.apply`, which renames the call
   `locator.apply`), and every page read the fixtures make goes through `internalCall` (never a bare
   `page.evaluate` / `ariaSnapshot`), so it is neither a step nor a trace action. A copy that wraps locators
   from its own file (the dogfood mirror) passes that file to `boxCaptureFrames` so its frames are boxed too.
   `tests/integration/verify-reporter.ts` checks both.

## Conventions

- The package is **strict-mode TypeScript**. Node built-ins are imported as `import * as x from 'node:x'`.
- Classes use `private readonly` constructor parameter-property DI.
- HTTP failures throw `HttpError` (carrying `status`) from `internal/transport/http-client.ts`.
- `catch (error)` is `unknown` — narrow with `instanceof`, format with `errorMessage` (`internal/support/errors.ts`).
- Shared pure logic (locator generation/scoring, ARIA fingerprints, wire leaf shapes) comes from **`@piwitests/core`**
  and is bundled in by tsup, so the published package stays self-contained. **Never re-implement a core function here**
  — `apps/application/tests/unit/reporter-core-identity.test.ts` asserts the reporter re-exports the exact core functions and
  fails on a copy. **Never import `apps/application/shared`** from the reporter.
- `internal/submit/serializer.ts` is the single source of truth for the wire field list: `toWireTestCase` for per-case
  fields, `serializeRun` for the run body (used by both `uploadJSON` and `uploadWithFiles`).

## Workflow

```bash
npm run reporter:build      # tsup → dist/ (.js + .d.ts); reporter:dev for watch mode
npm run reporter:typecheck
npm run reporter:lint       # :fix to auto-fix
npm run reporter:format     # :check to verify only
npm run reporter:test       # :watch, :coverage, :integration
                            # :integration:ai runs the AI-step authoring loop against a stubbed resolver;
                            # :integration:ai:live drives a real model through a real dashboard (spends tokens)
npm run reporter:bench      # capture-overhead benchmark; :micro for the Node-side hot path
```

`tests/bench/` measures what the capture fixtures cost a suite — see its [`README.md`](tests/bench/README.md) for the
variant ladder, the knobs, and reference numbers. Reach for it before optimizing anything under `internal/capture/`.

Source is TypeScript in `src/`; `dist/` is generated — never edit it. To try the package in a real project, build then
`npm link` here and in the target project.

Adding a field that flows from Playwright to the dashboard touches both repos' halves — follow the ordered checklist in
[`apps/application/AGENTS.md`](../../apps/application/AGENTS.md#adding-a-field-to-test-run-data).
