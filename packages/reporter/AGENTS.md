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
   - `PIWI_*` env vars (`internal/config/env.ts`; `PIWI_DASHBOARD_URL`, `PIWI_API_KEY` and `PIWI_PROJECT_NAME` also from
     the `.env` in the Playwright config's folder, below the environment), and the ones `onBegin` sets for the
     workers;
   - `piwi-*` attachment names (`internal/capture/attachments.ts`), temp files in `os.tmpdir()`, and
     `[Piwi Dashboard]`-prefixed log output;
   - the `__piwiProbeElement` global the capture fixtures install into every instrumented page
     (`internal/capture/capture-fixtures.ts`), and the `beforeunload` listener code reach adds to each document of a
     covered page, in its own isolated world (`internal/capture/code-reach.ts`);
   - the boxed stack prefix `internal/capture/quiet-capture.ts` registers for this package's `dist/` in each worker;
   - the resource ledger's listener on each worker's Playwright and its wrappers on the browser types
     (`internal/capture/resource-ledger.ts`), and the `clear_refs` writes and DevTools sessions of
     `internal/capture/worker-metrics.ts`;
   - the proxy every API request context is handed out behind (`internal/capture/api-requests.ts`: the `request`
     fixture's, any `playwright.request.newContext()`'s and `page.request`);
   - the editor's breakpoints (`internal/capture/pause-at.ts`, with `PIWI_PAUSE_AT` in a headed local run): the pause
     bar, `PW_CODEGEN_NO_INSPECTOR`, the wrapped `Page.prototype.pause`, the runner internals it reads
     (`_onDidFinishTestFunctionCallbacks`, `_timeoutManager.defaultSlot()`, both feature-checked), the `piwi-pauses`
     attachment and the locator posted to `PIWI_EDITOR_SEND` (`@piwitests/core/editor-send`);
   - with `PIWI_RECORD_CHANNEL`, **Record here** handing the page to the editor's recorder
     (`internal/capture/record-handoff.ts`, framed as `@piwitests/core/ide-recorder`): this package carries the relay
     alone, the recorder's host stays in the editor service;
   - with `PIWI_RUN_CHANNEL` and `PIWI_ORIGIN_REF`, each worker's run connection to the editor
     (`internal/capture/run-channel.ts`, framed as `@piwitests/core/run-channel`), open from the `piwiResources`
     worker fixture's setup to the worker's end: it reports each test and stop, takes the editor's controls,
     breakpoints, intents and queries (`takes` in its `run-attach`), keeps the test's text responses in memory for
     Mock a request (`kept-responses.ts`), holds a failing test's page for an editor that answered its `holds` with
     `attached` (`holdFailure`, `editorShows`), and makes a headless run stop too; for a viewer outside the page, it
     streams a stopped page's screencast (`view`), plays trusted input there only while that stop's view is watched
     (`input`, let go before the test goes on), runs the bar's actions in a headless page through it (`viewHere`), and
     picks under a point of an image (`pick-at.ts`); a frame goes to the editor service alone, never stored nor attached,
     the latest one sent kept in memory until the view ends, for a viewer that comes later
     (`tests/run-channel-view.spec.ts`);
   - `PIWI_RUN_CHANNEL` and `PIWI_EDITOR_SEND` taken out of the worker's `process.env` while each test runs
     (`hideRunChannel`; picks still reach the editor through `editorSendAddress`), so a process the test starts gets
     neither, and put back after it, since Playwright passes a worker's environment changes to the projects that
     depend on its project.

   How each of them works: [`ARCHITECTURE.md`](ARCHITECTURE.md#side-effects). What a stopped test sends the editor
   hides its credentials by `@piwitests/core/mask`'s rule: a region's snapshot leaves out the value of a field that
   holds a secret (`SECRET_AUTOCOMPLETE`, read through a locator, so in shadow roots too), a kept response's URL goes
   through `hideSecretsInUrl`, and a held failure's title and error through `hideSecretsInText`
   (`tests/run-channel-code.spec.ts`).
4. **The desktop discovery file.** The desktop shell writes `~/.piwi/desktop.json` (`apps/desktop/src-tauri/src/lib.rs`)
   and this package reads its `url`, `token` and `pid` (`internal/config/desktop.ts`); the shell also writes
   `projects` for other readers ([`apps/desktop/AGENTS.md`](../../apps/desktop/AGENTS.md)). The two ship on independent
   release cycles, so a path or shape change must land in both.
5. **The dogfooded capture modules.** The dashboard's E2E fixtures (`apps/application/tests/fixtures.ts`) import five
   capture modules from `dist/internal/capture/`, each its own entry in `tsup.config.ts`. Renaming or moving one, or
   changing what it exports, breaks the dashboard's suite.
6. **Invisible capture.** Nothing the capture fixtures do may show up as the test's own. A Playwright method a wrapper
   forwards is called on its receiver (`callMethod`, never `fn.apply`, which renames the call `locator.apply`), and
   every page read the fixtures make goes through `internalCall` (never a bare `page.evaluate` / `ariaSnapshot`), so it
   is neither a step nor a trace action. A copy that wraps locators from its own file (the dogfood mirror,
   `apps/application/tests/fixtures.ts`) passes that file to `boxCaptureFrames` so its frames are boxed too. `tests/integration/verify-reporter.ts` checks both.
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
