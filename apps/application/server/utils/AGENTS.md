# Server subsystems: agent guide

Invariants of the server subsystems whose code lives in `server/utils/` (with pieces in `shared/` and the demo): the
rules a reasonable change would otherwise break. Read [`../../AGENTS.md`](../../AGENTS.md) first. Two subsystems have a
guide of their own: [`mcp/AGENTS.md`](mcp/AGENTS.md) (MCP tools) and [`assistant/AGENTS.md`](assistant/AGENTS.md) (the
in-app assistant).

| Touching                                                                         | Section                                             |
| -------------------------------------------------------------------------------- | --------------------------------------------------- |
| `server/utils/scm/`, `shared/scm-urls.ts`, any link to a commit or a repository  | [SCM providers](#scm-providers)                     |
| `shared/error-fingerprint.ts`, failure clusters                                  | [Failure fingerprints](#failure-fingerprints)       |
| locator snapshots, `locator-healing.ts`, `LocatorHealingPanel.vue`               | [Locator healing](#locator-healing)                 |
| trace blobs, the resource pool, `trace-*.ts`, `resource-compression.ts`          | [Trace storage](#trace-storage)                     |
| `dom-snapshot-render.ts`, `shared/snapshot-picker-extras.ts`                     | [DOM snapshot live state](#dom-snapshot-live-state) |
| `ai-claude-cli.ts`, `ai-codex-cli.ts`, `ai-deepseek-cli.ts`, `ai-cli-process.ts` | [AI CLI providers](#ai-cli-providers)               |
| `ai-context*.ts`, `integrations/automation.ts`                                   | [Wiring rules](#wiring-rules)                       |
| `desktop-runs.ts`, `shared/desktop-runs.ts`, the `/api/desktop/run*` routes      | [Desktop runs](#desktop-runs)                       |

## SCM providers

- **Provider hosts and web URLs live only in `shared/scm-urls.ts`** (`detectScmHost`, `commitUrl`, `compareUrl`,
  `fileUrl`, `branchUrl`), and provider API calls only in `server/utils/scm/`. Get a provider from
  `createScmProvider` or `scmProviderForUrl` (a link from the helpers of `#shared/scm-urls`), and import the
  `ScmProviderName` union from there: never a hand-written `github.com` / `gitlab` / `bitbucket.org` host switch, a
  re-implemented `/commit/<sha>` path or a re-declared `'github' | 'gitlab' | 'bitbucket'`.
  `tests/unit/scm-single-source.test.ts` scans `server`, `shared`, `app` and `types` for host literals and the union,
  so a new home for either is a visible change to its allow-list.
- **A token reads only the project's pinned repository.** `projects.repository_url`
  (`server/utils/scm/project-repository.ts`) is set by the first run that names a remote and changed by a project
  admin; `createScmProvider(url, db, projectId)` returns no provider when `url` (usually a run's `scm.remoteUrl`) names
  another. Never pair `scmProviderForUrl` with a token for a URL from run metadata or a user's link without checking it
  against the pinned repository (`projectRepositoryFor`, or `isRepositoryPinnedInScope` for a link).
- **Run metadata never chooses the host a token goes to.** `scmProviderForUrl` calls GitHub and Bitbucket on their own
  API hosts, and GitLab only on `gitlab.com` or a host listed in `PIWI_SCM_GITLAB_HOSTS`
  (`tests/unit/scm-token-host.test.ts`).
- **A method added to `ScmProvider` is added to `LocalGitProvider` too** (`server/utils/scm/local-git.ts`). On the
  desktop app with no SCM token, `createScmProvider` returns it for a project linked to a clone: it reads history with
  git in that folder and wraps the host's provider for the rest. A read tries git first and falls back to the host;
  anything else is passed to the host. Without the override, the base class's no-op default compiles and silently
  turns the feature off on the desktop app.

## Failure fingerprints

- **The grouping key is `computeErrorFingerprint`** (`shared/error-fingerprint.ts`): a hash of the error type, the
  normalized message and the masked locator, from `extractErrorSignature` (`@piwitests/core/error-signature`, shared
  with the reporter's flake mode). **The top stack frame is not hashed** (it is kept as `topFrameFile` for display), so
  one root cause reached from several spec files groups into one cluster. A new volatile token is masked in
  `maskVolatile` (message) or `maskSelector` (locator), both in `packages/core/src/error-signature.ts`.
- **A normalization change bumps `FINGERPRINT_VERSION`** and makes the same change to
  `shared/demo/demo-fingerprint.mjs#computeDemoFingerprint`, regex for regex: the seed generator runs under plain Node,
  which cannot load the TypeScript module, and `tests/unit/demo-seed-consistency.test.ts` compares the two. Then run
  `npm run app:seed:demo`.
- **A version bump keeps triage state.** At startup, `reclusterFailureFingerprints()`
  (`shared/handlers/failure-cluster-recluster.ts`) computes each cluster's fingerprint again from its stored
  `fingerprintSample` (`sampleError` for older rows), and updates it in place or merges it into the cluster it now
  matches (`mergeFailureClusters()`).

## Locator healing

Ranked replacement locators for a broken selector. Generation, scoring and fingerprints live in `@piwitests/core`
(`locator-generation`, `locator-fingerprint`, `locator-healing-types`), reached through the `shared/*` shims and
bundled into the reporter by tsup. **There is no hand-mirrored copy**: `tests/unit/reporter-core-identity.test.ts`
asserts the reporter re-exports the exact core functions, so a re-implementation fails the suite.

- **The in-page probe cannot reference module closures.** The reporter fixtures capture locators (mirrored by the
  dogfood `tests/fixtures.ts`) with `probeElementAttrs` (`packages/picker-dom/src/probe.ts`), which `evaluate`
  serializes into the browser. The ARIA role maps (`TAG_TO_ROLE`, `INPUT_TYPE_TO_ROLE`) reach it as `tagRoles` and
  `inputRoles` of its argument: **never declare them again inside the probe**, and have the dogfood fixture import and
  call it rather than copy it.
- **The live input `value` is never captured**: it can hold a secret.
- **Snapshots ride the wire as the per-case `locatorSnapshots` field** (`shared/types.ts`), **never a column**. Every
  ingest site passes it to `persistRunCases`, which calls the shared `upsertLocatorSnapshots`
  (`server/utils/locator-healing.ts`, used by the server **and** the demo). **That helper holds two invariants:** rows
  are deduplicated by `(caseId, location)` before the batch upsert (a repeated call site otherwise breaks
  PostgreSQL's `ON CONFLICT DO UPDATE`), and stale locations are purged **only for cases whose run passed**, so a run
  that failed early does not delete valid rows from an earlier success.
- **`elementAttrs` inside `upsertLocatorSnapshots` is the storage whitelist.** A new wire field of
  `LocatorSnapshot.element` (as `rolePosition` and `ancestors` were) must be added there, or it is silently dropped.
  No migration is needed.
- **A chained alternative carries the leaf method with flat arguments** (`anchorTestId`, `anchorSelector`,
  `anchorRole`) and **never a `name` key**: `fingerprintFromSnapshot` reads the element's name from the first
  `getByRole` alternative's arguments.
- **The signature hashes the same on both sides**: `locatorSignature(method, args)` at capture,
  `locatorSignatureFromExpression(expr)` at lookup (`shared/locator-healing.ts`).
- **Stale gating:** when the stored fingerprint's name is provably gone from the failing ARIA snapshot,
  `resolveStoredHit` sets `priorNameMayBeStale` and leaves the failing locator and the alternatives derived from the
  old name out of the recommendation pool (an empty pool gives `recommendation: null`, never a stale pick).
  `LocatorHealingPanel.vue` MUST NOT compute a recommendation of its own when that flag is set: it would bring the
  stale pick back.
- **A pick from the dashboard is keyed on the server.** The shared `saveLocatorPick` derives the failing locator's
  identity again from the stored error, with the helpers of the lookup, and never trusts arguments the client parsed.
  A pick it cannot key returns `not-persisted` (shown as a toast) rather than being silently dropped. Anyone who can
  read the project may save one, so the endpoint declares `project:read`.
- Run `npm run app:seed:demo` after changing the captured or stored shape.

## Trace storage

Ingestion stores a trace as a slim blob (`project-<id>/blobs/<sha256>.zip`, with a manifest) and moves its resources
to a shared pool per project (`project-<id>/trace-resources/`).

### Compression

- **Every read of a pool resource passes the bytes through `decodeResource`** (`server/utils/resource-compression.ts`),
  as reconstruction, evidence and DOM-snapshot inlining do. The pool stores text resources gzip-wrapped in a container
  marked by a magic prefix (there is no encoding column, so a resource that is itself gzip is never decoded twice), and
  `compressResource` is its only writer. A reader without `decodeResource` serves compressed bytes as if they were raw.
  `trace_resources.size` counts the bytes on disk, after compression.
- **Pass `{ compress: true }` to `buildZip` only for an archive written once and kept**, as the slim events blob is.
  An archive rebuilt on every open (the served ZIP of reconstruction) stays stored, uncompressed, for speed;
  `buildZip` defaults to stored.

### Pooled entries

Besides `resources/`, ingestion moves a trace's per-action screenshots (`screenshots/`) and screencast frames
(`screencast/`) to the pool, under the SHA-1 of their bytes (`<sha1>.png`), and the manifest maps each entry name to
its pool name (`pooledEntries`). The ARIA snapshots stay in the slim ZIP. A blob whose manifest has no `pooledEntries`
holds its screenshots and frames inline: blobs are never rewritten.

- **Every manifest read goes through `server/utils/trace-manifest.ts`**: `readTraceManifest` for a view,
  `parseTraceManifest` and `traceManifestPoolNames` for anything that decides what may be deleted, which must tell a
  missing manifest from an unreadable one.
- **A reader of a `screenshots/` or `screencast/` entry looks in the slim ZIP first, then in the pool through
  `pooledEntries`**, as `readSnapshot` in `trace-evidence.ts` and `reconstructTraceZip` do. Reading only the ZIP finds
  nothing for a blob stored since pooling.

### Resource reference counting

Pool resources are reference-counted through `trace_blob_resources` (blob to resource), so a partial delete frees a
resource as soon as no remaining blob references it (`gcTraceBlobs`), not only when the project loses its last blob.

- **Any blob write MUST record its resource links, then set `trace_blobs.resources_indexed = true`, in that order.**
  The links cover every pool name the manifest references, `resources` and `pooledEntries` alike
  (`traceManifestPoolNames`). `upsertTraceBlob` does this through `linkBlobResources`; the flag flips only after the
  links exist, so a half-written blob is never trusted. A new path that writes blobs must do the same, or the
  resources it needs can be deleted under it.
- **Any blob write MUST set `trace_blobs.stored_size`**: the bytes of the blob's own files (slim ZIP and manifest, or
  the whole ZIP stored as is), which the storage analysis counts. `size` stays the uploaded trace's size, shown to
  users; counting it would count the pooled parts twice. `backfillTraceBlobStoredSizes` (at startup, after the link
  backfill) measures every blob whose `stored_size` is null.
- **Per-resource deletion runs only for a project whose blobs are all indexed.** On a project with any blob at
  `resources_indexed = false`, a delete falls back to the whole-project rule (resources go only with the last blob),
  because that blob's links may be missing. `backfillTraceBlobResources` (started at startup by `initDatabase`,
  `server/database/index.ts`, without blocking it) indexes older blobs from their manifests; the nightly
  `reclaimOrphanTraceResources` removes the resources nothing references any more, under the same condition.

### Reading a stored trace

- **A view reads a stored trace through `server/utils/trace-evidence.ts`** (its `getTrace*FromBlob` functions and
  `loadStoredTraceEvents`), never with `parseZip` on the blob: the loader inflates only what a view asks for and shares
  one loaded trace between the requests of a page. A new view adds a function there. An answer that is a pure function
  of the trace and costly to build is kept on the loaded bundle, as `snapshotView` is. Ingestion reads a trace once,
  outside that cache.

## DOM snapshot live state

The DOM view renders a trace snapshot with the live state Playwright records beside the DOM (`__playwright_*`
attributes; `template` nodes for shadow roots and adopted stylesheets), the same from Playwright 1.60 on.

- **What markup can hold is written as markup, the rest as a marker the frame applies.** `renderedAttributes`
  (`server/utils/dom-snapshot-render.ts`) turns the rest into `data-piwi-*` markers that `restoreSnapshotState`
  (`shared/snapshot-picker-extras.ts`) applies in the frame. That script is serialized, so both name each marker: a
  new marker goes in both, and in `tests/dom-snapshot-state.spec.ts`.
- **A password field's value is always masked** (`PASSWORD_MASK`); every other field value is shown.
- **`restoreSnapshotState` runs first in every frame document** (picker and read-only), before anything installs over
  the page, and moves no keyboard focus out of the dashboard.
- **The reporter's focus, hover and selection apply to the failure-time snapshot only** (`atFailure`,
  `withPageInteraction`): they were read at test end. Their element paths use the format of
  `@piwitests/core/page-interaction`, written by the reporter's `readPageInteraction` and read by the frame script.
- **A trace format change is checked against recorded traces**: `scripts/record-live-state-traces.mjs` records the
  E2E fixtures with any Playwright version; keep 1.60 and the latest.

## AI CLI providers

A local AI CLI (Claude Code, Codex, DeepSeek) can be a role's provider. The prompt it gets holds test data (an error
message, a page's text), which must never make it run a command, read a file or reach a service.

- **Claude Code generates with every tool off**: `--tools ""`, no MCP server (`--strict-mcp-config`) and one turn
  (`--max-turns 1`). Only `--tools` and `--strict-mcp-config` are probed in `claude --help` (`REQUIRED_FLAGS`,
  `ai-claude-cli.ts`): a CLI without them is refused; `--max-turns` is a print-mode option `--help` does not list. An
  assistant turn adds only the turn's MCP endpoint (in an `--mcp-config` file, so its token stays off the command line)
  and its tools.
- **Codex runs isolated** (`ai-codex-cli.ts`): every invocation has a private home and working directory, a file-backed
  ChatGPT login snapshot, an allowlisted environment (`codexCliEnv`), disabled feature flags and model metadata with no
  built-in execution or filesystem tools. An assistant turn configures only its `piwi` MCP server and allowed tools.
  Never import the user's Codex config, tools, plugins, skills, unrelated credentials or API keys into it.
- **The official DeepSeek CLI runs a generated profile with no inherited bundles** (`ai-deepseek-cli.ts`): an explicit
  roster of official model and agent plugins and, for an assistant turn, only the turn's Piwi MCP client. No built-in
  shell, filesystem, web, skill or plugin-management tools are mounted. Copy only the selected DeepSeek account grant or
  API key; never import user profiles, unrelated credential records or endpoint overrides.
- `tests/unit/ai-claude-cli.test.ts`, `tests/unit/ai-codex-cli.test.ts` and `tests/unit/ai-deepseek-cli.test.ts` check
  the options and the isolation.

## Wiring rules

- **A computed AI-context section changes three places in one batch**: the `SectionId` union (`ai-context.types.ts`),
  `DIAGNOSIS_SECTIONS` (`shared/diagnosis-sections.ts`) and `DiagnosisContextCoverage` (`types/api.ts`), before the section's
  builder is written. The files of the other subsystems: [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md#extension-points).
- **Issue automation decides from `shared/integrations/automation.ts` alone**: the run trigger
  (`server/utils/integrations/automation.ts`) and the write-back scope (`policies.ts`, `tracker-run.ts`) read the rules
  through its functions, never re-implement them.

## Desktop runs

The desktop build's server is the hub of the Playwright runs its shell starts (`desktop-runs.ts`, opened by
`server/plugins/desktop-runs.ts` only with `PIWI_DESKTOP_TOKEN`). Its rules are the editor service's, whose classes it
runs (`@piwitests/editor/run-host`), plus these:

- **Never a copy of the run control.** The run channel, the sessions, the hub, the code from a stop and the run's lines
  are `RecordChannel`, `RunSessions`, `RunHub`, `StopActions` and `RunLines`; this server only wires their callbacks.
  What the desktop needs that they lack is an option of theirs (`declines`, `host`, `token`, `words`, `RunHub.join`),
  added in `packages/editor` with its tests there. `tests/unit/desktop-runs.test.ts` and `desktop-runs-run.test.ts`
  (a real run through the built reporter) drive the wiring.
- **The hub takes the desktop token in `hello`, and nothing else opens without it.** Its WebSocket keeps the editor's
  `Host`, extension `Origin`, limits and closed command set; the window reaches the same hub as a joined peer through
  `/api/desktop/runs/*`, behind the desktop guard. None of the routes is an open route (`isOpenDesktopRoute`).
- **The window's stream counts what the window has not read.** `runs/events.get.ts` writes to the response itself, its
  sink's `buffered()` being `res.writableLength`, so a frame waits past 1 MB unread and the stream is cut past 32 MB, as
  the hub does with a WebSocket; a `ReadableStream` handed to h3 counts nothing (`desktop-runs-events.test.ts`).
- **The run channel goes to the shell alone.** `GET /api/desktop/run-channel` refuses a request a browser sends
  (`isBrowserRequest`); `GET /api/desktop/live` names the hub to Piwi Picker, never the channel.
- **Code from a stop goes to the window, never over the hub.** `StopActions` keeps it for the window's stream
  (`stop-code`); the hub's peers hear only its sentence (`code`). It is made only for a file of a linked folder, from
  its disk text, and refused once the file was written since the run's first worker connected.
- **Pick and Record in the test's window, and Assert, are declined**: they end in an editor (its Send to editor pairing,
  its recorder), which this server has none of. A failure no pause bar shows is held only in a run a window `show`s (its
  **Hold failures** switch is on), or while Piwi Picker `follow`s the runs, and never in a run nobody attends: its ref
  ends in `-unattended` (`isUnattendedDesktopRun`, `holdsFailures`), as the shell names a Flake Lab, a bisect, a lab
  job, and a run with `--repeat-each` above 1 or `--ui`.
- **A run's picks come back to this server, with a token for that route alone.** The run channel's route also names
  `POST /api/desktop/runs/picks` with the picks token (`picksAddress`, `desktopPicksToken`), never the desktop token,
  which the shell gives each run as `PIWI_EDITOR_SEND`: the pause bar's pick and a pick on the image reach the window to
  copy (`pick`), and a pick on the image answers that it goes there (`DesktopRunSessions`). The guard takes that token
  on that route alone (`presentsDesktopPicksToken`).
