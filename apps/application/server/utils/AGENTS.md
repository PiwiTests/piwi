# Server subsystems: agent guide

Invariants of the server subsystems whose code lives in `server/utils/` (with pieces in `shared/` and the demo): the
rules a reasonable change would otherwise break. Read [`../../AGENTS.md`](../../AGENTS.md) first. Two subsystems have a
guide of their own: [`mcp/AGENTS.md`](mcp/AGENTS.md) (MCP tools) and [`assistant/AGENTS.md`](assistant/AGENTS.md) (the
in-app assistant).

| Touching                                                                        | Section                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `server/utils/scm/`, `shared/scm-urls.ts`, any link to a commit or a repository | [SCM providers](#scm-providers--one-source-for-hosts-and-urls) |
| `shared/error-fingerprint.ts`, failure clusters                                 | [Failure clustering](#failure-clustering--fingerprints)        |
| locator snapshots, `locator-healing.ts`, `LocatorHealingPanel.vue`              | [Locator healing](#locator-healing)                            |
| trace blobs, the resource pool, `trace-*.ts`, `resource-compression.ts`         | the four Trace sections                                        |
| `dom-snapshot-render.ts`, `shared/snapshot-picker-extras.ts`                    | [DOM snapshot live state](#dom-snapshot-live-state)            |

## SCM providers — one source for hosts and URLs

Provider hosts and web URLs live only in `shared/scm-urls.ts` (`detectScmHost`, `commitUrl`, `compareUrl`,
`fileUrl`, `branchUrl`); provider API calls live only in `server/utils/scm/`. Anything that needs a provider gets it
from `createScmProvider` / `scmProviderForUrl` (or the pure link helpers from `#shared/scm-urls`) — never a hand-written
`github.com` / `gitlab` / `bitbucket.org` host switch or a re-implemented `/commit/<sha>` path. Import the
`ScmProviderName` union from `#shared/scm-urls`; never re-declare `'github' | 'gitlab' | 'bitbucket'`.
`tests/unit/scm-single-source.test.ts` scans `server`, `shared`, `app` and `types` for provider host literals and the
union outside an explicit allow-list, so a new home for either is a visible diff to that list.

**A token reads only the project's pinned repository.** `projects.repository_url` (`server/utils/scm/project-repository.ts`)
is set by the first run that names a remote and changed by a project admin; `createScmProvider(url, db, projectId)`
returns no provider when `url` (usually a run's `scm.remoteUrl`) names another. Never pair `scmProviderForUrl` with a
token for a URL that came from run metadata or a user's link without checking it against the pinned repository
(`projectRepositoryFor`, or `isRepositoryPinnedInScope` for a link).

On the desktop app with no SCM token, `createScmProvider` returns a `LocalGitProvider` (`server/utils/scm/local-git.ts`)
for a project linked to a clone of the repository: it reads history with git in that folder and wraps the host's own
provider for the rest. A method added to `ScmProvider` must be added there too — a read tries git first and falls back
to the host, anything else is passed to the host. The base class's no-op defaults compile without it, and would
silently turn the feature off on the desktop app.

## Failure clustering & fingerprints

The grouping key is `computeErrorFingerprint` (`shared/error-fingerprint.ts`) over error type + normalized message +
masked locator. **The stack frame is intentionally NOT hashed** (kept as `topFrameFile` for display) so one root cause
groups across spec files. Add volatile-token masking inside `maskVolatile` (message) / `maskSelector` (locator).

When you change normalization, **bump `FINGERPRINT_VERSION`** and keep the demo mirror
`shared/demo/demo-fingerprint.mjs#computeDemoFingerprint` in sync — a regex-for-regex plain-Node port that exists
because the seed script runs under plain Node and cannot resolve the TypeScript module. A version bump is
**non-destructive**: `reclusterFailureFingerprints()` re-fingerprints existing clusters from their stored `sampleError`
on startup, updating in place or merging collisions via `mergeFailureClusters()`, so triage state survives.
Re-run `npm run app:seed:demo` afterwards.

## Locator healing

Ranked replacement locators for a broken selector. Pure generation/scoring/fingerprint logic lives in
`@piwitests/core` (`locator-generation`, `locator-fingerprint`, `locator-healing-types`), re-exported by the `shared/*`
shims for `#shared/...` and bundled into the reporter by tsup. **There is no hand-mirrored copy** —
`tests/unit/reporter-core-identity.test.ts` asserts the reporter re-exports the exact core functions, so a
re-implementation fails the suite.

Rules when touching it:

- **Capture** happens in the reporter fixtures (mirrored by the dogfood `tests/fixtures.ts`). The in-page probe
  `probeElementAttrs` is serialized into the browser via `evaluate`, so it cannot reference module closures: the ARIA
  role maps (`TAG_TO_ROLE` / `INPUT_TYPE_TO_ROLE`) arrive as fields of the `evaluate` argument — **do not re-declare
  them inside the probe**, and have the dogfood fixture import and call it rather than re-inlining.
- The live input `value` is **deliberately never captured** (secret leak).
- Snapshots ride the wire as the transient per-case `locatorSnapshots` field (`shared/types.ts`, **never a column**);
  every ingest site passes it to `persistRunCases` → the shared `upsertLocatorSnapshots` (`server/utils/locator-healing.ts`,
  used by server **and** demo). **Two invariants live in that helper:** rows are deduped by `(caseId, location)` before
  the batch upsert (a repeated call site otherwise breaks PostgreSQL's `ON CONFLICT DO UPDATE`), and the stale-location
  purge runs **only for cases whose run passed**, so a run that failed early does not delete valid prior-success rows.
- `elementAttrs` inside `upsertLocatorSnapshots` is the **storage whitelist** — a new wire field on
  `LocatorSnapshot.element` (e.g. `rolePosition`, `ancestors`) must be folded in there or it is silently dropped.
  No migration needed.
- Chained alternatives carry the **leaf** method with flat args (`anchorTestId` / `anchorSelector` / `anchorRole`) and
  **never a `name` key** — `fingerprintFromSnapshot` reads the element name from the first `getByRole` alternative's args.
- The signature must hash identically on both sides: capture via `locatorSignature(method, args)`, look up via
  `locatorSignatureFromExpression(expr)` (`shared/locator-healing.ts`).
- **Stale gating:** when the stored fingerprint's name is provably gone from the failing ARIA, `resolveStoredHit` sets
  `priorNameMayBeStale` and excludes the failing locator and old-name-derived alternatives from the recommendation pool
  (an empty pool yields `recommendation: null` — never a stale pick). `LocatorHealingPanel.vue` MUST NOT recompute a
  client-side recommendation when that flag is set; it would resurrect the stale pick.
- Dashboard picks persist via the shared `saveLocatorPick`: the failing locator's identity is re-derived **server-side**
  from the stored error with the same helpers the lookup ladder uses — never trust client-parsed args. A pick that
  cannot be keyed returns `not-persisted` (surfaced as a toast) rather than being silently dropped. Anyone who can read
  the project may save one, so the endpoint declares `project:read`.
- Re-run `npm run app:seed:demo` after changing the captured or stored shape.

## Trace storage compression

Trace evidence is compressed at rest, transparently. Two rules keep it that way:

- The shared resource pool (`project-<id>/trace-resources/`) stores text resources gzip-wrapped in a
  self-describing container (see `server/utils/resource-compression.ts`). **Every read of a pool resource
  MUST pass the bytes through `decodeResource`** — reconstruction, evidence, DOM-snapshot inlining all
  do. Add a new pool reader and you add a `decodeResource` call, or you serve compressed bytes as if they
  were raw. `compressResource` is the only writer; `trace_resources.size` is the on-disk (post-compression)
  byte count. There is no encoding column — the container's magic prefix is the source of truth, so a
  resource that is itself gzip (Playwright can store one) is never double-decoded.
- The persisted slim events blob is built with `buildZip(entries, { compress: true })`; reconstruction
  rebuilds the served ZIP stored (uncompressed) for speed. `buildZip` defaults to stored — pass
  `{ compress: true }` only for the write-once-keep path, never for archives rebuilt on every open.

## Trace pooled entries

Besides `resources/`, ingestion moves a trace's per-action screenshots (`screenshots/`) and screencast frames
(`screencast/`) to the shared pool, under the SHA-1 of their bytes (`<sha1>.png`): their names say which action or
instant they belong to, not what they hold, and many are byte-identical. The blob's manifest maps each such entry
name to its pool name (`pooledEntries`, see `server/utils/trace-manifest.ts`); the aria snapshots stay in the slim
ZIP. A blob whose manifest has no `pooledEntries` holds its screenshots and frames inline; blobs are never rewritten.

- **Every manifest read goes through `server/utils/trace-manifest.ts`** (`readTraceManifest` for a view,
  `parseTraceManifest` + `traceManifestPoolNames` for anything that decides what may be deleted, which must tell a
  missing manifest from an unreadable one).
- **A reader of a `screenshots/` or `screencast/` entry looks in the slim ZIP first, then in the pool through
  `pooledEntries`**, as `readSnapshot` in `trace-evidence.ts` and `reconstructTraceZip` do. Reading only the ZIP
  finds nothing for a blob stored since pooling.

## Trace resource refcounting

Shared pool resources are reference-counted through `trace_blob_resources` (blob ↔ resource), so a partial
delete frees a resource the moment no surviving blob references it (`gcTraceBlobs`), not only when the
project loses its last blob. Two invariants keep it correct:

- **Any blob write MUST record its resource links and then set `trace_blobs.resources_indexed = true`, in
  that order.** The links cover every pool name the manifest references, `resources` and `pooledEntries`
  alike (`traceManifestPoolNames`). `upsertTraceBlob` does this via `linkBlobResources`; the flag flips only
  after the links exist, so a half-written blob is never trusted. A new blob-writing path must do the same, or
  resources it needs can be reclaimed out from under it.
- **Any blob write MUST set `trace_blobs.stored_size`** — the bytes of the blob's own files (slim ZIP plus
  manifest, or the whole ZIP stored as is), which the storage analysis counts. `size` stays the uploaded
  trace's size, shown to users; counting it would count the pooled parts twice. `backfillTraceBlobStoredSizes`
  (startup, after the link backfill) measures every blob whose `stored_size` is null.
- **Per-resource GC only runs for a project whose blobs are all indexed.** Deletes on a project with any
  `resources_indexed = false` blob fall back to the whole-project rule (resources go only when the last blob
  does), because such a blob's links may be missing. `backfillTraceBlobResources` (kicked off at startup
  from `initDatabase`, non-blocking) indexes pre-existing blobs from their manifests; the nightly
  `reclaimOrphanTraceResources` sweeps resources nothing references any more, same gate.

## Reading a stored trace

A view that reads a stored trace goes through `server/utils/trace-evidence.ts` (its `getTrace*FromBlob` views and
`loadStoredTraceEvents`), never `parseZip` on the blob. The slim blob of a Playwright 1.63 trace holds its aria
snapshots (and, when its manifest has no `pooledEntries`, its screenshots and screencast); the loader inflates only the
`.trace`, `.stacks` and `.network` streams, one snapshot entry when a view asks for it (from the pool when the
manifest lists it in `pooledEntries`), and never the screencast. A content-addressed blob
(`project-<id>/blobs/<sha256>.zip`) is loaded once for the requests of one page and kept two minutes after its last
read, within 64 MB for all loaded traces, so a bundle keeps compressed copies of the entries it needs and no closure
over the archive itself. Ingestion reads a trace once and does not go through that cache. A new view adds a function
there; an answer that is a pure function of the trace and costly to build is kept on the loaded bundle, as
`snapshotView` is.

## DOM snapshot live state

The DOM view renders a trace snapshot with the live state Playwright records beside the DOM (`__playwright_*`
attributes; `template` nodes for shadow roots and adopted stylesheets), the same from Playwright 1.60 on.

- **Markup, or a marker the frame applies.** `renderedAttributes` (`server/utils/dom-snapshot-render.ts`) writes what
  markup can hold and turns the rest into `data-piwi-*` markers that `restoreSnapshotState`
  (`shared/snapshot-picker-extras.ts`) applies in the frame. The script is serialized, so both name each marker: a new
  one lands in both, and in `tests/dom-snapshot-state.spec.ts`.
- **A password field's value is always masked** (`PASSWORD_MASK`); every other field value is shown.
- **`restoreSnapshotState` runs first in every frame document** (picker and read-only), before anything installs over
  the page, and moves no keyboard focus out of the dashboard.
- **The reporter's focus, hover and selection apply to the failure-time snapshot only** (`atFailure`,
  `withPageInteraction`): they were read at test end. Their element paths are the format of
  `@piwitests/core/page-interaction`, written by the reporter's `readPageInteraction` and read by the frame script.
- **A trace format change is checked against recorded traces**: `scripts/record-live-state-traces.mjs` records the
  E2E fixtures with any Playwright version; keep 1.60 and the latest.
