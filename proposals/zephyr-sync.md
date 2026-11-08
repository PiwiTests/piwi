# Test management sync, Zephyr Scale first

A proposal to send the results of a Playwright run to a test management tool as one test run per finished CI run, so
QA reads automation results where they read manual ones and every result links back to its evidence in Piwi. The
layer is provider-neutral; Zephyr Scale Cloud, the Jira test management app, is the first provider. It builds on the
integration layer of [issue-tracker-integrations.md](issue-tracker-integrations.md) and on the external IDs of
[external-test-ids.md](external-test-ids.md). Discussed on
[PiwiTests/piwi#1161](https://github.com/PiwiTests/piwi/issues/1161).

**Status.** Rollout step 1 built: the outbox runs each action through the binding and the client of its integration
kind (`ACTION_INTEGRATION_KINDS`, `boundConnectionId(db, projectId, kind)`); the registry has its `endpoint` and
`select` fields; the connection create and edit routes derive a regional provider's host, and the pre-save check runs
each provider's own (`connectionBaseUrl`, `CONNECTION_CHECKS`); and the provider-neutral `IntegrationHttpError`
carries a `Retry-After` (seconds or an HTTP date, capped at one hour) that sets the next attempt. A 429 pauses the
connection for that wait, or a minute without one: no attempt calls it before then, and its pending actions are moved
to that moment. Steps 2 to 7 remain. Revised after the review on #1161: provider dispatch in the outbox and the
connection endpoints, a provider-neutral interface and tables, one binding table per integration kind, and a warning
when tags are cut. Revised again after the second review: an upload marker so a reclaimed outbox row never uploads
twice, the tag-key helper in the app's `shared/`, the demo built with each rollout step, `tagsTruncated` through the
run-data checklist, a `zephyr-scale` link provider, and the remedy for cut tags matched to Playwright's tag order.
Revised a third time: the cycle key is committed as soon as the upload returns, so a failed link step retries without
a person, and *Sync again* is spelled out for a `findRun` that finds nothing.

**Summary.** A test declares the test cases it covers with a Playwright tag (`@SHOP-T123`), which the reporter already
sends, or with its external ID. When a CI run on a branch in scope has finished, Piwi collapses its executions to one
result per test case and hands them to the project's test management provider in **one** outbox action. For Zephyr
Scale that is one upload, which creates the test cycle and every execution at once, and one call to link the cycle to
the Piwi run. The run page shows the cycle key, and the project's settings show which tests are mapped, which keys the
tool does not know, and what the last sync did. Piwi writes results only; nothing comes back except the list of test
case keys and names, read once a day. A second stage adds the option to write into a cycle that already exists (a
sprint or release cycle QA created), sending only the results that changed.

## Terms

- **Test management provider**: a tool that holds test cases and their runs. Zephyr Scale Cloud (REST API v2) is the
  first; Xray, TestRail, Qase and Zephyr Scale Data Center have the same shape and are later provider files. Zephyr
  Squad has a different model and is out of scope.
- **Test case key**: the provider's ID of a test case, `SHOP-T123` for Zephyr Scale (the API's pattern is
  `.+-T[0-9]+`). Not a Jira issue key (`SHOP-1234`).
- **Test run**: the provider's record of one run of a set of cases. Zephyr Scale calls it a **cycle** (`SHOP-R45`).
- **Result**: one case's status in one test run (`Pass`, `Fail`, `Blocked`, `Not Executed` in a default Zephyr
  project; each project can rename them).
- **Mapping**: the link from a Playwright test to one or more test case keys.
- **Sync**: the outbox action that sends one run's results to the provider.

## Problem

- **QA and developers read two different places.** QA plans and signs off in test cycles; developers read Playwright
  results in CI or in Piwi. An automated test that covers a test case leaves no trace in the test management tool unless
  someone types the result in by hand.
- **The usual workaround is expensive.** Teams that do push results often run a reporter inside the test repository
  that lists every test case of the project on every run, reads each matched case's steps or versions, then posts one
  result per test. For a project with N cases and M mapped tests that is about `ceil(N/100)` list calls, up to `M`
  reads, then `M` writes, every run, from every CI job, with a token in every pipeline's secrets.
- **The workaround gets the hard cases wrong in different ways.** A sharded run posts from each shard or only from the
  last one; a test that passed on retry becomes a Fail or a Pass depending on who wrote the reporter; a rerun of the
  failed tests creates a second cycle or nothing.
- **Piwi already knows the answer to each of these** (one finished run across shards, flaky results, branch and
  environment, the evidence), but has no way to hand it to the test management tool.

## What exists to build on

| Piece | Where | What it gives the sync |
|---|---|---|
| Integration connections | `integration_connections`, `server/utils/integrations/connections.ts` | Encrypted credentials (`encryptSecret`, `PIWI_SECRET_KEY`), `hasCredentials` summaries, env-managed rows (`ensureEnvManagedConnections`), the test button |
| Provider registry | `shared/integrations/registry.ts` (`INTEGRATION_PROVIDERS`, `IntegrationKind = 'tracker' \| 'wiki'`) | Where a `test-management` kind and the `zephyr-scale` provider are declared |
| Outbox | `integration_actions`, `server/utils/integrations/actions.ts`, `server/utils/outbox.ts` | Dedupe key, leases, 6 attempts, backoff 1/5/15/60/240 min, `retryAfterMs` winning over the table, final refusal on 4xx |
| End-of-run hook | `runFinalizeSideEffects` (`server/utils/run-finalize-side-effects.ts`) | Called once per finished run by `finish`, `submit`, `upload`, the last shard (`finalizeShardedRun`) and `settleFinalizingRun` |
| Run eligibility | `shared/run-eligibility.ts` (`RunUse`, `RUN_USES`, `isEligibleRun`) | Which origins a use reads, incidents, complete runs only |
| Branch and environment scope | `shared/integrations/automation.ts` (`TrackerRunScope`, `runInScope`) | The scope rule the tracker automation already uses |
| Tags | `test_runs_cases.tags`, `test_cases.tags` (`normalizeTestTags`, `@` stripped, at most `MAX_TEST_TAGS` = 20) | `@SHOP-T123` is already stored per execution as `SHOP-T123` |
| External IDs | `test_cases.external_id`, `piwi:id`, the reporter's `externalId.pattern`, `projects.external_id_url`, `TestIdChip` | "The ID in your test management tool": an optional source for the key, its link and its chip |
| Per-test outcome | `testOutcomes`, `finalAttempts`, `isFlakyExecution` (`shared/utils/test-counts.ts`), `passed_after_failure` | One result per test across projects and repeats; flaky read from the final attempt, never from `retries > 0` |
| Entity links | `entity_links` (`connection_id`, `external_id`, `origin`) | The run's link to its test run |
| Picker cache | `server/utils/integrations/picker-cache.ts` | The 5-minute cache for the binding form's dropdowns |

What the layer assumes today, and this proposal changes first (see [1](#1-provider-dispatch-and-binding-per-kind)):

- **The outbox is Jira-only past its binding check.** `runAction` checks the project's one binding, then calls
  `createTracker` before looking at the action's kind, and `trackerForRow` returns `null` for any provider but `jira`:
  any other action would be skipped as "connection has no usable credentials".
- **One binding per project.** `writeProjectIntegration` deletes every `project_integrations` row of the project before
  inserting one, and `runAction` skips an action whose connection is not that binding's (`NOT_BOUND`).
- **The connection endpoints are Jira-shaped.** `connections/index.post.ts` requires a typed `baseUrl`,
  `connections/check.post.ts` checks a Jira site, and a registry `CredentialField` is `text` or `password` only.
- **`Retry-After` handling is Jira-only.** `retryAfterMs` reads only `JiraError`, and only numeric seconds; the wait has
  no cap (Slack's client caps at 3,600 seconds).
- **A 429 pauses one row, not the connection.** The sweep processes every due row in order.
- **Tags are cut silently.** `normalizeTestTags` keeps the first 20, in the reporter and again on the server; a test
  covering many cases loses keys without a word.
- **Imports never call the end-of-run hook**, so a run imported from a merged report or a blob does not sync, like the
  other end-of-run effects.

Confluence (step 5 of the tracker proposal) meets the same first four assumptions, so the changes below are designed
for both.

## Options compared

### Where the work runs

| | A. CI step, no Piwi | B. Reporter writes to the tool | C. Piwi server syncs (recommended) |
|---|---|---|---|
| How | Playwright's `junit` reporter, then a CI step that posts the XML to Zephyr's `/automations/executions/junit` | `@piwitests/reporter` calls the tool in `onEnd` | The end-of-run hook enqueues one outbox action |
| Sharded runs | One upload per shard, so one cycle per shard, unless a merge job runs first | Same problem: each shard's `onEnd` sees only its own tests | One upload when the last shard finishes (`finalizeShardedRun`) |
| Flaky | JUnit has no "passed on retry"; depends on how the XML was written | Possible | `passed_after_failure` on the final attempt |
| Branch and environment policy | Shell logic in each pipeline | Options in each repository | One setting per project, `runInScope` |
| Evidence links | None | Links to a report that CI may delete | Links to the run and each execution in Piwi |
| Credential | A token in every pipeline | A token in every pipeline | One encrypted token on the server |
| Retry when the tool is down | The CI step fails or is skipped | The run's end is delayed | Outbox retry for about five hours, visible in the activity list |

Option A stays a valid answer for a team without Piwi, and the docs page says so. Option B puts a third-party write in
the test process and a token on every runner, and cannot see across shards. Option C is the only one where "once per
finished run" is already solved.

### When it syncs

| | End-of-run batch (recommended) | Scheduled sync | Real-time, per test |
|---|---|---|---|
| Calls per run (Zephyr) | 2 | 2 per run found since the last pass, plus a query of what is new | M (one per mapped test), plus the cycle |
| Freshness | Seconds after the run | Up to the interval | While the run is in progress |
| Shards and retries | Sees the final result of every test | Same | Sees an attempt before its retry, so a flaky test is first posted as Fail |
| Failure handling | One outbox row per run | One job, harder to say which run failed | M rows, each retried separately |

### How it writes (Zephyr Scale)

| | Bulk upload (stage 1) | One call per result (stage 2) |
|---|---|---|
| Endpoint | `POST /automations/executions/custom` with a zip | `POST /testcycles` once, then `POST /testexecutions` per case |
| Calls per run | 1, plus 1 to add the cycle's web link | 1 lookup or create (cached), then one per changed result |
| Cycle | Always a **new** cycle (the response is "the newly created test cycle") | Any cycle, including one QA created |
| Per-result fields | Result, test case key, possibly a comment (to confirm) | `statusName`, `comment`, `environmentName`, `executionTime`, `actualEndDate`, `automated` |
| Limit | Zip of at most 10 MB | Rate limit, undocumented |

## Design

### 1. Provider dispatch and binding per kind

The tracker layer's promise is that the next tool is one provider file. Three changes make that hold for a second
kind, and Confluence uses the same three.

**Dispatch by provider in the outbox.** An action kind belongs to one integration kind, declared next to the action
keys (`shared/integrations/action-keys.ts`): `create-issue`, `comment`, `update-issue`, `attach`, `transition` →
`tracker`; `sync-results` → `test-management`; `create-page`, `update-page` → `wiki`. `runAction` then:

1. looks up the action's integration kind;
2. checks the project's binding **for that kind** (`boundConnectionId(db, projectId, kind)`), skipping with
   `NOT_BOUND` as today when the action's connection is not the bound one;
3. builds the client through the kind's factory (`createTracker`, `createTestManagement`, later `createWiki`), each of
   which dispatches on `integration_connections.provider` and returns `null` only for a connection without usable
   credentials;
4. hands the action to that kind's handlers. The tracker handlers do not change.

**Provider-aware connection endpoints.** The registry describes how a provider is reached, and the endpoints read it
instead of assuming a Jira site:

- `IntegrationProviderMeta` gains `endpoint: { kind: 'url' } | { kind: 'region', regions: { id, label, baseUrl }[] }`.
  Jira keeps `url`; Zephyr Scale declares its four hosts (`us`, `eu`, `au`, `de` →
  `https://{,eu.,au.,de.}api.zephyrscale.smartbear.com/v2`). The connect form shows a URL input or a Region select.
- `CredentialField.type` gains `'select'` with `options`, for provider fields that are not free text.
- `connections/index.post.ts` validates per provider: a `url` provider requires `baseUrl`; a `region` provider requires
  a known region, and the server derives the base URL from it, so no administrator-typed host reaches the outbound
  client.
- `connections/check.post.ts` calls the provider's own `whoAmI()` through the kind's factory instead of a Jira check.

**One binding table per kind.** `project_integrations` stays the tracker binding (its columns are Jira's: issue type,
owner routes, field defaults). Each kind gets its own table with the columns it needs, one row per project:

| Kind | Table | Holds |
|---|---|---|
| `tracker` | `project_integrations` (exists) | Jira project, issue type, labels, owner routes, policies, auto-create rules |
| `test-management` | `project_test_management` (this proposal) | Provider project, key sources, run scope, cycle policy, status names |
| `wiki` | `project_wiki` (Confluence, later) | Space, parent page, publish policies |

`boundConnectionId(db, projectId, kind)` reads the kind's table, so writing a tracker binding never touches the test
management one. A per-kind table rather than one generic table with a JSON blob keeps each binding's columns typed and
its normalizer (`resolveProjectIntegration` and its siblings) local to its kind. The same decision is recorded in
[issue-tracker-integrations.md](issue-tracker-integrations.md#storage-and-api).

### 2. The test management interface

`server/utils/integrations/test-management/types.ts`, next to the `IssueTracker` interface:

```ts
export interface TestManagementProvider {
  readonly provider: TestManagementProviderName; // 'zephyr-scale' first
  whoAmI(): Promise<{ id: string; displayName: string }>;
  listProjects(): Promise<TmProject[]>;                         // for the binding form
  listCases(projectKey: string, page: PageCursor): Promise<TmPage<TmCase>>; // the catalog: key, id, name, status, folder
  listStatuses(projectKey: string): Promise<TmStatus[]>;         // result status names, for the mapping selects
  uploadRun(input: UploadRunInput): Promise<TmRun>;              // one call: create the run with every result
  findRun(projectKey: string, marker: RunMarker): Promise<TmRun | null>; // a run an earlier attempt may have created
  linkRun(run: TmRun, link: { url: string; title: string }): Promise<void>;
  addResults?(run: TmRun, results: TmResult[]): Promise<void>;  // stage 2: write into an existing run
  caseUrl?(key: string): string | null;
}
```

- `UploadRunInput` is `{ projectKey, name, description, folderId?, version?, results: { key, status, comment? }[] }`;
  `TmRun` is `{ key, id, url }`; `RunMarker` is `{ runId, startedAt }`, the facts a retry uses to recognize its own run.
- The payload a sync stores is built from these neutral types; only the client turns them into Zephyr's custom
  format, its zip and its endpoints.
- Xray, TestRail, Qase and Zephyr Scale Data Center are each a client file and a registry entry. Data Center differs
  in its host (a `url` endpoint), its auth and its API version, all behind the interface.

### 3. Mapping a test to a test case

Developers add a tag, which Playwright already supports and Piwi already stores:

```ts
test('pays with a saved card', { tag: ['@SHOP-T123', '@SHOP-T124'] }, async ({ page }) => {
  /* … */
});

test.describe('checkout', { tag: '@SHOP-T200' }, () => {
  /* every test inside covers SHOP-T200 */
});
```

- **Source**: the tags of each execution that match the binding's key pattern, by default `^<projectKey>-T[0-9]+$` (so
  `SHOP-T123` matches and the story tag `SHOP-1234` does not). No reporter change and no new annotation.
- **Optional second source**: `test_cases.external_id`, when the team already declares the key with `piwi:id` or the
  reporter's `externalId.pattern` and it matches the key pattern. Off by default: an external ID holds one value per
  test, and a project may use it for another tool.
- **Many to many.** A test can cover several cases, and a case can be covered by several tests or by the same test in
  several Playwright projects. The case's result is the worst result of the tests that cover it (see [5](#5-results)).
- **One reader of keys in tags.** Three settings read meaning from test names: the reporter's `externalId.pattern`
  (titles), the issue-key pattern of [#1153](https://github.com/PiwiTests/piwi/issues/1153) (tags naming the bug a
  failure is tracked in) and this key pattern (tags naming the case a test covers). The two tag patterns use one helper
  (`matchTagKeys(tags, pattern)` in `apps/application/shared/integrations/tag-keys.ts`; no reporter or extension code
  reads these patterns, so it stays out of the MIT `@piwitests/core`) and are edited in one place, a
  *Keys in test tags* section of the project's Integrations tab. The defaults do not collide (`SHOP-T123` fails
  `^[A-Z][A-Z0-9]+-\d+$`); custom ones can, so the section warns when a tag of the last complete run matches both
  patterns, naming the tag and a test that carries it.
- **Mapping held in the tool instead.** Some teams record the automated test in each case (in the objective or a
  custom field). Piwi does not read that: the docs page shows a one-time script outline that turns such a mapping into
  tags, run once in the test repository.

### 4. Tags cut at 20

`normalizeTestTags` keeps at most `MAX_TEST_TAGS` (20) tags, in declaration order. A test that covers many cases, plus
its other tags, loses the keys past the twentieth without a word. The limit stays (it bounds every tag column and
filter); the loss becomes visible:

- `normalizeTestTags` reports how many tags it dropped (a second return value from a sibling,
  `normalizeTestTagsWithDropped`, so existing callers do not change).
- **The reporter** warns once, in `onBegin`, listing the tests whose tags were cut (capped at 20 lines), and sends
  `metadata.tagsTruncated: { tests, examples }` with the run, the way `externalIdDuplicates` travels. The field follows
  the checklist in `server/api/test-runs/AGENTS.md` (*Adding a field to test run data*): the wire types, the `/begin`
  and `/finish` bodies, the submit path, `serializeRun`, `types/api.ts`, `getTestRun`, and the demo's `reporter.ts`,
  simulator and seed.
- **The server** computes the same from the raw `tags` of a payload sent without the reporter, through the same helper,
  and merges it with `updateRunMetadata`.
- **The run page** shows "Tags cut at 20 on N tests" in the facts line, with the tests in the Details popover; the
  binding form shows the same count for the last complete run (see the mockups on #1161).
- **The docs** state the limit on `reference/test-metadata.md` and on the test management page, with the order that
  decides which tags are cut. Playwright 1.64 builds `TestCase.tags` as: config tags, then the tags of each
  `describe` (title @-words and the `tag` option, outer to inner), then the @-words of the test title, then the test's
  own `tag` option last. So a key in the test's own `tag` option is the first to go. The remedy: keep config and
  describe tags few, put case keys in the test title (`test('checkout @SHOP-T123', …)`), or use the external ID for
  the one key that matters most. The docs page names the Playwright version the order was read from, and a reporter
  test pins it.

### 5. Results

One result per test case key, from the final attempts of the run (`finalAttempts`, `testOutcomes`):

| Piwi outcome of the tests covering the key | Status sent (configurable name) |
|---|---|
| Any failed or timed out | Fail |
| All passed, at least one only after a retry (`passed_after_failure`) | `flakyAs`: Pass by default, or any status the project defines (a custom `Flaky`), or Fail |
| All passed | Pass |
| All skipped or did not run | Left out by default; `skippedAs: 'Not Executed'` sends them |

- Status **names** come from `listStatuses` in the binding form, so a project that renamed `Pass` to `Passed` works.
- A quarantined test reports its actual result; quarantine is Piwi's triage, not a statement about the product.
- The comment on a result (stage 2, and stage 1 if Zephyr's custom format accepts it) is short and English: the
  outcome (`Passed on retry, attempt 2 of 3`), the Playwright project names, and links to the Piwi execution and run.
  The error excerpt is off by default (`includeError`), because an error message can carry data from the application
  under test and the tool is a third-party service.

### 6. Which runs sync

- A new `RunUse`, `test-management`, in `RUN_USES`: excludes `flake-lab`, `probe`, `bisect`, `reproduce`, `editor`,
  `preflight`, `bug`, `local` and `desktop`; excludes incidents and historical imports; **`completeOnly: true`**, so a
  partial run (`--grep`, `--only-changed`, `--last-failed`, one shard of a run that never finished) never syncs.
  Unlike `notifications` and `tracker`, which accept partial CI runs, this use writes a test run QA reads as "the suite
  ran". Sharding does not make a run partial: the reporter clears `isFullRun` only for a filter or a selection, and a
  sharded run reaches the hook once, completed, when `finalizeShardedRun` settles its last shard.
- The binding's run scope reuses `TrackerRunScope` and `runInScope`: branches (default: the project's default branch
  only), environments (default: any).
- `ci-rerun` (a rerun of the failed tests, partial because `--last-failed` clears `isFullRun`) does not sync in stage
  1. In stage 2, with a reused cycle, a rerun can update the results of the run it reran; see
  [Open questions](#open-questions).
- Imports do not sync, because they never call `runFinalizeSideEffects`. The docs page says so: a team that merges
  shard reports with `merge-reports` and imports the result gets no sync, and should report live from each shard.

### 7. Test runs and cycles

**Stage 1: a new test run per Piwi run.** Name from a template, `Automation · {branch} · {environment} · Piwi
#{runId}` by default. Variables: `{branch}`, `{environment}`, `{runId}`, `{commit}` (short SHA), `{date}` (run start,
UTC), `{ciBuild}` (the CI build number when the run carries one). `{runId}` is required: it makes the name unique and
lets a person, or a later `findRun`, recognize the run an attempt created. Optional on the binding: a folder (Zephyr:
`GET /folders?folderType=TEST_CYCLE`) and a version (Zephyr: `jiraProjectVersion`). The description holds the run URL,
branch, commit and counts; `linkRun` adds a web link to the run page.

**Stage 2: a reused test run.** The binding names an existing cycle key, or a template without `{runId}`
(`Automation · {branch} · {date}`) that Piwi creates on the first run that needs it and reuses until the name changes.
Piwi writes one result per **changed** case through `addResults`: it keeps the last status it sent per (test run, case)
in `test_management_results` and sends only a new or different one. Zephyr shows the latest execution of each case in a
cycle, so an unchanged result costs nothing.

### 8. The sync action

`runFinalizeSideEffects`, after `runTrackerAutomation`, when `isEligibleRun(run, 'test-management')`, the binding is
enabled and the run is in scope: enqueue one action and kick the sweep. No network call in the request.

```
kind         'sync-results'                                  -- integration kind 'test-management'
entity       test_run <runId>
dedupe_key   'sync-results:test_run:<runId>:conn<connectionId>'
payload      { run: { name, description, folderId?, version? },
               results: [{ key, status, comment? }],         -- built at enqueue, so a retry is deterministic
               unknownKeys: [...], unmappedCount, tagsTruncated, dryRun }
result       { runKey, runUrl, sent } | { dryRun: true }
```

Sending, stage 1:

1. No result in the payload: mark the action `skipped` (`no mapped test cases`). Nothing is sent and no marker is
   written.
2. Write an *upload started* marker (`{ uploadStartedAt }`) to the row's `result` and commit it before any call to
   the tool. Keys the catalog did not know at enqueue (see [9](#9-the-key-catalog)) are in `unknownKeys`, reported on
   the run, never sent.
3. `uploadRun`. For Zephyr: the custom-format JSON, zipped with `fflate` (already a dependency) and checked under
   10 MB, to `POST /automations/executions/custom?projectKey=SHOP&autoCreateTestCases=false` with the `file` and
   `testCycle` parts. **`autoCreateTestCases` is always `false`**: Zephyr cannot delete a test case, so one created by
   mistake stays forever.
4. **Commit the cycle key as soon as the upload returns**: `{ uploadStartedAt, runKey, runUrl }` on the row's
   `result`, before any other call. From here a retry never uploads; it resumes at step 5.
5. `linkRun` with the run URL.
6. Write the run's entity link (`provider: 'zephyr-scale'`, `origin: 'created'`, the cycle key and URL) in the same
   transaction as the action's final result (`{ runKey, runUrl, sent }`). `'zephyr-scale'` joins the `LinkProvider`
   union in `shared/link-detect.ts`, with its icon in the link chip.

Retries and idempotency:

- The upload is not idempotent: each call creates a cycle. **When an attempt ends without a response** (timeout,
  network error, 502/503/504), the action does not retry blind: it fails with *Outcome unknown: check the tool for a
  cycle named "… Piwi #<runId>", then use Sync again*, and waits for a person.
- ***Sync again*** first asks `findRun`. A found run is committed as `{ runKey, runUrl }` and only steps 5 and 6 run.
  When `findRun` finds nothing, *Sync again* replaces the old marker with a new `uploadStartedAt`, commits it, and
  uploads from step 3, so an attempt that dies during that upload is again an outcome unknown.
- **A reclaimed row never uploads twice.** The outbox lease (`OUTBOX_LEASE_MS`, 10 minutes) lets a later sweep claim
  a `processing` row whose worker died or ran past the lease. A claim that finds the *upload started* marker and no
  `runKey` treats the attempt as an outcome unknown, the same failure as above, and waits for *Sync again*. A claim
  or a backoff retry that finds a `runKey` skips the upload and resumes at `linkRun`, so a 429 or a 5xx on `linkRun`
  is an ordinary retry, never an outcome unknown. The client's request timeout stays well under the lease
  (2 minutes), so a live upload ends before its row can be reclaimed.
- **A 429 on the upload clears the marker.** The tool answered without creating a cycle, so the action removes
  `uploadStartedAt` in the same write that schedules the backoff, and the retry uploads normally. Any 5xx on the
  upload is an outcome unknown.
- `findRun` for Zephyr reads `GET /testexecutions?projectKey=&testCase=<first key>&actualEndDateAfter=<run start>
  &onlyLastExecutions=true`, then the cycle of each hit, matched on `Piwi #<runId>` in its name. It depends on the
  upload setting `actualEndDate` (assumption 3). Once that is confirmed, the outbox may call `findRun` itself before a
  retry; until then, the safe default above stands.
- Final refusals (400, 401, 403, 404, 413, 422) fail the action at once with the tool's message, as the Jira actions
  do; 401 also marks the connection `failed` so the settings page shows the token is rejected.
- Other calls' 429 and 5xx with a response follow the outbox backoff; `Retry-After` wins (seconds or an HTTP date, capped at one
  hour), and the connection pauses until then.
- **Dry run**: a binding setting, on by default for a new binding. The action builds the payload and stores it as its
  result without calling the tool. The activity list shows exactly what would be sent.

Sending, stage 2 (reused run): resolve the run key (cached per name), then `addResults` with the changed results,
paced by the connection's limiter; each accepted result is recorded in `test_management_results`, so a retry resends
only what is missing.

### 9. The key catalog

A cached copy of the provider project's test case keys, refreshed by a daily task (`server/tasks/integrations/
test-management-catalog.ts`) and by a *Refresh* button, through `listCases`. For Zephyr: `GET /testcases?projectKey=
&maxResults=1000&startAt=` until the last page, so `ceil(N/1000)` calls a day.

- **Before sending**: drop unknown keys (a typo, a deleted or archived case) instead of letting the tool reject or skip
  them.
- **For developers**: an unknown key shows as a warning on the run's test row (`SHOP-T999 is not a test case in
  SHOP`).
- **For QA**: the binding page lists mapped tests, tests with no key, unknown keys, and catalog cases no test claims
  (stage 3).
- The catalog stores key, provider id, name, status name and folder: what the screens show. Not the objective, steps
  or custom fields.

### 10. Display

No new chip. The key is shown where the test's identity already is:

- **Key from the external ID**: the existing `TestIdChip` gains a hover card when the project has a test management
  binding: the case name and status from the catalog, the last result sent and in which test run, and how the key was
  mapped. The chip's link stays `projects.external_id_url`.
- **Keys from tags**: the tag chip itself carries the same hover card when the tag matches the key pattern.
- **Run page**: the test run created (key, link, counts sent), *Sync again*, and per test the status sent or why
  nothing was.

### 11. What comes back

Only the catalog, the status and folder lists for the binding form, and each sync's run key and URL. Manual results,
comments and test run edits are never read: Piwi holds Playwright results, and the test management tool stays the
source of truth for the test plan. This keeps Piwi from becoming a test management tool.

## API calls per run (Zephyr Scale)

| Situation | Calls |
|---|---|
| Stage 1, run with mapped tests | 2 (upload, web link) |
| Stage 1, run with no mapped key, out of scope, or dry run | 0 |
| Stage 1, *Sync again* after an unknown outcome | 2 to 3 lookups, then 1 (link) when the run exists, else the 2 above |
| Stage 2, reused cycle, R results changed | 0 or 1 (create the cycle the first time) + R + 1 (web link) |
| Daily, per bound project | `ceil(N / 1000)` (catalog) |
| Opening the binding form | 3 (projects, statuses, folders), cached 5 minutes |

The same run without Piwi, with a per-test reporter: `ceil(N/100)` + up to M reads + M writes, per CI job.

## Data model

All tables in both dialects, migrations generated with `npm run db:generate && npm run db:generate:pg`.

**Binding** (one row per project, see [1](#1-provider-dispatch-and-binding-per-kind)):

```
project_test_management
  id, project_id (FK cascade, unique), connection_id (FK integration_connections, cascade),
  enabled bool, dry_run bool,
  provider_project_key text,
  key_sources json         -- { tags: true, externalId: false, pattern: '^SHOP-T[0-9]+$' }
  run_scope json           -- TrackerRunScope: branches, environments
  run_policy json          -- { mode: 'per-run' | 'reuse', nameTemplate, runKey?, folderId?, version? }
  statuses json            -- { pass, fail, flaky, notExecuted }: the tool's status names
  options json             -- { flakyAs, skippedAs, includeError, includeComment }
  created_at, updated_at
```

**Catalog**:

```
test_management_cases
  connection_id (FK cascade), project_key, key, provider_id, name, status_name, folder, fetched_at
  unique (connection_id, project_key, key)
```

**Stage 2 only**:

```
test_management_results
  connection_id, run_key, case_key, status_name, test_run_id (FK set null), provider_result_id, synced_at
  unique (connection_id, run_key, case_key)
```

**Unchanged**: `integration_connections` (a `zephyr-scale` row, `config: { region }`, credentials `{ apiToken }`),
`integration_actions` (new `kind` value; the column is free text), `entity_links` (a run row with
`provider: 'zephyr-scale'`, a new `LinkProvider` value), `test_cases` and `test_runs_cases` (the mapping is read from
tags at sync time).

Retention: `test_management_results` rows of runs not written for 90 days go with the existing sweep;
`pruneIntegrationActions` already covers the actions.

## Settings

**Instance, Settings → Integrations** (administrator): one card per provider from the registry. For Zephyr Scale:

| Field | Notes |
|---|---|
| Provider | Zephyr Scale Cloud; the list grows with the registry |
| Region | `us`, `eu`, `au`, `de`: a select, no URL to type |
| API access token | Secret, the JWT from Zephyr's *API keys* page; never returned |
| Test | the provider's `whoAmI()` (Zephyr: `GET /projects?maxResults=1`); records status and error |

Environment variables, registered in `PIWI_ENV_VARS` with `since`: `PIWI_ZEPHYR_API_TOKEN` (secret) and
`PIWI_ZEPHYR_REGION` (default `us`), which create an env-managed connection as `PIWI_JIRA_*` does.

**Project, Integrations tab** (administrator):

- *Keys in test tags*: the issue-key pattern of #1153 and the test case key pattern, with the overlap warning.
- *Test management*: enabled, dry run (on), provider project, key sources (tags on, external ID off), branches and
  environments, run policy and name template, folder and version, status names, flaky and skipped handling, include
  error excerpt (off). Below the form: the mapping summary (mapped tests, tests with no key, unknown keys, tags cut at
  20), the last 20 sync actions with their result or the tool's error, *Refresh catalog*, and *Sync again* on a failed
  action (reporter and above).

## Security

- **The token** is encrypted with `PIWI_SECRET_KEY` like every integration credential, never returned by an endpoint,
  and kept out of `error` strings and action payloads. Saving without `PIWI_SECRET_KEY` is refused, as for Jira.
- **The token is a person's.** A Zephyr API token acts as the user who created it, with that user's permissions. The
  docs recommend a dedicated account with access to the bound projects only, and say how to rotate it.
- **No user-supplied host** for a `region` provider: the base URL is one of the registry's hosts, picked by region, so
  the connection adds no outbound target an administrator could point at an internal address.
- **What leaves the server**: test case keys, statuses, run and execution URLs, branch, environment, commit, and (only
  when enabled) the first line of the error. Not traces, screenshots, videos or test code. The docs page lists it.
- **Writes cannot be undone.** Zephyr's API deletes attachments and links, never a test case, a cycle or an
  execution, so: dry run by default, `autoCreateTestCases=false` always, no blind retry of an upload whose outcome is
  unknown (a row reclaimed after its lease expired included, see [8](#8-the-sync-action)), and a sync never writes to
  a test run it was not configured for.
- **Roles**: connection and binding, `administrator`; *Sync again* and *Refresh catalog*, `administrator` and
  `reporter`; reading the activity and the hover cards, any project member. Each endpoint declares `x-required-roles`.

## Assumptions to confirm

Read from SmartBear's OpenAPI spec (`https://support.smartbear.com/zephyr-scale-cloud/api-docs/api.cloud.stripped.yml`):
the four regional hosts, the custom upload creating a new cycle, the 10 MB zip limit, the `testCycle` part fields,
`TestExecutionInput`, `PUT /testexecutions/{id}`, `maxResults` up to 1,000, cycle web links, and no delete operation for
test cases, cycles or executions. Not in the spec, so checked against a throwaway Zephyr project in the Zephyr pull
request, before any code depends on them:

1. The JSON schema of the custom format (`version`, `executions[].result`, `executions[].testCase.key`), the accepted
   `result` values, and whether an execution can carry a comment.
2. What the upload does when **some** keys are unknown: rejected as a whole, or the unknown ones skipped. A community
   report says it answers 400 (`Couldn't find any mapped test cases`) when **none** match.
3. Whether the upload sets `actualEndDate`, `executionTime`, `environmentName` or the executor. If not, stage 1's
   results carry only the status, and the cycle's description and web link carry the rest; `findRun` then cannot use
   `actualEndDateAfter`, and an unknown outcome stays with a person.
4. The rate limit and its headers. The spec documents none; the client assumes a conservative default (20 requests a
   minute per connection, `PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE`) and honors `Retry-After` when sent.
5. Large uploads: a community report describes a gateway timeout on an upload of about a thousand executions, which is
   the unknown-outcome case of [8](#8-the-sync-action).

If (1) or (2) turn out badly, stage 1 uses the call-per-result path of stage 2 with a new cycle per run, at the cost of
`M + 2` calls.

## Rollout

Each step is a pull request that leaves the app working, and ships its demo with it (`app/demo/AGENTS.md`): the
`app/demo/api/` handlers for any new endpoint, the data in `scripts/generate-demo-seed.mjs` and the simulator, the
guided tour when the step touches a page it visits, and `npm run app:seed:demo`. From step 4 the demo has a canned
Zephyr Scale connection whose uploads are recorded in the in-browser database, so dry run, the activity list and the
run page's test run link all work there.

1. **Dispatch by provider and binding per kind** (`refactor(app)`). The action-kind to integration-kind map;
   `runAction` checking the kind's binding and building the kind's client; `boundConnectionId(db, projectId, kind)`;
   the registry's `endpoint` and `select` fields; `connections/index.post.ts` and `connections/check.post.ts` per
   provider; a provider-neutral HTTP error with `retryAfterMs` (seconds or an HTTP date, capped at one hour); the
   per-connection pause on a 429. Jira behaves as before. Confluence builds on the same step.
2. **Tags cut at 20** (`feat(reporter)`, `feat(app)`). `normalizeTestTagsWithDropped`, the reporter warning and
   `metadata.tagsTruncated`, the server's check for payloads sent without the reporter, the run page note, the docs.
   Useful on its own, before any sync.
3. **Shared tag-key helper and settings** (`feat(app)`). `matchTagKeys` in `apps/application/shared/integrations/`,
   the *Keys in test tags* section shared with #1153, the overlap warning. Lands with or before #1153, whichever comes
   first.
4. **Test management kind and the Zephyr Scale client** (`feat(app)`). The interface, the registry entry, the client
   (`whoAmI`, `listProjects`, `listCases`, `listStatuses`), the connection card with Provider and Region, the
   env-managed connection, the assumptions above checked and recorded here.
5. **Binding and catalog** (`feat(app)`, `feat(db)` for the migration). `project_test_management`,
   `test_management_cases`, the daily catalog task, the binding form with dry run, the mapping summary, the hover card
   on `TestIdChip` and on matching tags.
6. **End-of-run sync** (`feat(app)`). The `test-management` run use, the payload builder (pure, in `shared/`),
   `sync-results` with `uploadRun` and `linkRun`, the unknown-outcome failure and *Sync again* with `findRun`, the
   test run link on the run page, docs page.
7. **Reused test runs** (`feat(app)`). Run policy `reuse`, `test_management_results`, `addResults` with one result per
   changed case, the comment and links, `ci-rerun` updating its original run's results.
8. **Later**: QA's coverage view (catalog cases no test claims), `testCaseKeys` on the MCP test case tools, more
   providers (Xray, TestRail, Qase, Zephyr Scale Data Center).

**With the first pull request**: an entry in `ROADMAP.md` (test management sync, results only), a link to this
proposal from `issue-tracker-integrations.md` (done on this branch), and, if the MCP tools gain `testCaseKeys`, an entry
in `proposals/1.0-stabilization.md`.

## Tests

- **Unit** (`apps/application/tests/unit`): the action-kind map and `runAction` dispatch (a tracker action unchanged, a
  `sync-results` action reaching the test management client, `NOT_BOUND` per kind); the connection POST per endpoint
  kind; the result collapse (worst wins, flaky, skipped, several projects and repeats, a key on a describe block); the
  key pattern against story keys; `matchTagKeys` and the overlap warning; `normalizeTestTagsWithDropped`; run name
  rendering and the required `{runId}`; the Zephyr payload and zip size check; `Retry-After` parsing and the cap; the
  connection pause; the `test-management` run use (partial runs, local runs, incidents, `ci-rerun`); the Zephyr client
  with `vi.stubGlobal('fetch')`, including 401, 429 and a timeout that ends in *outcome unknown*; a `sync-results` row
  reclaimed after its lease expired, with the *upload started* marker and no result, fails as outcome unknown and never
  calls `uploadRun` again; `linkRun` answering 429, and the retry linking the cycle without an *outcome unknown* or a
  second upload; a 429 on the upload clearing the marker; *Sync again* with `findRun` finding nothing writing a new
  marker before it uploads; an empty payload skipped with no marker; diffing against `test_management_results`; `migration-history.test.ts`.
- **Reporter** (`packages/reporter/tests`): the tags-cut warning and `metadata.tagsTruncated`; Playwright's tag order
  (config, describe outer to inner, title, the test's own `tag` option), so an upgrade that changes it fails a test.
- **E2E** (`apps/application/tests`): a mock Zephyr HTTP server in `tests/utils/`, as the Jira specs use; a finished run
  produces one upload with the expected keys and statuses; a sharded run produces one; a partial run and a branch out
  of scope produce none; dry run sends nothing and shows the payload; an unknown key shows its warning; a tracker
  binding saved after a test management binding leaves it in place; the settings form never returns the token. Project
  names registered in `shared/test-project-names.ts`.

## Documentation

- `apps/docs/features/test-management.md`: what it sends and when, mapping with tags, the 20-tag limit, the settings,
  the calls per run, what leaves the server, dry run, limits (no imports, Zephyr Scale Cloud first), and the CI-only
  alternative with Playwright's `junit` reporter for teams without Piwi. It says that with the 2-minute request
  timeout a large upload (around a thousand executions) will often end as *Outcome unknown* and need a person to
  check the tool and use *Sync again*: the safe choice, since a blind retry could create a second cycle.
- `apps/docs/reference/test-metadata.md`: test case keys as tags, and the 20-tag limit.
- The generated configuration reference picks up `PIWI_ZEPHYR_*`.
- `HELP_TOPICS` entries for the connection card, the binding form, the *Keys in test tags* section and the run name
  template.

## Alternatives considered

- **Zephyr's JUnit endpoint from Piwi** instead of the custom format: matches a case by a key prefix in the test name
  (`SHOP_T123_…`), so it would force a naming rule on titles. The custom format takes the key directly.
- **A new annotation** (`piwi:testcase`) as the main mapping: one more thing to learn when Playwright tags already do
  it, are visible in `--grep`, and are stored today. The external ID remains available for teams that already use it.
- **A second chip for the key**: the external ID already has `TestIdChip`, and tags already have their chips; a hover
  card on those carries the case without a new element.
- **Reading the mapping from the tool** (a custom field or the case objective): every team writes it differently, and
  it would make the sync depend on reading every case's fields. A one-time migration to tags is simpler.
- **Sending every attempt** as its own result: the tool shows the latest result per case, so the retries would hide
  each other and cost one call each. The flaky note says what happened.
- **Two-way sync of results**: the tool holds manual results Piwi has no use for, and reading them back would make
  Piwi a second test management tool.
- **One generic binding table** (`project_bindings` with a kind and a JSON config): fewer tables, but every binding's
  columns become untyped JSON and every reader filters by kind. One table per kind keeps the tracker code untouched.
- **A Zephyr-specific layer** (`zephyr_*` tables, no interface): less code for one provider, and a rewrite for the
  second.

## Open questions

1. **`ci-rerun`**: in stage 1 a rerun that passes leaves the Fail of the original run's cycle in place. Is that
   acceptable until stage 2, or should stage 1 send a rerun as its own cycle?
2. **Default for flaky**: Pass with a note (the result QA would record by hand after a retry), or a custom status,
   which each project must create first?
3. **Version on the test run**: a fixed value on the binding, or read from the run (a `PIWI_RELEASE` variable or a
   run tag) so a release pipeline files its run under the release?
4. **Several provider projects for one Piwi project** (a monorepo suite covering two Jira projects): one binding per
   Piwi project in this design; is a key pattern over several project keys needed?
