# Reporter: agent guide

Rules for working inside `packages/reporter/` (the published `@piwitests/reporter` package: the reporter, its
fixtures, the `piwi` command line and the agent skills). Read [`../../AGENTS.md`](../../AGENTS.md) first for repo-wide
conventions, and **[`ARCHITECTURE.md`](ARCHITECTURE.md)** for the map: the public and internal code, its side effects,
the two-process collect-and-submit data flow, the submit fallback ladder, the agent skills and the per-directory
responsibilities.

## The contracts you can break

1. **Public API.** Anything exported from `src/index.ts` (the single `.` entry) is public: changing it is a breaking
   change. `tests/build-output.spec.ts` pins the package to that one entry. Code under `src/internal/` is private and
   free to change, except the modules of contract 5.
2. **Wire types** (`src/types/wire.ts`) are the JSON exchanged with the server. A change here is a server-contract
   change and must land with the matching dashboard change; `apps/application/tests/unit/wire-shared-drift.test.ts`
   pins the two together.
3. **Side effects**: what a user's suite can observe, each changed only on purpose:
   - a requested run's `PIWI_REQUEST_INSTANCE` and `PIWI_REQUEST_TOKEN_FILE`, which beat every other server and
     credential, in the reporter and in each worker's environment (`applyRequestedRunEnv`, written last), and skip
     every rung but `/finish` ([`ARCHITECTURE.md`](ARCHITECTURE.md#side-effects), `tests/requested-run.spec.ts`);
   - `PIWI_*` env vars (`internal/config/env.ts`; `PIWI_DASHBOARD_URL`, `PIWI_API_KEY` and `PIWI_PROJECT_NAME` also from
     the `.env` in the Playwright config's folder, below the environment), and the ones `onBegin` sets for the workers:
     the boolean ones as `true` or `false` (`normalizeBoolEnv`); for a run started in a terminal or by an editor's
     test runner, the `PIWI_RUN_CHANNEL` and `PIWI_RUN_REF` of its hub (`internal/config/hub.ts`: never under CI,
     Playwright's debugger or UI mode, nor with `PIWI_EDITOR=off`), with an editor's `PIWI_RECORD_CHANNEL`, and
     `PIWI_EDITOR_SEND` (the app's, or the pairing an editor's file names), unless the run names its own
     (`tests/terminal-run.spec.ts`); and outside CI `PIWI_STOP_NOTES` (`internal/support/stop-notes.ts`,
     `tests/stop-text.spec.ts`);
   - the one read of each worker's first page per project, on `about:blank` before the test navigates, through
     `internalCall`, attached as `piwi-environment` (`internal/capture/browser-environment.ts`), and the two
     `GET /__piwi/environment` requests to each instrumented origin, as a test first reaches it and as the last test ends
     (`internal/collect/run-environments.ts`), unless `collectEnvironmentInfo` is off (`tests/environment-collect.spec.ts`);
   - `piwi-*` attachment names (`internal/capture/attachments.ts`), temp files in `os.tmpdir()` (the private ones
     in `%LOCALAPPDATA%\piwi\tmp` on Windows, `privateTempDir`), `[Piwi Dashboard]`-prefixed log output, the
     `::notice` lines on GitHub Actions (`ci-output.ts`), and outside CI the OSC 8 link and OSC 9;4 progress
     (`internal/support/terminal.ts`, `PIWI_TERMINAL_PROGRESS`, `tests/terminal.spec.ts`);
   - the `__piwiProbeElement` global the capture fixtures install into every instrumented page
     (`internal/capture/capture-fixtures.ts`), and the `beforeunload` listener code reach adds to each document of a
     covered page, in its own isolated world (`internal/capture/code-reach.ts`);
   - the boxed stack prefix `internal/capture/quiet-capture.ts` registers for this package's `dist/` in each worker;
   - the resource ledger's listener on each worker's Playwright (its before-close hook of a context included), its
     wrappers on the browser types and on the `sendMessageToServer` of the worker's connection and of each browser it
     connects to while that browser is connected, which only read each call (`internal/capture/resource-ledger.ts`),
     and the `clear_refs` writes and DevTools sessions of `internal/capture/worker-metrics.ts`;
   - in a worker of a run Piwi may pause that can show a view (a run connection, or a live view key outside CI), the
     listener `live-call-log.ts` adds to each context's in-process server instrumentation as it opens
     (`context._connection.toImpl(context).instrumentation`, feature-checked, absent for a connected browser), which
     only reads each call, never throws into it, and goes as the context closes (`listenCalls`); and
     while a viewer asks for the page's text, the reads of the ARIA snapshots in the runner's growing trace of the test
     (`<outputDir>/.playwright-artifacts-<workerIndex>/traces/`, `lane-layers.ts`; never its screencast images), of
     the page's ARIA snapshot through `internalCall` when asked where the trace writes none, and of the secret fields of
     every page of its context through `internalCall`;
   - the proxy every API request context is handed out behind (`internal/capture/api-requests.ts`: the `request`
     fixture's, any `playwright.request.newContext()`'s and `page.request`);
   - the editor's breakpoints (`internal/capture/pause-at.ts`, with `PIWI_PAUSE_AT` in a headed local run): the pause
     bar, `PW_CODEGEN_NO_INSPECTOR`, the wrapped `Page.prototype.pause`, the runner internals it reads
     (`_onDidFinishTestFunctionCallbacks`, `_timeoutManager.defaultSlot()`, both feature-checked), the `piwi-pauses`
     attachment and the locator posted to `PIWI_EDITOR_SEND` (`@piwitests/core/editor-send`); and a stop's highlights
     and outlines, which Piwi draws itself in its own layer of the page (`highlightAtStop`, `showStopHighlight` of
     `@piwitests/picker-dom`), never through Playwright's highlight, so the test's own highlights and screencast
     overlays stay as they were, and takes down before the test goes on;
   - with `PIWI_RECORD_CHANNEL`, **Record** handing the page to the editor's recorder
     (`internal/capture/record-handoff.ts`, framed as `@piwitests/core/ide-recorder`): this package carries the relay
     alone, the recorder's host stays in the editor service;
   - with `PIWI_RUN_CHANNEL` and `PIWI_RUN_REF`, else `PIWI_ORIGIN_REF`, each worker's run connection to the editor or
     the desktop app (`internal/capture/run-channel.ts`, framed as `@piwitests/core/run-channel`), open from the
     `piwiResources` worker fixture's setup to the worker's end, and the run's own from `onBegin` to `onEnd`
     (`internal/streaming/run-hub-link.ts`): a headless run stops too, a test is ended or held at a stop, and the
     worker answers what the editor asks (`takes` and `features` in its `run-attach`). Three limits hold: a frame
     goes to the editor service alone, never stored nor attached, its secret fields painted over, and a headed stop's
     pause bar where `page-view.ts` can paint it; trusted input plays only while that stop's view, or the lane view
     showing it, is watched; and every call's and stop's title a worker sends goes through `shownTitle`
     (`lane-layers.ts`: `hideTypedText`, `hideSecretsInText`, then `hideKnownValues` with the values the attempt knows
     as it is sent) ([each message and its test](ARCHITECTURE.md#side-effects), under **The editor's run connection**);
   - with `PIWI_LIVE_VIEW` (set in `onBegin`; outside CI, `none:<why>` for a run without one), each worker's event
     stream to the instance (`internal/capture/live-view.ts`, framed as `@piwitests/core/live-view`): opened in the
     background in a CI run, and outside CI only while the run channel shares the run (**Share live**) or, for a run no
     run channel follows, with `PIWI_SHARE_LIVE=1`, an environment variable alone, never an option. In a CI run, a
     test that fails while its project holds failing tests (`hold` on the stream) and a controller watches its worker
     in full waits at its failure, its timeout held, until the hold's length, **Let it go** or no controller watching
     (`tests/live-view-hold.spec.ts`); with the project's pause setting on too (`hold`'s `pause`), a controller's
     **Pause** on that stream stops the test at its next call through the local run's pause, until **Resume**, **End
     the test** (which fails the test there, the stopped call never running) or a hold's ends
     (`tests/live-view-pause.spec.ts`, `tests/live-view-pause-end.spec.ts`). Four limits hold:
     never a frame while nobody watches, never stored, nothing from a run outside CI unless it is shared; each frame
     goes with the page's secret fields (`SECRET_FIELD_SELECTOR`) and the project's `masks` painted over, or does not
     go (`live-mask.ts`); the key is out of the worker's `process.env` from the fixture's setup to its teardown; and
     the test gets `context.tracing` and `page.screencast` behind guards that first end Piwi's own trace or a view's
     screencast client (`guardTracing`, `guardScreencast`)
     ([what it posts, when, and its tests](ARCHITECTURE.md#side-effects), under **The instance's live view**);
   - while a full view has Inspect open, the page's DOM snapshots and the stylesheets, fonts and images they name
     (`internal/capture/live-inspect.ts`), read from the runner's trace or from a live trace of Piwi's own, stopped
     unsaved and its files deleted as Inspect closes: each snapshot goes through `hideFrameSnapshotSecrets` with the
     attempt's secrets, none for a project with masks, nor while a page's secret fields cannot be read, nor one it
     cannot read whole, and never a script, a document, an SVG nor bytes of another kind than their type
     (`tests/live-view-inspect.spec.ts`, `tests/live-inspect.spec.ts`);
   - `PIWI_RUN_CHANNEL` and `PIWI_EDITOR_SEND` taken out of the worker's `process.env` while each test runs
     (`hideRunChannel`; picks still reach the editor through `editorSendAddress`), so a process the test starts gets
     neither, and put back after it, since Playwright passes a worker's environment changes to the projects that
     depend on its project.

   How each of them works: [`ARCHITECTURE.md`](ARCHITECTURE.md#side-effects). What a stopped test sends the editor
   hides its credentials by `@piwitests/core/mask`'s rule: a region's snapshot leaves out the value of a field that
   holds a secret (`SECRET_AUTOCOMPLETE`, read through a locator, so in shadow roots too), a kept response's URL goes
   through `hideSecretsInUrl`, and a held failure's title and error through `hideSecretsInText`
   (`tests/run-channel-code.spec.ts`); the page's text, on either wire, has the value of a field named for a secret
   (on its `- text:` line under a placeholder too, its key quoted or not), of a card's number, of what the attempt's
   secret fields held and its calls typed into one, and the name and value of the project's masked elements hidden
   (`maskAriaSnapshot`, a line it cannot read hidden whole), and no text goes for a mask it cannot find (by name or
   placeholder: never `getByTitle`) nor when a page's secret fields could not be read (`tests/lane-layers.spec.ts`); for
   an agent, the value of a field that holds a secret (`SECRET_FIELDS` in
   `agent-page.ts`: a password field and `SECRET_AUTOCOMPLETE`'s) is hidden in the snapshot, plain or quoted
   (`withoutFieldSecrets`), painted over in the image as the live view's are, over the boxes Playwright measures too
   (`maskedImage`), in every frame, none of a page zoomed in, and never sent as an element's
   (`tests/agent-page.spec.ts`).
4. **The desktop discovery file.** The desktop shell writes `~/.piwi/desktop.json` (`apps/desktop/src-tauri/src/lib.rs`)
   and this package reads its `url`, `token` and `pid` (`internal/config/desktop.ts`), and for a run started in a
   terminal its `runChannel`, `send`, `projects` and `hubSince` (`readDesktopHub`, `internal/config/hub.ts`)
   ([`apps/desktop/AGENTS.md`](../../apps/desktop/AGENTS.md)). The two ship on independent
   release cycles, so a path or shape change must land in both, and a request that carries the token goes through the
   proof described in [`ARCHITECTURE.md`](ARCHITECTURE.md#the-desktop-apps-discovery-file).
5. **The capture fixtures' own build entry.** `src/internal/capture/capture-fixtures.ts` is its own entry in
   `tsup.config.ts`, so the public entry's types re-export `piwiFixtures` and `extendPiwiFixtures` from
   `dist/internal/capture/capture-fixtures.js`: renaming or moving it changes the published types. The dashboard's
   E2E suite takes those fixtures from the public entry (`apps/application/tests/fixtures.ts`), so a change to them
   runs through its suite too.
6. **Invisible capture.** Nothing the capture fixtures do may show up as the test's own. A Playwright method a wrapper
   forwards is called on its receiver (`callMethod`, never `fn.apply`, which renames the call `locator.apply`), and
   every page read the fixtures make goes through `internalCall` (never a bare `page.evaluate` / `ariaSnapshot`), so it
   is neither a step nor a trace action. The `piwiResources` worker fixture calls `boxCaptureFrames` before any hook,
   so this package's own frames name the spec's line. `tests/integration/verify-reporter.ts` checks both.
7. **The docs read this package.** Every option in `src/public/options.ts` has a JSDoc comment stating its default,
   under the `// ── Group ──` comment it belongs to: the docs build generates the Reporter options page from them and
   from `PIWI_ENV_KEYS`, and fails on an option without one. A new `piwi` flag goes into `apps/docs/reference/cli.md`
   in the same change; `apps/application/tests/unit/docs-drift.test.ts` checks every command's `USAGE` against it.

## Agent skills (`templates/skills/`)

- **The skills are public.** `piwi init`, `piwi skills add` and the desktop app write them into users' projects, and
  the dashboard serves them as MCP prompts: name nothing internal to this repository. Every MCP tool, argument, `piwi`
  command and flag a skill names must exist (`apps/application/shared/mcp-tools.ts`, `src/cli/`); no test checks them.
- **A workflow skill's `description` is mirrored.** The dashboard serves each workflow skill as an MCP prompt, and
  `apps/application/shared/mcp-prompts.ts` holds its description: change both in the same commit;
  `apps/application/tests/unit/mcp-prompts.test.ts` fails when they differ. A new skill is declared in
  `src/cli/skills.ts` (checked by `tests/skills-cli.spec.ts`) and, for a workflow skill, in `MCP_PROMPT_DEFS`.

## Conventions

- Code style (imports, dependency injection, `HttpError`, `catch` and `any`):
  [`ARCHITECTURE.md`](ARCHITECTURE.md#conventions).
- Shared pure logic (locator generation/scoring, ARIA fingerprints, wire leaf shapes) comes from **`@piwitests/core`**
  and is bundled in by tsup, so the published package stays self-contained. **Never re-implement a core function here**:
  `apps/application/tests/unit/reporter-core-identity.test.ts` asserts the reporter re-exports the exact core functions
  and fails on a copy. **Never import `apps/application/shared`** from the reporter: the path would leak into the
  published `.d.ts`.
- **A wire field is projected in one place per body**: a per-case field in `toWireTestCase` and a field of the batch
  run body in `serializeRun` (`internal/submit/serializer.ts`, used by `uploadJSON` and `uploadWithFiles`). The
  streaming routes build their own run bodies: `/setup` in `public/global-setup.ts`, `/finish` in
  `internal/submit/run-submitter.ts`, `/start` and `/begin` in `internal/streaming/stream-manager.ts`, so a run-level
  field the server reads while streaming is added there too.
- **A streaming request carries its run's token twice**: in its body and in the `RUN_TOKEN_HEADER` header
  (`runTokenHeaders`, `internal/transport/http-client.ts`), the setup token to `/begin`, the stream token to `/events`,
  `/finish` and `/live-resources`. The dashboard refuses a run of this reporter (the `reporterVersion` `/setup` and
  `/start` send, 0.65.0 and later) without the header, and an older dashboard reads the body's: drop neither.
- **A text cut before the attempt's known secrets are hidden in it is cut with `cutText`** (`@piwitests/core/mask`),
  never `.slice`: its mark makes `hideKnownValues` hide the start of a value the cut left at its end (the call log's
  title, lines and error, `shownTitle`; `tests/lane-layers.spec.ts`).
- **The attempt's known values are hidden in a text once, as it is sent, never in a text kept**: kept, a call's title
  is `keptTitle`'s, shown with `shownTitle` (`lane-layers.ts`); hidden twice, a value that holds one hidden before
  shows its rest (`tests/lane-layers.spec.ts`, `tests/live-view-worker.spec.ts`). A stop's `locator` and `error` go
  with them hidden too, so a locator that holds one is not the call's own and matches nothing on the page.
- **A view's images of its page go through Playwright's screenshot (`internalCall`), never a DevTools session of
  Piwi's own**: a scaled `Page.captureScreenshot` there resets the page's device emulation (its device scale factor,
  screen and a phone's layout) for the test to see, and runs alongside the test's own screenshots.
  `tests/page-view-still.spec.ts` checks the page sees nothing change.
- **A private temp file goes through `internal/support/private-file.ts`**: in `privateTempDir()`, never `os.tmpdir()`
  itself (on Windows, `%LOCALAPPDATA%\piwi\tmp`: a service account's `os.tmpdir()` is shared), written and read with
  `writePrivateFile`, `appendPrivateFile` and `readPrivateFile`; or it lives in a `fs.mkdtempSync` folder. Owner-only,
  its path checked before it is opened, never written through a link nor waited on as a named pipe, read back only
  when this user owns it; on Windows the owner and mode checks are no-ops and only that path check refuses a link
  (`tests/private-file.spec.ts`).
- **The resource ledger counts the contexts and pages the worker opens, and no other**: a context from the
  instrumentation's `runAfterCreateBrowserContext`, never `browser.on('context')`, which also reports those another
  client opens on a browser the worker shares (`browser.bind`, as a stop shares it with Playwright's tools); a page from
  `context.on('page')` only when it is a popup of a page the ledger counts (`opener()`), has no opener and was not
  created on `about:blank` (a modifier click's tab: its main frame's first URL, `_initializer.url`, is empty, while its
  `url()` already reads `about:blank` as it arrives on 1.59), or arrives while a `newPage` call of the worker runs
  (`onPage`, `internal/capture/resource-ledger.ts`). `tests/resource-ledger.spec.ts` checks both in a real browser, on
  the floor too (`reporter-floor`).
- **Playwright from the floor up.** The lower bound of the peer range on `@playwright/test` is the oldest Playwright
  the reporter supports: an API added after it is feature-checked, and a spec that needs it skips itself below that
  version (`playwrightAtLeast`, `tests/_helpers.ts`). CI's `reporter-floor` job runs the suite on the floor
  (`scripts/playwright-floor.mjs`), and `docs-drift.test.ts` holds the docs' stated minimum to it.
- **`preprocess` never throws, and reads `testRun` before it returns**: Playwright awaits it unguarded, so an error
  thrown there fails the run, and its `TestRun` answers only during the call (`readSuiteModes` in
  `internal/collect/metadata-collector.ts` keeps what it read; `tests/suite-modes-run.spec.ts`).
- **A shard that cannot read its pass reuse plan runs the whole suite** (`skipSharding` in `runWithoutPlan`,
  `public/reporter.ts`): Playwright splits a suite holding skipped tests apart from one without, so a shard that skipped
  none of the plan's tests would not line up with the others (`tests/preprocess-edits-run.spec.ts`).

## Workflow

From `packages/reporter/`:

```bash
npm run reporter:build      # tsup → dist/ (.js + .d.ts); reporter:dev for watch mode
npm run reporter:typecheck  # src/, then tests/ (tests/tsconfig.json)
npm run reporter:lint       # :fix to auto-fix
npm run reporter:format     # src/ only; :check to verify only
npm run reporter:test       # :watch, :coverage, :integration
                            # :integration:ai runs the AI-step authoring loop against a stubbed resolver;
                            # :integration:ai:live drives a real model through a real dashboard (spends tokens)
npm run reporter:bench      # capture-overhead benchmark; :micro for the Node-side hot path
```

`tests/bench/` measures what the capture fixtures cost a suite: see its [`README.md`](tests/bench/README.md) for the
variant ladder, the knobs, and reference numbers. Reach for it before optimizing anything under `internal/capture/`.

Source is TypeScript in `src/`; `dist/` is generated, never edit it. To try the package in a real project, build then
`npm link` here and in the target project.

Adding a field that flows from Playwright to the dashboard touches both halves: follow the ordered checklist in
[`apps/application/server/api/test-runs/AGENTS.md`](../../apps/application/server/api/test-runs/AGENTS.md#adding-a-field-to-test-run-data).
