# Environments

- Status: accepted
- Date: 2026-11-18

A plan to make the deployment environment a project's tests run against (Local, Integration, Staging, Production) a
record of the project, where today it is a free-text label a run reports. It answers a team that runs its tests from
the desktop app, Piwi Runner and the editors, and changes the application under test with environment variables read
by the Playwright config (`TEST_ENV=staging`): no path that starts a run lets them choose the environment, and the
label their runs report is free text that eleven features read and eight settings copy.

**Status.** Built in two pull requests: the four delivery steps, all but one piece of D12. The first built steps 1
and 2 and the copy of D14: the records and their routes, the resolution of each run's label at every route that stores
a run and for the runs stored before, the filters matching an environment by key, the settings section and the
pickers, the choice of an environment on every path that starts a run with its run variables, `PIWI_ENVIRONMENT` and a
protected environment's rules, the run page's warnings of D7, the env file of D8 and the team environments of D13. The
second built the rest: the settings that name environments (D4, D12), the default environment (D10), the deployed
environments of D11 with the deployed commit from both instrumentation packages and from deploy markers, the first
failing deploy, each environment's last run, incidents and deploys, and pass reuse's environment.

**Left out**: the test management mapping of D12 (each environment to the tool's environment name). The automation
upload Piwi sends to Zephyr Scale has no documented environment field, and Piwi has no Xray integration; a run's name
still carries the environment (`{environment}`).

**Settled while building** (2026-11-18, with the maintainer): filters keep keys and patterns rather than ids (D4);
deleting an environment a URL pattern or a CI action names is refused (D4); the application is assumed to live in the
project's repository (D11); an environment counts as built from the checkout until a manager marks it deployed (D11).
The six questions raised while writing the plan were settled the same day: an environment sets variables only, never
Playwright projects (D1); filters keep their `*` patterns (D4); a protected environment is confirmed, limited to its
required tags and started by a project manager only (D9); the deployed commit comes from the server snapshot and from
deploy markers (D11); the desktop app offers the environments of the team project a folder is linked to (D13); a
project copies another's environments (D14).

## Summary

- An **environment** becomes a record of a project: a key (the label its runs report), a name, its own run variables,
  its URLs, whether the app under test is built from the run's checkout, and whether it is protected. Runs keep the
  label they report and gain the environment it resolves to (D2, D3).
- Every place Piwi starts a run, or gives a command to copy, lets the person choose the environment, and applies its
  run variables over the project's, with `PIWI_ENVIRONMENT` set to its key. **None** stays offered: Piwi then sets
  nothing, as today (D5, D6).
- The settings that name environments today (URL patterns, markers, CI actions, notification filters, issue and test
  management scopes, reports and dashboards, the project's status filter) reference the record instead of a copy of the
  text, and every picker reads one list instead of the labels of the last runs (D4).
- Analysis learns what the label cannot say: a **default environment**, like the default branch (D10), and whether
  the app is built from the run's checkout, which decides what bisect, suspect lines, pass reuse and the AI diagnosis
  may assume about the code under test (D11).
- Secrets stay on each machine: an environment may name the `.env` file its config loads, which Piwi checks for and
  copies into a reproduction's worktree, and never reads (D8).
- A **protected environment** (production) runs only the tests carrying its required tags, only for the project's
  managers, after a confirmation, and never for an agent (D9).
- The desktop app's local runs offer the environments of the team project their folder is linked to, read from the team
  instance, so Staging is set once (D13).

## Terms

- **Environment**: a deployment of the application a project's tests run against, kept as a record of the project.
  One word for one concept: not to be confused with the **environment variables** of a process, the **environment
  snapshots** of [1.0-stabilization.md](../proposals/1.0-stabilization.md) D65 (where a run executed), or an **environment
  incident** (a run whose failures come from the application being down).
- **Label**: the text a run reports with the reporter's `environment` option or `PIWI_ENVIRONMENT`, stored as it came.
- **Key**: the label an environment's runs report, unique in the project, matched ignoring case.
- **Alias**: another label, or a `*` pattern, that resolves to the same environment (`stg`, `pr-*`).
- **Run variable**: one `NAME=value` pair applied to the runs Piwi starts, as in [run-variables.md](run-variables.md).
  A project has some; with this plan an environment has some too.
- **Default environment**: the environment the project's views read by default, as they read the default branch.
- **App built from the checkout**: an environment whose application under test is built from the same commit as the
  tests (a `webServer` in the config, an ephemeral CI deployment). Its opposite is a **deployed environment**, whose
  application version is independent of the run's commit.
- **Protected environment**: one Piwi starts a run against only when a project manager confirms it, only for the
  tests carrying its required tags, and never for an agent (D9).
- **Required tags**: the Playwright tags (`@smoke`) a protected environment's runs are limited to.
- **Discovered environment**: one created by a run reporting a label nobody declared (D3).

## How teams choose an environment

Environment variables are the common practice, and the one Playwright documents. Its documentation shows two
patterns, and teams use a third:

1. **A variable read by the config**, often with one `.env` file per environment for the secrets:
   `TEST_ENV=staging npx playwright test`, the config loading `.env.staging` and reading `BASE_URL` from it. The most
   common, and the one this team uses.
2. **One Playwright project per environment** (`projects: [{ name: 'staging', use: { baseURL } }]`), chosen with
   `--project`. It multiplies with the browser projects (`chromium-staging`, `firefox-production`).
3. **One config file per environment** (`--config playwright.staging.config.ts`).

In CI, a job per environment sets the variable and takes the secrets from the CI's secret store.

The tools that start or record runs model the environment as a named record: Postman's environments are named sets of
variables picked from a list before a request; GitHub's deployment environments hold variables, secrets, a URL and
protection rules; Sentry creates an environment from the first event that names it and filters every view by it; Xray
attaches a test environment to each test execution and Zephyr Scale has an environment field on each result. What they
add over the variable is the **name and the set of variables together**, picked from a list, and a place to hang what
belongs to the deployment (its URL, its protection).

Piwi keeps the variable as the contract with the config, since it never reads or changes the config's code
([run-variables.md](run-variables.md) D8), and adds the record.

## What exists

### The label

- **Set** by the reporter's `environment` option, else `PIWI_ENVIRONMENT` (`packages/reporter/src/internal/config/env.ts`),
  sent on `/setup`, `/start` and the batch upload. Nothing detects it from CI, and no path Piwi starts sets it: run
  variables refuse the `PIWI_` prefix.
- **Stored as it came** (`body.environment || null` in `server/api/test-runs/setup.post.ts`, `start.post.ts`,
  `upload.post.ts`): no trim, no case change, no length limit, no index. The import paths trim it. It never changes
  after the run is stored.
- **Read as exact text** by every consumer, so `staging`, `Staging` and `stg` are three environments, and a run with
  no label is skipped by every environment filter.

### Who reads it

| Feature | Where | What a variant label or a missing one does |
| --- | --- | --- |
| Run baseline (Changes tab, regression signals, CI gate, PR feedback, bisect's good end, AI diagnosis) | `server/utils/branch-baseline.ts` | the same-environment rungs miss; the baseline comes from another environment, with its note |
| Execution diffs (environment, visual, page) | `shared/baseline-order.ts` | ranks another environment first |
| Flaky list, Flake Lab, project tabs | `shared/handlers/projects.ts`, `shared/project-run-scope.ts` | all environments pooled by default; PR feedback, quarantine candidates and MCP always pool |
| Analytics, rollups, environment comparison | `shared/handlers/analytics/*` | one row per spelling; rollup cells keyed by the text outlive the runs |
| Automatic markers | `shared/handlers/markers.ts` | each spelling is its own lineage |
| Notifications | `shared/notification-events.ts` | filters match exact text or a `*` pattern, case-sensitive |
| Issue automation, test management scope and run name | `shared/integrations/automation.ts`, `test-management-sync.ts` | scope misses; run names differ per spelling |
| CI actions | `shared/ci-actions.ts` (`pickCiAction`) | the action of the environment is not found; the default one is used |
| URL patterns, browser extension | `shared/handlers/url-patterns.ts` | the extension shows the label; nothing checks it |
| Quality reports, saved dashboards, exports | `shared/handlers/reports.ts`, `shared/analytics/dashboards.ts` | as analytics |
| AI context | `server/utils/ai-context.ts` | reaches the prompt only through the environment diff |

Eight settings and the markers keep their own copy of the names, with limits from 40 to 200 characters, and no route lists a project's
environments: each picker gathers the labels of the newest runs (200 on the project page, 30 on Analytics), so an
environment that did not run lately cannot be picked, and none offers "no environment". Nothing treats any environment
as the default one.

### Starting a run

No path lets the person choose an environment, a `baseURL` or an env file: the desktop app's runs, Reproduce, Bisect,
Flake Lab and a bug report's reproduction (`apps/desktop/src-tauri/src/runner.rs`, `worktree.rs`, `repro.rs`), **Run
on my machine** through the desktop app or Piwi Runner (`packages/core/src/run-request.ts`, `packages/editor/src/request-run.ts`),
and the editors (`packages/editor/src/server.ts`). Each applies the project's run variables, which hold one value per
project; [run-variables.md](run-variables.md) left "values per deployment environment" open. Every path refuses
`--config`. A Playwright project can be chosen only in a requested run, a bug report's reproduction and an editor's
debug run. The CI actions are the one place an environment picks something: the action whose `environment` equals the
run's label.

The project concepts page says it plainly: the environment is "a scoping dimension, not a configuration one". This
plan makes it both.

## Decisions

### D1. An environment is a record of the project

Each project keeps its own list of environments. Alternatives:

- **Values per environment label in the run variables**, with no record: it answers the launch, but the list to pick
  from would still come from the runs, so an environment could not be picked before a run reported it, and the eight
  copies, the variant labels and the missing default would stay.
- **Environments of the instance, shared by projects**: a project's Staging is its own deployment, with its own URL
  and variables. Cross-project views (Home, Analytics across projects, the environment comparison) group environments
  of the same key. A project copies another's environments instead (D14).
- **Playwright projects per environment** keep working as they are, where Piwi already lets the person pick a
  Playwright project: the environment is in the project's name. An environment sets variables only and never names
  Playwright projects (settled): a `--project` filter or a mapping of names (`chromium-staging` to
  `chromium-production`) would tie Piwi to one naming scheme.
- **A config per environment** stays out: a path to code is refused everywhere.

A multi-tenant app keeps one project per tenant ([run-variables.md](run-variables.md) D1): the tenant variable
stays on the project, the environment's variables add to it.

### D2. What an environment holds

| Field | Rule |
| --- | --- |
| `key` | 1 to 80 characters of `PLAIN_VALUE` (`@piwitests/core/run-variables`), unique in the project ignoring case. Renaming it keeps the old key as an alias. |
| `name` | 1 to 80 characters, shown everywhere. |
| `description` | up to 500 characters, for people and the AI diagnosis ("data reset every night at 02:00"). |
| `aliases` | up to 20 labels or `*` patterns, matched ignoring case. |
| `runVariables` | at most 10, the rules of run-variables D2 and D3. |
| URL patterns | the project's URL patterns move under their environment (`project_url_patterns.environment_id`). |
| `appFromCheckout` | whether the app under test is built from the run's checkout (D11). |
| `protected` | D9. |
| `requiredTags` | a protected environment's Playwright tags, 1 to 10, each `@` then letters, digits, `-` and `_` (D9). |
| `envFile` | an optional file name the config loads for this environment (D8). |
| `position` | the order pickers show (Local, Integration, Staging, Production). |
| `discovered` | true until a manager saves it (D3). |
| `archivedAt` | an archived environment leaves the pickers; its runs keep it. |

The project gains `defaultEnvironmentId` (D10). Set in **Project → Settings → Environments** with `project:manage`.

### D3. A run resolves to an environment when it is stored

The run keeps its label as it came (the wire stays a string) and gains `environment_id`, indexed with the project and
the start time. Resolution, in order, on the trimmed label: no label is no environment; then the key ignoring case;
then an alias, exact labels before patterns, in position order. A label nothing matches **creates a discovered
environment** with that key, so a project that never opens the settings gets a complete list, as Sentry does. At most
50 discovered environments per project, so a reporter key cannot fill the list with labels: past the cap the run keeps
its label and no environment.

A change of key or aliases resolves the project's runs again in a background task. The rollups stay keyed by the label
they counted, and their reads group the labels by environment, so the archived parts need no migration.

### D4. One list, referenced by id

- `GET /api/projects/:id/environments` lists them; every picker reads it, with **No environment** as an option of
  each filter.
- **URL patterns, markers and CI actions name one environment**: each keeps the label as written and the environment
  it resolves to (`environment_id`, `environmentId`), as a run does; a marker or a URL pattern written with a label
  resolves it as a run's label is. A startup pass gives the ones stored before their environment, creating
  discovered environments when needed.
- **Filters keep keys and patterns, never ids** (settled while building): notification filters, issue automation and
  test management scopes, report schedules, saved dashboards, Analytics and the project's status filter. A setting
  that spans projects (a subscription to every project, a dashboard, a report) cannot hold one project's ids, and a
  renamed key stays an alias. A key or pattern matches a run through its environment: the environment's key or one of
  its exact aliases, ignoring case; a run whose label has no environment, by its label.
- **A filter keeps its `*` patterns** (settled): a notification filter or an issue automation scope holds picked
  environments and patterns, a pattern matching an environment's key or one of its aliases ignoring case, so an
  environment created later (`prod-eu-2`) is included, as it is today. Only aliases and filters take patterns.
- **Deleting an environment a URL pattern or a CI action names is refused** (settled while building): they would then
  apply to every environment. Archiving keeps them. Runs, run requests and markers keep their label; a project whose
  default it was reads every environment; a discovered environment a declared one takes over hands it what named it.
- The API's filters keep taking a key (`?environment=staging`), resolved like a label, so scripts, the quality report
  CLI and the MCP tools keep working.

### D5. The environment of a run Piwi starts

- **The variables**: the project's run variables, then the environment's, a name set by both taking the
  environment's value; at most 20 together, checked as one list by `parseRunVariables`, which refuses the whole list
  on any problem as today.
- **The label**: Piwi sets `PIWI_ENVIRONMENT` to the key, as its own variable (run variables still refuse `PIWI_`).
  The config's `environment` option wins over it, as it does today.
- **None** is always offered: Piwi applies the project's run variables only and sets no label, the behavior of today.
- The choice shows in the command the person sees before the run (`TEST_ENV=staging npx playwright test …`), as run
  variables do.

The config pattern the docs show next to the setting:

```ts
import { config as loadEnv } from 'dotenv';
import { defineConfig } from '@playwright/test';
import { wrapConfig } from '@piwitests/reporter';

const testEnv = process.env.TEST_ENV ?? 'local';
loadEnv({ path: `.env.${testEnv}` }); // this environment's secrets, never committed

export default wrapConfig(
  defineConfig({
    use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000' },
    webServer:
      testEnv === 'local'
        ? { command: 'npm start', url: 'http://localhost:3000', reuseExistingServer: !process.env.CI }
        : undefined,
  }),
  { environment: testEnv },
);
```

With it, Piwi's Staging holds `TEST_ENV=staging` and `envFile: .env.staging`; CI sets `TEST_ENV` and the secrets
itself. `dotenv` never overrides a variable already set, so Piwi's values win over the file.

### D6. Each path that starts a run

| Path | Chosen by default | Where the person changes it |
| --- | --- | --- |
| Desktop Re-run, Run again | the run's environment, unless protected | **Run with options…** |
| **Run with options…**, a bug report's reproduction | the last one picked for the folder, kept on the machine | its picker |
| Reproduce | the failing run's environment, unless protected | its picker |
| Bisect | an environment built from the checkout (D11) | its picker, which says what a deployed one can find |
| Flake Lab | the environment the test flaked most in | its picker |
| Run on my machine (desktop app, Piwi Runner) | the environment of the run the page shows | the page, before asking; the confirmation shows it |
| Editors | the last one picked for the workspace folder | a status bar item and a **Piwi: Choose environment** command |
| Copied commands | the environment of the run the page shows, else none | a picker beside the shell picker of the command block |
| CI re-run | the CI action of the run's environment, as today, by id | unchanged |
| An agent's run request | the key it names | never a protected one |

**Run on my machine** keeps the request free of environment variables: the instance stores the environment on the
request row, never in the `RunRequest` an older target's parser would refuse, and
`GET /api/run-targets/requests/:id/run-variables` answers the merged list with `environment: { key, name, protected }`.
A target that applies environments says so with its claim (`features: ['environments']`, as `run-variables` does); a
claim without it, of a request naming an environment, answers 409 and leaves the request to an updated app.

The desktop app, the editor service and the targets check the merged list again and pass it as the process's
environment, never through a shell line, as [run-variables.md](run-variables.md) D5 to D7 do. The editors' **Allow**
question covers each new set, an environment's included.

### D7. The run says where it went

The label a run reports is the config's word on where it sent its requests, so Piwi never overwrites it. Two checks
make a mismatch visible on the run page and on the run's line in the desktop app:

- the environment the run was started for (the request row, the desktop job) against the one its label resolves to:
  "Started for Staging; the config reported production";
- the run's `baseURL` origins (`runBaseUrls`, `shared/graph`, already read by the environment incidents) against the
  environment's URL patterns: "Started for Staging; the tests opened http://localhost:3000". This one also catches a
  config that ignores the variable.

### D8. Secrets stay on the machine

An environment holds no secret: its values show in commands and confirmations, as run variables do. A secret stays in
the machine's own file (`.env.staging`, ignored by git) or in the CI's secret store. The environment may name that
file (`envFile`, a name matching `^\.env(\.[A-Za-z0-9_-]+)*$`, no folder), which Piwi never reads nor sends:

- the desktop app's folder check says when the file is missing in the linked folder;
- Reproduce, Bisect and Flake Lab copy it from the linked folder into their worktree, which lacks every untracked
  file, and delete it with the worktree.

Supplying secrets from the instance (the credential manager) is not in this plan.

### D9. Protected environments (settled)

A protected environment (production, as a rule) holds at least one required tag. Every run Piwi starts against it:

- **is confirmed**: the person confirms with the environment's name shown, in the desktop app, in a target's
  confirmation and in the editors' question, and the desktop shell and a target refuse a protected environment whose
  key the person did not confirm for that run;
- **runs only the tests carrying one of its required tags**: the path adds one `--grep-invert` that leaves out every
  test carrying none (`requiredTagsGrepInvert`, merged with the run's own `--grep-invert`), and the command shown
  carries it. Playwright still runs the setup and teardown projects the selected tests depend on, whole: every
  confirmation says so. A Reproduce that would select no test stops with words, never a verdict; Bisect, Flake Lab and
  a bug report's reproduction never run against a protected environment; a copied command that cannot take the
  filter (a Flake Lab command) is never offered for one. On Windows, the editors start a protected run with the
  folder's Playwright CLI under `node`, so cmd never reads the filter;
- **is started by a project manager only**: the instance answers a protected environment's variables, and takes a
  request naming it, only for someone holding `project:manage` on the project; the desktop app's own server has one
  person, who manages its projects;
- **is never a default**: a re-run of one of its runs starts with **None**;
- **is never an agent's**: an agent's request naming it is refused.

These rules govern what Piwi starts. A command typed in a terminal stays the person's: the command block offers a
protected environment to managers only, since it reads the variables the same way, and its command carries the
required tags.

### D10. The default environment

`projects.default_environment_id`, unset by default, which keeps today's "all environments". When set, the views that
read the default branch by default (the flaky list, Analytics, the project tabs) also read the default environment,
the filter showing it; and so do the analyses that pool every environment today: PR feedback's "already flaky on the
default branch", quarantine candidates and their release streaks, and MCP's `list_flaky_tests`. A run with no
environment counts only under **All environments**.

Built with two exceptions. The release streaks of quarantined tests still read every environment: a quarantine
silences a test in every environment, so a pass in the default one must not release it. The Environment comparison
widget compares every environment unless some are picked. The project's status filter keeps its own scope.

### D11. Built from the checkout, or deployed

Several features take the run's commit to be the code under test. It is true only for an environment built from the
checkout, which an environment is until a manager marks it deployed (settled while building, so an upgrade changes
nothing for a label the runs report):

- **Bisect** walks the commits of the tests' repository. Against a deployed environment it can find a change of the
  tests, never one of the application: the dialog says so, and its picker starts on an environment built from the
  checkout.
- **Suspect lines** and **change coverage** read the application's lines at the **deployed commit** below, and say
  that the deployed version may differ from the run's commit when it is unknown.
- **The baseline's "what changed"** adds, for a deployed environment, the application's commits between the
  baseline's deployed commit and the run's (the commit range the Changes tab builds, `buildCommitRange`), else the
  application versions the server snapshots saw, and the deploy markers between the two runs. The AI diagnosis reads
  the same, with the environment's name and description.
- **The first failing deploy**: a failure cluster of a deployed environment names the deploy marker between its last
  passing run and its first failing one, as bisect names the first bad commit of an environment built from the
  checkout.
- **Pass reuse** ([pass-reuse.md](../proposals/pass-reuse.md)) fingerprints the environment by id and, for a deployed one, by its
  deployed commit, else its application version: a pass against yesterday's Staging says nothing about today's
  deploy. Without either, a deployed environment's passes are not reused.
- **The environment's page** in the settings lists its recent deployed commits and application versions, its last
  run and its last environment incident.

**The deployed commit** (settled) comes from two sources, the first that answers winning:

1. **The server snapshot** gains an optional `appCommit` (`ServerEnvironmentResponse` and `WireServerEnvironment` of
   `@piwitests/core/wire`: an addition an older dashboard ignores, `v: 1` kept). The ASP.NET Core package takes it
   from its option, else `PIWI_APP_COMMIT`, else the part after `+` of the entry assembly's informational version,
   where the .NET SDK writes the source revision. The Nitro package takes it from its option, else
   `PIWI_APP_COMMIT`, else the commit variable of the hosting platform it runs on (`VERCEL_GIT_COMMIT_SHA`,
   `RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`, `SOURCE_COMMIT`). Nitro sends `appVersion: null` today, and gains
   the same option and variable (`PIWI_APP_VERSION`) for it.
2. **A deploy marker** gains a `commit`: the deploy pipeline posts it (`POST /api/projects/:id/markers`, category
   `deploy`, the environment's key, the commit), for an application with no instrumentation package. The run takes
   the commit of the environment's latest deploy marker before it starts. The docs show the step for GitHub Actions
   and GitLab CI.

A commit is 7 to 40 hexadecimal characters: a server snapshot's other value is ignored, and the markers routes refuse
one. The application is assumed to live in the project's repository, the one its token reads (settled while building):
its commit range, suspect lines and diffs are read there, and an application kept elsewhere shows its deployed commit
and no range. Change coverage says when the deployed commit is not the run's; it does not credit the deployed commit.

### D12. The integrations

- **URL patterns** belong to an environment; the browser extension shows its name.
- **Markers** reference an environment; a deploy pipeline posting a marker names it by key.
- **Notification filters**, **issue automation** and **test management scopes** pick environments from the list.
- **Test management**: each environment maps to the tool's environment name (Zephyr Scale's `environmentName`, an Xray
  test environment), its own name by default. Not built (see Status).
- **CI actions** reference an environment by id.
- **Environment incidents** are read through the environment's runs and incident markers, and their notification
  names it.
- **MCP**: a `list_environments` tool; an environment filter on `list_runs` and `list_flaky_tests`.

### D13. The desktop app offers the team project's environments (settled)

The desktop app's local runs report to its own server, whose projects are not the team instance's. When a folder is
also linked to a team project (the link **Run on my machine** uses), the pickers of D6 in the desktop app offer that
team project's environments, read-only, beside the desktop project's own:

- the shell reads them, and the merged variables of the one picked, from the team instance at each run, with the
  target key (the routes below); the list is changed on the team instance only;
- with a team environment picked, the variables are the team project's run variables and the environment's; with
  **None** or one of the desktop project's environments, the desktop project's, as today;
- when the team instance cannot be reached, its environments cannot be picked, and the picker says why: no copy is
  kept, so a run never applies values the team has since changed;
- the run reports the key as its label to the desktop app's server, which resolves it like any label (D3).

A folder with no team project keeps the desktop project's own list.

### D14. Copying environments from another project (settled)

**Copy from another project**, in **Project → Settings → Environments**, copies the environments of a project the
person can read into one they manage: key, name, description, aliases, run variables, built from the checkout,
protection and required tags, env file and position, and the default environment when the project has none. URL
patterns are not copied: they name the project's own site. An environment whose key the project already has is left
as it is, and listed. The copies belong to the project from then on: nothing links them to their source, and a
tenant's `BASE_URL` is edited on each copy.

## The instance's routes

- `GET /api/projects/:id/environments` (`project:read`): the list and `defaultEnvironmentId`.
- `POST /api/projects/:id/environments`, `PATCH` and `DELETE /api/projects/:id/environments/:environmentId`
  (`project:manage`). Deleting one sets its runs' `environment_id` to null; their label stays.
- `GET /api/projects/:id/run-variables?environment=:environmentId`: the merged list of D5, with the environment's
  `protected` and `requiredTags`; 403 for a protected environment without `project:manage`.
- `GET /api/run-targets/projects/:id/environments` and `GET /api/run-targets/projects/:id/run-variables?environment=`
  (target key, for a project its owner can read): what the desktop app reads for D13, under the same rules.
- `POST /api/run-requests` takes `environmentId` (403 for a protected one without `project:manage`, refused for an
  agent); `GET /api/run-targets/requests/:id/run-variables` answers the
  merged list and the environment; the claim takes the `environments` feature.
- `POST /api/projects/:id/environments/copy` (`{ fromProjectId }`, `project:manage` on the project, `project:read` on
  the source): D14, answering the environments copied and those left as they were.
- `POST /api/projects/:id/markers` and `PATCH /api/markers/:id` take `commit` (D11).
- Run responses gain `environmentId` beside `environment`, the label. The demo's handlers and seed mirror them.

## Security

- **Who sets them**: a project's managers. What they set reaches teammates' machines, so an environment's variables
  follow every rule of [run-variables.md](run-variables.md) (plain values, refused names, shown before applying,
  checked by every target).
- **The key reaches a process** as `PIWI_ENVIRONMENT`, so it follows the value rules of a run variable.
- **The env file** is a name, never a path; Piwi copies it only between two folders of the same machine.
- **Discovery is capped** (D3), since any key that may report runs may report any label.
- **Protected environments** are never a default, always confirmed, limited to their required tags, started by a
  project manager only, never an agent's. The instance enforces the manager rule on the routes that answer an
  environment's variables and take a request; each target enforces the tags and the confirmation, and checks the tags
  again in the command it runs.

## What changes in other records

- [run-variables.md](run-variables.md): its open questions "values per deployment environment" and "the
  desktop app's own projects" are answered by D5 and D13.
- [run-on-my-machine.md](../proposals/run-on-my-machine.md) D3: a request may name an environment of its project, kept on the
  request row, never in the request a target parses.
- [1.0-stabilization.md](../proposals/1.0-stabilization.md): a new entry for the environment routes, `environmentId` on runs, the
  `environments` claim feature and `PIWI_ENVIRONMENT` set by Piwi.
- [pass-reuse.md](../proposals/pass-reuse.md): the fingerprint's target environment is D11's.
- [1.0-stabilization.md](../proposals/1.0-stabilization.md) D65: the server snapshot gains `appCommit`, an addition to its frozen
  field list; the markers routes gain `commit`.
- The docs' **Environment** concept stops saying "not a configuration one".

## Delivery

1. **Environments as records**: the table and `environment_id`, resolution and discovery, the list route, the
   settings section, the pickers with **No environment**, the migration of the eight settings, `list_environments`,
   the demo's seed. Alone it fixes the variant labels and the incomplete pickers.
2. **Choosing where to run**: an environment's run variables and `PIWI_ENVIRONMENT`, the pickers of D6 on every path,
   the claim feature, the copied commands, protected environments, the env file, the checks of D7, the team
   project's environments in the desktop app (D13). This is the step
   the asking team needs; steps 1 and 2 can ship together.
3. **Analysis**: the default environment (D10), D11's effects on bisect, suspect lines, the baseline's changes, pass
   reuse and the AI diagnosis, the deployed commit in both instrumentation packages and on deploy markers, the first
   failing deploy.
4. **Integrations**: the test management mapping, incidents on the environment, the rest of D12, the copy of D14.

## Open questions

None: the six raised while writing this plan were settled on 2026-11-18 (see Status).

## Not in this plan

- Secrets supplied by the instance to runs.
- Deploying or provisioning an environment: Piwi records deploys (markers, server snapshots), it does not make them.
- A config file per environment.
- An environment naming Playwright projects (D1).
- Environment templates of the instance that projects inherit (D14).
