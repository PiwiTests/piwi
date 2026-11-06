# Zephyr Scale sync

A proposal to send the results of a Playwright run to Zephyr Scale, the Jira test management app, as one test cycle
per run, so QA reads automation results where they read manual ones and every result links back to its evidence in
Piwi. It builds on the integration layer of [issue-tracker-integrations.md](issue-tracker-integrations.md) and on the
external IDs of [external-test-ids.md](external-test-ids.md).

**Status.** Proposed; nothing built.

**Summary.** A test declares the Zephyr test cases it covers with a Playwright tag (`@SHOP-T123`), which the reporter
already sends. When a CI run on a branch in scope has finished, Piwi collapses its executions to one result per test
case and uploads them in **one** call to Zephyr Scale's automation endpoint, which creates the test cycle and every
execution at once. A second call links the cycle to the Piwi run. The run page shows the cycle key, and the project's
settings show which tests are mapped, which keys Zephyr does not know, and what the last sync did. Piwi writes results
only; nothing comes back from Zephyr except the list of test case keys and names, read once a day. A second stage
adds the option to write into a cycle that already exists (a sprint or release cycle QA created), sending only the
results that changed.

## Terms

- **Zephyr**: Zephyr Scale Cloud, REST API v2. Zephyr Squad and Zephyr Scale Data Center have different APIs and are
  out of scope.
- **Test case key**: a Zephyr test case, `SHOP-T123` (the API's pattern is `.+-T[0-9]+`). Not a Jira issue key
  (`SHOP-1234`).
- **Cycle**: a Zephyr test cycle, `SHOP-R45`: a set of test executions, one per test case, usually one run of a suite.
- **Execution**: one result of one test case in one cycle, with a status name (`Pass`, `Fail`, `Blocked`,
  `Not Executed` in a default project; each project can rename them).
- **Mapping**: the link from a Playwright test to one or more test case keys.
- **Sync**: the outbox action that sends one run's results to Zephyr.

## Problem

- **QA and developers read two different places.** QA plans and signs off in Zephyr cycles; developers read Playwright
  results in CI or in Piwi. An automated test that covers a Zephyr case leaves no trace in Zephyr unless someone types
  the result in by hand.
- **The usual workaround is expensive.** Teams that do push results often run a reporter inside the test repository
  that lists every test case of the Zephyr project on every run, reads each matched case's steps or versions, then
  posts one execution per test. For a project with N cases and M mapped tests that is about `ceil(N/100)` list calls,
  up to `M` reads, then `M` writes, every run, from every CI job, with a Zephyr token in every pipeline's secrets.
- **The workaround gets the hard cases wrong in different ways.** A sharded run posts from each shard or only from the
  last one; a test that passed on retry becomes a Fail or a Pass depending on who wrote the reporter; a rerun of the
  failed tests creates a second cycle or nothing.
- **Piwi already knows the answer to each of these** (one finished run across shards, flaky results, branch and
  environment, the evidence), but has no way to hand it to the test management tool.

## What exists to build on

| Piece | Where | What it gives the sync |
|---|---|---|
| Integration connections | `integration_connections`, `server/utils/integrations/connections.ts` | Encrypted credentials (`encryptSecret`, `PIWI_SECRET_KEY`), `hasCredentials` summaries, env-managed rows (`ensureEnvManagedConnections`), the test button |
| Provider registry | `shared/integrations/registry.ts` (`INTEGRATION_PROVIDERS`, `IntegrationKind = 'tracker' \| 'wiki'`) | Where a `zephyr-scale` provider and a `test-management` kind are declared |
| Outbox | `integration_actions`, `server/utils/integrations/actions.ts`, `server/utils/outbox.ts` | Dedupe key, leases, 6 attempts, backoff 1/5/15/60/240 min, `retryAfterMs` winning over the table, final refusal on 4xx |
| End-of-run hook | `runFinalizeSideEffects` (`server/utils/run-finalize-side-effects.ts`) | Called once per finished run by `finish`, `submit`, `upload`, the last shard (`finalizeShardedRun`) and `settleFinalizingRun` |
| Run eligibility | `shared/run-eligibility.ts` (`RunUse`, `RUN_USES`, `isEligibleRun`) | Which origins a use reads, incidents, complete runs only |
| Branch and environment scope | `shared/integrations/automation.ts` (`TrackerRunScope`, `runInScope`) | The scope rule the tracker automation already uses |
| Tags | `test_runs_cases.tags`, `test_cases.tags` (`normalizeTestTags`, `@` stripped) | `@SHOP-T123` is already stored per execution as `SHOP-T123` |
| External IDs | `test_cases.external_id`, `piwi:id`, the reporter's `externalId.pattern`, `projects.external_id_url` | An optional second source for the key, and the chip's link template |
| Per-test outcome | `testOutcomes`, `finalAttempts`, `isFlakyExecution` (`shared/utils/test-counts.ts`), `passed_after_failure` | One result per test across projects and repeats; flaky read from the final attempt, never from `retries > 0` |
| Entity links | `entity_links` (`connection_id`, `external_id`, `origin`) | The run's link to its cycle |
| Picker cache | `server/utils/integrations/picker-cache.ts` | The 5-minute cache for the binding form's dropdowns |

Gaps found during the audit, all addressed in [Rollout](#rollout):

- **One binding per project.** `writeProjectIntegration` deletes every `project_integrations` row of the project before
  inserting one, and `runAction` skips an action whose connection is not the bound one (`NOT_BOUND`). A Zephyr binding
  stored there would replace the Jira binding, and every Zephyr action would be skipped.
- **`Retry-After` handling is Jira-only.** `retryAfterMs` reads only `JiraError`; an HTTP-date value is ignored and the
  wait has no cap (Slack's client caps at 3,600 seconds).
- **A 429 pauses one row, not the connection.** The sweep processes every due row in order; the next row to the same
  host fires immediately after a 429.
- **Imports never call the end-of-run hook**, so a run imported from a merged report or a blob does not sync.

## Options compared

### Where the work runs

| | A. CI step, no Piwi | B. Reporter writes to Zephyr | C. Piwi server syncs (recommended) |
|---|---|---|---|
| How | Playwright's `junit` reporter, then a CI step that posts the XML to `/automations/executions/junit` | `@piwitests/reporter` calls Zephyr in `onEnd` | The end-of-run hook enqueues one outbox action |
| Sharded runs | One upload per shard, so one cycle per shard, unless a merge job runs first | Same problem: each shard's `onEnd` sees only its own tests | One upload when the last shard finishes (`finalizeShardedRun`) |
| Flaky | JUnit has no "passed on retry"; depends on how the XML was written | Possible | `passed_after_failure` on the final attempt |
| Branch and environment policy | Shell logic in each pipeline | Options in each repository | One setting per project, `runInScope` |
| Evidence links | None | Links to a report that CI may delete | Links to the run and each execution in Piwi |
| Credential | A Zephyr token in every pipeline | A Zephyr token in every pipeline | One encrypted token on the server |
| Retry when Zephyr is down | The CI step fails or is skipped | The run's end is delayed | Outbox retry for about five hours, visible in the activity list |

Option A stays a valid answer for a team without Piwi, and the docs page says so. Option B puts a third-party write in
the test process and a token on every runner, and cannot see across shards. Option C is the only one where "once per
finished run" is already solved.

### When it syncs

| | End-of-run batch (recommended) | Scheduled sync | Real-time, per test |
|---|---|---|---|
| Zephyr calls per run | 2 | 2 per run found since the last pass, plus a query of what is new | M (one per mapped test), plus the cycle |
| Freshness | Seconds after the run | Up to the interval | While the run is in progress |
| Shards and retries | Sees the final result of every test | Same | Sees an attempt before its retry, so a flaky test is first posted as Fail |
| Failure handling | One outbox row per run | One job, harder to say which run failed | M rows, each retried separately |

Real-time sync costs the most calls and records the wrong result for every flaky test. A scheduled sync adds latency
and a second trigger for no gain, since Piwi already knows the moment a run finishes. The batch at the end of the run
is the cheapest and the only one that sends final results.

### How it writes

| | Bulk upload (stage 1) | One call per execution (stage 2) |
|---|---|---|
| Endpoint | `POST /automations/executions/custom` with a zip | `POST /testcycles` once, then `POST /testexecutions` per case |
| Calls per run | 1, plus 1 to add the cycle's web link | 1 lookup or create (cached), then one per changed result |
| Cycle | Always a **new** cycle (the response is "the newly created test cycle") | Any cycle, including one QA created |
| Per-execution fields | Result, test case key, possibly a comment (to confirm) | `statusName`, `comment`, `environmentName`, `executionTime`, `actualEndDate`, `automated` |
| Limit | Zip of at most 10 MB | Rate limit, undocumented |

Both stay: the bulk upload is the default because one run makes one cycle in two calls; writing into an existing cycle
is a later option for the teams that plan cycles by sprint or release.

## Design

### 1. Mapping a test to Zephyr

Developers add a tag, which Playwright already supports and Piwi already stores:

```ts
test('pays with a saved card', { tag: ['@SHOP-T123', '@SHOP-T124'] }, async ({ page }) => {
  /* … */
});

test.describe('checkout', { tag: '@SHOP-T200' }, () => {
  /* every test inside covers SHOP-T200 */
});
```

- **Source**: the tags of each execution (`test_runs_cases.tags`) that match the binding's key pattern, by default
  `^<projectKey>-T[0-9]+$` (so `SHOP-T123` matches and the story tag `SHOP-1234` does not). No reporter change and no
  new annotation.
- **Optional second source**: `test_cases.external_id`, when the team already declares the Zephyr key with `piwi:id` or
  the reporter's `externalId.pattern` and it matches the key pattern. Off by default: a project may use external IDs
  for another tool, and an external ID holds one value per test.
- **Many to many.** A test can cover several cases, and a case can be covered by several tests or by the same test in
  several Playwright projects. The case's result is the worst result of the tests that cover it in the run (see
  [3](#3-results)).
- **Mapping held in Zephyr instead.** Some teams record the automated test in each Zephyr case (in the objective or a
  custom field). Piwi does not read that: the docs page shows a one-time script outline that turns such a mapping into
  tags, run once in the test repository.

### 2. Which runs sync

- A new `RunUse`, `test-management`, in `RUN_USES`: excludes `flake-lab`, `probe`, `bisect`, `reproduce`, `editor`,
  `preflight`, `bug`, `local` and `desktop`; excludes incidents and historical imports; **`completeOnly: true`**, so a
  partial run (`--grep`, `--only-changed`, one shard of a run that never finished) never syncs. Unlike `notifications`
  and `tracker`, which accept partial CI runs, this use writes a cycle QA reads as "the suite ran". Sharding does not
  make a run partial: the reporter clears `isFullRun` only for a filter or a selection, and a sharded run reaches the
  hook once, completed, when `finalizeShardedRun` settles its last shard.
- The binding's run scope reuses `TrackerRunScope` and `runInScope`: branches (default: the project's default branch
  only), environments (default: any).
- `ci-rerun` (a rerun of the failed tests) is not complete and does not sync in stage 1. In stage 2, with a reused
  cycle, a rerun can update the executions of the run it reran; see [Open questions](#open-questions).
- Imports do not sync, because they never call `runFinalizeSideEffects`. The docs page says so.

### 3. Results

One result per test case key, from the final attempts of the run (`finalAttempts`, `testOutcomes`):

| Piwi outcome of the tests covering the key | Zephyr status (configurable name) |
|---|---|
| Any failed or timed out | Fail |
| All passed, at least one only after a retry (`passed_after_failure`) | `flakyAs`: Pass by default, or any status the project defines (a custom `Flaky`), or Fail |
| All passed | Pass |
| All skipped or did not run | Left out by default; `skippedAs: 'Not Executed'` sends them |

- Status **names** come from `GET /statuses?projectKey=&statusType=TEST_EXECUTION` in the binding form, so a project
  that renamed `Pass` to `Passed` works. Piwi stores the names it maps to, never a translation.
- A quarantined test reports its actual result; quarantine is Piwi's triage, not a statement about the product.
- The comment on an execution (stage 2, and stage 1 if the custom format accepts it) is short and English: the outcome
  (`Passed on retry, attempt 2 of 3`), the Playwright project names, and links to the Piwi execution and run. The error
  excerpt is off by default (`includeError`), because an error message can carry data from the application under test
  and Zephyr is a third-party service.

### 4. Cycles

**Stage 1: a new cycle per run.** Name from a template, `Automation · {branch} · {environment} · Piwi #{runId}` by
default. Variables: `{branch}`, `{environment}`, `{runId}`, `{commit}` (short SHA), `{date}` (run start, UTC),
`{ciBuild}` (the CI build number when the run carries one). `{runId}` is required: it makes the name unique and is how a
retry finds a cycle that an earlier attempt created (see [5](#5-the-sync-action)). Optional on the binding: a cycle
folder (`folderId`, picked from `GET /folders?folderType=TEST_CYCLE`) and a Jira version (`jiraProjectVersion`). The
description holds the run URL, branch, commit and counts; a web link on the cycle points to the run page.

**Stage 2: a reused cycle.** The binding names an existing cycle key, or a template without `{runId}`
(`Automation · {branch} · {date}`) that Piwi creates on the first run that needs it and reuses until the name changes.
Piwi writes one execution per **changed** result: it keeps the last status it sent per (cycle, test case) and sends
only a new or different one. Zephyr shows the latest execution of each case in a cycle, so an unchanged result costs
nothing and the cycle stays correct. A run that sends nothing changed still updates the cycle's web link.

### 5. The sync action

`runFinalizeSideEffects`, after `runTrackerAutomation`, when `isEligibleRun(run, 'test-management')` and the binding is
enabled and the run is in scope: enqueue one action and kick the sweep. No network call in the request.

```
kind         'sync-results'
entity       test_run <runId>
dedupe_key   'sync-results:test_run:<runId>:conn<connectionId>'
payload      { cycle: { name, description, folderId?, jiraProjectVersion? },
               executions: [{ key, status, comment? }],      -- built at enqueue, so a retry is deterministic
               unknownKeys: [...], unmappedCount, dryRun }
result       { cycleKey, cycleUrl, sent, skippedUnknown } | { dryRun: true }
```

Sending, stage 1:

1. Send the executions of the payload. Keys the catalog did not know at enqueue (see [6](#6-the-key-catalog)) are in
   `unknownKeys`, reported on the run, never sent.
2. No execution in the payload: mark the action `skipped` (`no mapped test cases`). Nothing is sent.
3. Build the custom-format JSON, zip it with `fflate` (already a dependency), check it is under 10 MB.
4. `POST /automations/executions/custom?projectKey=SHOP&autoCreateTestCases=false` with the `file` and `testCycle`
   parts. **`autoCreateTestCases` is always `false`**: Zephyr cannot delete a test case, so one created by mistake
   stays forever.
5. `POST /testcycles/{key}/links/weblinks` with the run URL.
6. Write the run's entity link (`provider: 'zephyr'`, `origin: 'created'`, `key: SHOP-R45`, the cycle URL from the
   response) in the same transaction as the action's result.

Retries and idempotency:

- The upload is not idempotent: each call creates a cycle. When an attempt ends without a response (timeout, network
  error, 502/503/504), the next attempt first looks for the cycle: `GET /testexecutions?projectKey=&testCase=<first key>
  &actualEndDateAfter=<run start>&onlyLastExecutions=true`, then the cycle of each hit, matched on `Piwi #<runId>` in
  its name. Found: record it as the result and go to step 5. Not found: upload again. If the probe cannot work (see
  assumption 3), the action fails with "outcome unknown, check Zephyr" and waits for a manual *Sync again* rather
  than uploading blind. A response with a status code skips this check.
- Final refusals (400, 401, 403, 404, 413, 422) fail the action at once with Zephyr's message, as the Jira actions do;
  401 also marks the connection `failed` so the settings page shows the token is rejected.
- 429 and 5xx follow the outbox backoff; `Retry-After` wins (seconds or an HTTP date, capped at one hour), and the
  connection pauses until then (see stage 1 of [Rollout](#rollout)).
- **Dry run**: a binding setting, on by default for a new binding. The action builds the payload and stores it as its
  result without calling Zephyr. The activity list shows exactly what would be sent, which matters because nothing
  written to Zephyr can be deleted.

Sending, stage 2 (reused cycle): resolve the cycle key (cached per name), then one `POST /testexecutions` per changed
result, paced by the connection's limiter, each recorded in `zephyr_synced_results` as it succeeds, so a retry resends
only what is missing.

### 6. The key catalog

A cached copy of the Zephyr project's test case keys, refreshed by a daily task (`server/tasks/integrations/
zephyr-catalog.ts`) and by a *Refresh* button: `GET /testcases?projectKey=&maxResults=1000&startAt=` until the last
page, so `ceil(N/1000)` calls a day.

- **Before sending**: drop unknown keys (a typo, a deleted or archived case) instead of letting Zephyr reject or skip
  them.
- **For developers**: the run page and the test page show the key chip with the case's name; an unknown key shows as a
  warning chip (`SHOP-T999 is not a Zephyr test case`).
- **For QA**: the binding page lists mapped tests, tests with no key, unknown keys, and catalog cases no test claims
  (stage 3).
- The catalog stores key, numeric id, name, status name and folder: what the screens above show. Not the objective,
  steps or custom fields.

### 7. What comes back from Zephyr

Only the catalog (section 6), the status and folder lists for the binding form, and each sync's cycle key and URL.
Manual results, comments and cycle status edits in Zephyr are never read: Piwi holds Playwright results, and Zephyr
stays the source of truth for the test plan.

## API calls per run

| Situation | Calls |
|---|---|
| Stage 1, run with mapped tests | 2 (upload, web link) |
| Stage 1, run with no mapped key, out of scope, or dry run | 0 |
| Stage 1, retry after a timeout | 2 to 3 lookups, then 1 (web link) when the cycle exists, else the 2 above |
| Stage 2, reused cycle, R results changed | 0 or 1 (create the cycle the first time) + R + 1 (web link) |
| Daily, per bound project | `ceil(N / 1000)` (catalog) |
| Opening the binding form | 3 (statuses, folders, projects), cached 5 minutes |

The same run without Piwi, with a per-test reporter: `ceil(N/100)` + up to M reads + M writes, per CI job.

## Data model

All tables in both dialects, migrations generated with `npm run db:generate && npm run db:generate:pg`.

**Bindings.** A new table rather than a second row in `project_integrations`, which holds one tracker binding per
project and whose writer replaces the whole set:

```
project_test_management
  id, project_id (FK cascade, unique), connection_id (FK integration_connections, cascade),
  enabled bool, dry_run bool,
  zephyr_project_key text,
  key_sources json         -- { tags: true, externalId: false, pattern: '^SHOP-T[0-9]+$' }
  run_scope json           -- TrackerRunScope: branches, environments
  cycle json               -- { mode: 'per-run' | 'reuse', nameTemplate, cycleKey?, folderId?, jiraProjectVersion? }
  statuses json            -- { pass, fail, flaky, notExecuted }: Zephyr status names
  options json             -- { flakyAs, skippedAs, includeError, includeComment }
  created_at, updated_at
```

`runAction` checks a `sync-results` action against this table instead of `boundConnectionId`, through a per-kind
check: tracker kinds keep `NOT_BOUND` as it is.

**Catalog.**

```
zephyr_test_cases
  connection_id (FK cascade), project_key, key, zephyr_id, name, status_name, folder_id, fetched_at
  unique (connection_id, key)
```

**Stage 2 only.**

```
zephyr_synced_results
  connection_id, cycle_key, test_case_key, status_name, test_run_id (FK set null), execution_id, synced_at
  unique (connection_id, cycle_key, test_case_key)
```

**Unchanged**: `integration_connections` (a `zephyr-scale` row, `config: { region }`, credentials `{ apiToken }`),
`integration_actions` (new `kind` value; the column is free text), `entity_links` (a run row with `provider: 'zephyr'`),
`test_cases` and `test_runs_cases` (the mapping is read from tags at sync time, so nothing is denormalized).

Retention: `zephyr_synced_results` rows of cycles not written for 90 days go with the existing sweep;
`pruneIntegrationActions` already covers the actions.

## Settings

**Instance, Settings → Integrations** (administrator): a *Zephyr Scale* card from the registry.

| Field | Notes |
|---|---|
| Region | `us`, `eu`, `au`, `de` → `https://{,eu.,au.,de.}api.zephyrscale.smartbear.com/v2`. A select, not a URL |
| API access token | Secret, the JWT from Zephyr's *API keys* page; never returned |
| Test | `GET /projects?maxResults=1`; records status and error |

Environment variables, registered in `PIWI_ENV_VARS` with `since`: `PIWI_ZEPHYR_API_TOKEN` (secret) and
`PIWI_ZEPHYR_REGION` (default `us`), which create an env-managed connection as `PIWI_JIRA_*` does.

**Project, Integrations tab** (administrator): a *Zephyr Scale* section next to the tracker binding.

| Setting | Default |
|---|---|
| Enabled, dry run | off, on |
| Zephyr project | picked from `GET /projects` |
| Key sources | tags on; external ID off; pattern from the project key |
| Branches, environments | default branch; any |
| Cycle mode and name template | per run; `Automation · {branch} · {environment} · Piwi #{runId}` |
| Cycle folder, Jira version | none |
| Status names | from `GET /statuses`, prefilled on `Pass`, `Fail`, `Not Executed` |
| Flaky as, skipped as | Pass; left out |
| Include error excerpt | off |

Below the form: the mapping summary (mapped tests, tests with no key, unknown keys), the last 20 sync actions with
their result or Zephyr's error, *Refresh catalog*, and *Sync this run again* on a failed action (reporter and above).

## Security

- **The token** is encrypted with `PIWI_SECRET_KEY` like every integration credential, never returned by an endpoint,
  and kept out of `error` strings and action payloads. Saving without `PIWI_SECRET_KEY` is refused, as for Jira.
- **The token is a person's.** A Zephyr API token acts as the user who created it, with that user's permissions. The
  docs recommend a dedicated account with access to the bound projects only, and say the token is rotated from
  Zephyr's *API keys* page.
- **No user-supplied host.** The base URL is one of four SmartBear hosts picked by region, so the connection adds no
  outbound-request target an administrator could point at an internal address.
- **What leaves the server**: test case keys, statuses, run and execution URLs, branch, environment, commit, and
  (only when enabled) the first line of the error. Not traces, screenshots, videos, test code or titles beyond what the
  comment names. The docs page lists it.
- **Writes cannot be undone.** The API deletes attachments and links, never a test case, a cycle or an execution, so:
  dry run by default, `autoCreateTestCases=false` always, and a sync never writes to a cycle it was not configured for.
- **Roles**: connection and binding, `administrator`; *Sync again* and *Refresh catalog*, `administrator` and
  `reporter`; reading the activity and chips, any project member. Each endpoint declares `x-required-roles`.

## Assumptions to confirm

Read from SmartBear's OpenAPI spec (`https://support.smartbear.com/zephyr-scale-cloud/api-docs/api.cloud.stripped.yml`):
the four regional hosts, the custom upload creating a new cycle, the 10 MB zip limit, the `testCycle` part fields,
`TestExecutionInput`, `PUT /testexecutions/{id}`, `maxResults` up to 1,000, cycle web links, and no delete operation for
test cases, cycles or executions. Not in the spec, so checked against a throwaway Zephyr project in the first Zephyr
pull request, before any code depends on them:

1. The JSON schema of the custom format (`version`, `executions[].result`, `executions[].testCase.key`), the accepted
   `result` values, and whether an execution can carry a comment.
2. What the upload does when **some** keys are unknown: rejected as a whole, or the unknown ones skipped. A community
   report says it answers 400 (`Couldn't find any mapped test cases`) when **none** match.
3. Whether the upload sets `actualEndDate`, `executionTime`, `environmentName` or the executor. If not, stage 1's
   executions carry only the result, and the cycle's description and web link carry the rest. The retry probe of
   section 5 needs `actualEndDate`; without it, a timed-out upload is left for a manual retry.
4. The rate limit and its headers. The spec documents none; the client assumes a conservative default (20 requests a
   minute per connection, `PIWI_ZEPHYR_REQUESTS_PER_MINUTE`) and honors `Retry-After` when sent.
5. Large uploads: a community report describes a gateway timeout on an upload of about a thousand executions. The
   look-up-before-retry of section 5 covers the case where it was processed anyway.

If (1) or (2) turn out badly, stage 1 uses the call-per-execution path of stage 2 with a new cycle per run, at the
cost of `M + 2` calls.

## Rollout

Each step is a pull request that leaves the app working.

1. **Outbox for any provider** (`refactor(app)`). A provider-neutral HTTP error carrying `retryAfterMs`; `Retry-After`
   read as seconds or an HTTP date, capped at one hour; a per-connection pause, so a 429 defers the connection's other
   due rows in the same sweep; the per-kind binding check in `runAction`. No visible change.
2. **Zephyr connection** (`feat(app)`). Registry entry with kind `test-management`, the client (`whoAmI`, projects,
   statuses, folders, test cases page), Settings → Integrations card, env-managed connection, the assumptions above
   checked and recorded in this proposal.
3. **Binding and catalog** (`feat(app)`, `feat(db)` for the migration). `project_test_management`,
   `zephyr_test_cases`, the daily catalog task, the binding form with dry run, the mapping summary, the key chip with
   unknown-key warnings.
4. **End-of-run sync** (`feat(app)`). The `test-management` run use, the payload builder (pure, in `shared/`), the
   `sync-results` action with the bulk upload and look-up-before-retry, the cycle link on the run page, *Sync again*,
   docs page.
5. **Reused cycles** (`feat(app)`). Cycle mode `reuse`, `zephyr_synced_results`, one execution per changed result with
   the comment and links, the connection limiter, `ci-rerun` updating its original run's executions.
6. **Later**: QA's coverage view (catalog cases no test claims), `zephyrKeys` on the MCP test case tools, a demo
   connection that records uploads in the in-browser database.

## Tests

- **Unit** (`apps/application/tests/unit`): the result collapse (worst wins, flaky, skipped, several projects and
  repeats, a key on a describe block); the key pattern against story keys; cycle name rendering and the required
  `{runId}`; the custom-format payload and zip size check; `Retry-After` parsing and the cap; the connection pause; the
  `test-management` run use (partial runs, local runs, incidents, `ci-rerun`); the per-kind binding check; the Zephyr
  client with `vi.stubGlobal('fetch')`, including 401, 429 and a timeout followed by a found cycle; diffing against
  `zephyr_synced_results`; `migration-history.test.ts`.
- **E2E** (`apps/application/tests`): a mock Zephyr HTTP server in `tests/utils/`, as the Jira specs use; a finished run
  produces one upload with the expected keys and statuses; a sharded run produces one; a partial run and a branch out
  of scope produce none; dry run sends nothing and shows the payload; an unknown key shows the warning chip; the
  settings form never returns the token. Project names registered in `shared/test-project-names.ts`.

## Documentation

- `apps/docs/features/zephyr.md`: what it sends and when, mapping with tags, the settings, the calls per run, what
  leaves the server, dry run, limits (no imports, no Zephyr Squad or Data Center), and the CI-only alternative with
  Playwright's `junit` reporter for teams without Piwi.
- `apps/docs/reference/test-metadata.md`: test case keys as tags.
- The generated configuration reference picks up `PIWI_ZEPHYR_*`.
- `HELP_TOPICS` entries for the connection card, the binding form and the cycle name template.

## Alternatives considered

- **Zephyr's JUnit endpoint from Piwi** instead of the custom format: matches a case by a key prefix in the test name
  (`SHOP_T123_…`), so it would force a naming rule on titles. The custom format takes the key directly.
- **A new annotation** (`piwi:zephyr`) as the main mapping: one more thing to learn when Playwright tags already do it,
  are visible in `--grep`, and are stored today. The external ID remains available for teams that already use it.
- **Reading the mapping from Zephyr** (a custom field or the case objective): every team writes it differently, and it
  would make the sync depend on reading every case's fields. A one-time migration to tags is simpler.
- **Sending every attempt** as its own execution: Zephyr shows the latest execution per case, so the retries would hide
  each other and cost one call each. The flaky note says what happened.
- **Two-way sync of results**: Zephyr holds manual results Piwi has no use for, and reading them back would make Piwi a
  second test management tool.
- **Storing the Zephyr binding in `project_integrations`**: would need that table to hold one row per kind and every
  reader of it to filter by kind; a separate table leaves the tracker code untouched.

## Open questions

1. **`ci-rerun`**: in stage 1 a rerun that passes leaves the Fail of the original run's cycle in place. Is that
   acceptable until stage 2, or should stage 1 send a rerun as its own cycle?
2. **Default for flaky**: Pass with a note (the result QA would record by hand after a retry), or a custom status, which
   each project must create first?
3. **Jira version on the cycle**: a fixed value on the binding, or read from the run (a `PIWI_RELEASE` variable or a
   run tag) so a release pipeline files its cycle under the release?
4. **Several Zephyr projects for one Piwi project** (a monorepo suite covering two Jira projects): one binding per Piwi
   project in this design; is a key pattern over several project keys needed?
5. **Zephyr Scale Data Center**: a second client behind the same interface, if there is demand.
