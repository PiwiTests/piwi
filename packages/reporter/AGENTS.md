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
   at those stops, and clears it while a `page.pause()` it leaves to Playwright runs (it wraps `Page.prototype.pause`,
   so a page of a browser the test launched itself goes through it too, unless it came from a second copy of
   Playwright, whose `page.pause()` then stops with neither bar nor Inspector), ends the stops shown (the bar's, and
   those the run connection holds) as the test function ends, ahead of the runner's other callbacks there
   (`_onDidFinishTestFunctionCallbacks`), setting the runner's count of a test function that ended under one back to
   what it held as the stop began (`_timeoutManager.defaultSlot()`, feature-checked) and waiting a while for the call
   it let go and its requests, attaches a test's stops as
   `piwi-pauses` (the reporter sends them as `pause` step events, and leaves their time out of the step statistics,
   the steps keeping their measured times), and posts a locator picked meanwhile to the editor's `PIWI_EDITOR_SEND`
   address with the line, as `@piwitests/core/editor-send` reads it; with `PIWI_RECORD_CHANNEL`, the pause bar's
   **Record here** (and `page.pause()` in a headed run, patched by the capture fixtures) hands the page to the
   editor's recorder (`internal/capture/record-handoff.ts`): it relays each call of the recorder's binding over that
   local socket, as `@piwitests/core/ide-recorder` frames it, and loads the bundle the editor names. The recorder's host
   stays in the editor service: this package carries the relay alone. With `PIWI_RUN_CHANNEL` (the same socket) and
   `PIWI_ORIGIN_REF`, each worker keeps a run connection to the editor from its worker fixture's setup to its end
   (`internal/capture/run-channel.ts`, framed by `@piwitests/core/run-channel`; `PIWI_RUN_CHANNEL` and the pairing's
   `PIWI_EDITOR_SEND` are taken out of the worker's `process.env` while a test runs, `hideRunChannel`, so a process a
   test starts opens none on the run and is not handed the pairing's token, the test's picks still posted to it
   (`editorSendAddress`), and put back after it, since Playwright hands what a worker's environment lost to the
   projects depending on its own): it says
   which test it runs and where it stops, takes the editor's Pause, Step, Resume, Finish, Run to a line and breakpoints
   (in place of `PIWI_PAUSE_AT`) through the same stop policy, and answers a request for an image of the stopped page
   with a JPEG screenshot taken through an internal call, none for a stop whose page it cannot tell (a navigation or a
   key press in a context with several pages). Its `run-attach` lists what it takes (`takes`: the intents `pick`,
   `record`, `assert`, `assert-region` and the queries `requests`, `mock`, `locator`): at a stop the pause bar shows, a
   `request` naming that stop starts the bar's own **Pick a locator** or **Record here** (`BarIntents` in
   `pause-at.ts`, which the bar's loop races against its own buttons: the same picker, the pick posted to
   `PIWI_EDITOR_SEND`, the same hand-off over `PIWI_RECORD_CHANNEL`), **Assert** (the same hand-off in its `check`
   mode, naming the stop: the editor's recorder opens the check panel's Check an element alone, and the editor service
   writes the check) or **Assert a region** (the bar's picker, then the confirmed locator's `ariaSnapshot()`, sent as
   `region` without the value of a field that holds a secret (a password field's, or one whose `autocomplete` asks for
   a password, a one-time code or a card's number, `SECRET_AUTOCOMPLETE` of `@piwitests/core/mask`, read through a
   locator, so in open shadow roots too) nor a link's URL holding a credential, a link left without a child ending
   without its colon, `region-snapshot.ts`; a region its locator does not find alone, or whose snapshot is too long,
   is sent as `region` with `refused` instead), each
   ending with the stop, the test's window brought to the front through an internal call, and is
   answered at once with whether it started: refused at a stop that ended or is ending (its test ended, its page or
   context began to close), one no bar shows, one whose page it cannot tell, without a record channel for Record here
   and Assert, and while a pick, a check or a recording runs. At any stop, headless included, `requests` lists the
   responses the test kept and `mock` hands over one of them with its body (`kept-responses.ts`: while the run
   connection is open, the fetch and XHR answers of the test's pages since it began whose type is text or unnamed,
   the latest 50, 256 KB each at most as their `content-length` says (one that says none is listed without a size),
   each kept as its `Response` in the worker's memory alone, its body read only when `mock` asks for it, through an
   internal call, refused when the browser no longer holds it or it is not text, never in an attachment, and dropped
   as the test ends; every URL listed or handed over with its credentials hidden part by part, its host and ids kept,
   `hideSecretsInUrl` of `@piwitests/core/mask`), and `locator` counts a chain (`chain-locator.ts`, built through the chain grammar's calls
   alone) on the stopped page, one count after the other, and, where the bar shows, outlines its matches with
   Playwright's highlight, the one before taken down first and the last before the stop ends. While it is open a headless run stops too, held until the
   editor answers; a headed stop shows the bar as well, and the first answer wins. Whoever answers a stop, it goes to
   `piwi-pauses` as one at the bar does, and every stop's end reaches the editor (`running`), one that ends unanswered
   (the test function ended, its page or context closed, or for a stop whose page it cannot tell any page of its
   context closed) included, through the same end as at the bar. A stop no bar shows goes on when the connection
   closes, and one stop shows at a time in a worker: one waiting its turn is decided again as it comes, and goes on
   unshown, the editor never hearing of it, when the test ended meanwhile (as on Finish), its page or context closed
   or its breakpoint went, leaving the Step, Pause or line run to it used up for the next stop. Closing a context,
   itself or with its browser, lets the call its debugger holds go on first, since the close never lets it go. A test
   that fails while the connection is open to an editor that shows a held failure (`holdFailure` in
   `capture-fixtures.ts`, `editorShows`: the worker's `run-attach` lists `holds`, and the editor answers it with
   `attached` naming `failure`; one that predates it says nothing, and no failure is held; not an expected failure,
   never under CI nor Playwright's own debugger) holds its page once the test function, its hooks and the fixtures built on
   `page` are done (Piwi's `page` fixture, after `use(page)`; a page the test left open, at the capture fixture's
   teardown), never from a close while the test runs: its evidence is read first and kept as it was (`frozenAt`: no
   request, console entry or dialog of the hold is recorded, and its context's code reach ends; Playwright's own
   trace and video go on recording through the hold), and the test timeout is held while the stop shows. It is a stop
   with the reason `failure` at the failing line (where the error's stack enters the test's code, else the failing
   locator's, else the call a test timeout cut short, the runner's step in progress, else the test's declaration),
   naming its error to the editor (`error`: the failing error's lines up to a blank one or its call log, four at most,
   without ANSI codes nor the `Error: ` the runner writes before a plain error's message, `failureError`; its title and
   its error with the credentials of the URLs they name hidden, `hideSecretsInText`), the bar
   saying `Failed at …` with Resume, Pick a locator (which replaces the failing locator, and is folded into
   its snapshot) and Record here; any answer lets the test end as it failed, and the editor service lets one go at
   once in a run nobody watches. Without a run connection nothing of it runs.
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
