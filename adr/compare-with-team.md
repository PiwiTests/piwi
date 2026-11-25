# Compare a local failure with the team instance

- Status: accepted
- Date: 2026-11-25

A plan to let a person who sees a test fail in the desktop app find out, from the same page, whether the failure comes
from their machine: how the test does in the team's CI, whether the team instance already knows the same error, and
what differs between their run and the CI's. It also opens the same test on the team instance in one click. It asks
the team instance for this through the connection **Run on my machine** made, which today can only receive runs.

**Status.** Proposed and settled 2026-11-25, shipped in one pull request in three parts. PR 1: the `team-comparison`
capability, on by default and declined on Settings → Capabilities or in a project's settings; `project:read` on every
key the device flow gives a desktop app, the route refusing each comparison an instance or a project declines
(`TEAM_COMPARISON_OFF`); `requireRunTarget` taking each route's own permission; and `GET
/api/run-targets/projects/:id/test-comparison`, with register entry D70. PR 2a: the desktop app's server asks the team
instance through the request host (`compare`), checks the answer, keeps it two minutes and answers `GET
/api/desktop/team/executions/:id/comparison` and `…/test-cases/:id/comparison` with the history in rows by environment,
the conclusion and the environment diff against the closest CI pass. PR 2b: the device flow connects a desktop app for
the comparison alone where `machine-runs` is off, and its verification page says what the app will do there. PR 3: the
**Team CI** line of the execution page's situation block, its side panel of environment differences, the **Team CI**
card of the test page, the capability on the ladder, and the docs page. The maintainer settled on 2026-11-25: one
connection and one key, with a read permission beside `run:receive` (D1); a capability on by default, labeled **Compare
with team instance** (D2); the CI as the only reference, the team's other shared runs shown apart, every environment of
the team project listed (D3); sign-in required (D10); all four parts in the first version (D5 to D8); the comparison
next to the history of the execution page (D9). Two choices changed during the build: every desktop key holds
`project:read` whatever the instance decides, so a decline holds over every key (D1); and the team's history is its own
**Team CI** line right under **History**, rather than rows inside it, so the two histories read apart (D9). After the
final review, the conclusion reads the local environment as the team instance resolved its label, rule 1 reads a recent
sight of the error in that environment, rule 2 the latest CI result on the commit, and the keys that always differ
between a machine and the CI show as varying naturally. Left out: the desktop end-to-end test against a fake team
instance that Delivery item 3 lists, since unit tests drive the routes against a fake instance and the screenshot scenes
render the screens from a canned answer; and, as **Not in this plan** says, the comparison of a whole local run, an MCP
tool, and reading an instance without sign-in.

## Summary

- **One question, answered on the page where it comes up.** A test failed in the desktop app: is it this machine, or
  does the CI see it too? The execution page answers in one line, with the facts behind it.
- **Four parts.** A link that opens the same test on the team instance; the test's recent CI results; whether the team
  instance already holds the same error in a failure cluster; what differs between the local execution and the closest
  CI pass (time zone, locale, browser, headless, versions, uncommitted changes), with the environment diff the
  execution page already has.
- **The connection Run on my machine made, extended.** The key the device flow gives the desktop app also holds
  `project:read` when the instance offers the comparison, and reads one route of the team instance: what its owner
  could read in a browser, and nothing else.
- **Little leaves the machine.** The desktop app sends the test's identity, the error's fingerprint, the commit and
  the branch. The team instance answers the CI's facts, and the desktop app compares them with its own run locally: its
  host name, OS and versions never leave it.
- **No verdict from a model.** The conclusion follows a few written rules, in order, and says which one applied.

## Terms

| Term | Meaning in this document |
| --- | --- |
| **team instance** | A Piwi server that several people and CI report to. The desktop app connects to at most one. |
| **connected app** | A desktop app or Piwi Runner connected to a team instance by the device flow (Settings → Desktop app). |
| **target key** | The key the device flow gives a connected app (its name in the code). It holds only the permissions listed on it and is taken by the `/api/run-targets/*` routes alone. |
| **team project** | The project of the team instance that a desktop project's folder is also linked to, the link Run on my machine uses. |
| **reference runs** | The team project's runs a conclusion reads: the CI's (`ci`, `ci-rerun`). |
| **closest CI pass** | The passing CI execution of the same test and Playwright project that the local one is compared with: in the local run's environment on its commit, in its environment, on its commit, then any (D8). |
| **comparison** | What the team instance answers for one test, and what the desktop app shows from it. |

## What exists

| Piece | Where | What this plan takes |
| --- | --- | --- |
| The connection | Device flow (`server/utils/extension-connect.ts`), Settings → Desktop app, `run_target.rs` | One team instance at a time, the key in the OS keychain, handed to the bundled server at each start (`hand_kept_key`), never to the window. |
| The key's permissions | `RUN_TARGET_KEY_PERMISSIONS` (`['run:receive']`), `requireRunTarget` (`server/utils/run-requests.ts`) | A key holding a list of permissions serves the target routes alone (`requireAuth` refuses it). The check asks for that exact list. |
| The device flow's gate | `server/api/extension/connect/decision.post.ts` | A target connects only with sign-in on, `run:receive` held somewhere and `machine-runs` on. |
| A read with the target key | `GET /api/run-targets/projects/:id/environments` and `…/run-variables` | The desktop app already reads its team project's environments this way, at each use, with no copy kept ([environments.md](environments.md), D13). |
| Folder links | `team_project_of_folder` (`run_target.rs`), `hand_links`, the discovery file's `projects` (`server/utils/desktop-links.ts`) | The bundled server can go from a local project to its folder, and from the folder to the team project. |
| Test identity | `test_cases`: `externalId`, else `filePath`, `suitePath`, `title` | The rule ingestion matches a test by. Local and CI runs of the same config give the same values. |
| Error fingerprint | `computeErrorFingerprint`, `FINGERPRINT_VERSION` (`shared/error-fingerprint.ts`), `failure_clusters`, `failure_cluster_aliases` | The same hash on every server of the same version, so a fingerprint finds a cluster without the error's text. |
| Environment snapshots | `WireRunnerEnvironment`, `WireBrowserEnvironment`, `WireServerEnvironment` (`@piwitests/core/wire`, register D65) | Time zone, locale, `LANG`, OS, architecture, Node, ICU, CI image, container, CPU, memory, and per browser its version, time zone, locale, headless: the usual causes of a failure on one machine. |
| Environment diff | `buildEnvironmentSnapshot`, `computeEnvironmentDiff` (`shared/environment-diff.ts`), `getEnvironmentDiff` (`server/utils/environment-diff.ts`), `EnvironmentDiffCard.vue` | The execution page already compares a failing execution with the same test's last pass, over one registry of keys. This plan compares with the closest CI pass the same way. |
| Commit state | `commit_sha`, `branch`, `scm.worktree` (`clean` or `dirty`) in the run metadata | Whether the local run is on a commit CI ran, and whether its checkout matched it. |
| Run origins | `CI_RUN_ORIGINS`, `LOCAL_RUN_ORIGINS`, `PRIVATE_RUN_ORIGINS`, `LAB_RUN_ORIGINS` (`shared/run-eligibility.ts`) | Which runs are reference runs, which are shown apart, which are left out. |
| History on the execution page | Being moved to the top of the page, with a side panel (`Toolbox.vue`), on branch `claude/brave-carson-kown6r` (not merged) | The place the comparison goes (D9). |

## The flow

A test fails in the desktop app on a developer's laptop. The CI ran it overnight on `main`.

1. On the execution page, the history block shows two rows: this machine's results and the team CI's, for the same
   test and Playwright project.
2. The situation block's new line reads: "Passes in CI on this commit: the failure is likely specific to this
   machine", with the rule it applied.
3. Beside the occurrences, "Never seen in CI" (or "Same error in CI: 12 times since Tuesday", a link to the cluster).
4. The side panel lists what differs from the closest CI pass: "Time zone: Europe/Paris here, UTC in CI", "Headless:
   no here, yes in CI", "Playwright version: 1.58 here, 1.60 in CI", and "Your checkout has uncommitted changes".
5. **Open on the team instance** opens the test's page there, in the browser.

## Decisions

### D1. One connection, one key, two permissions (settled)

The device flow keeps making one key per connected app. The key holds `run:receive`, and a desktop app's also
`project:read`, whatever the instance decides of the comparison: the route refuses each comparison an instance or a
project declines (D2), so a decline holds over every key, made before it or after, and connecting again is never the
way out of one. Piwi Runner's key never holds `project:read`: it has no page to show a comparison (D11).

- `requireRunTarget` takes a key whose list holds only target permissions (`run:receive`, `project:read`), at least
  one, and each target route checks the one it needs, declared in its `x-required-permission`. A key with any other
  permission, or with its owner's access, is still refused, and `requireAuth` still refuses a target key everywhere
  else.
- The confirmation page of the device flow says what the app will do for the person on that instance: take their run
  requests, compare, or both (`receives`, `compares`).
- Connected apps (Settings → Account) shows what each key may do.
- A key made before this plan holds `run:receive` alone. The comparison route answers 403 with its own error code, and
  the desktop app's Settings → Desktop app says **Reconnect to compare**.

Why: one connection to make, to revoke and to explain. A second key would double the device flow, the keychain entry
and the Connected apps rows for one app. Putting the comparison under `machine-runs` would tie two features an
administrator may want apart.

### D2. A capability on by default (settled)

A new capability, `team-comparison`, labeled **Compare with team instance**, at the instance and project levels, **on
by default**, and `hiddenOnDesktop` as `machine-runs` is. It sits on the capability ladder of Settings → Capabilities
like any capability on by default: active once a desktop app holds a key that may compare, and declined there by an
administrator, or by a project in its settings. The route refuses a project that declines it.

The device flow's gate accepts a target when sign-in is on and its owner may use at least one of the two
capabilities: `run:receive` held somewhere with `machine-runs` on, or `project:read` held somewhere with
`team-comparison` not declined.

### D3. The CI is the reference; the team's other runs are shown apart (settled)

- **Reference runs**: `CI_RUN_ORIGINS` (`ci`, `ci-rerun`), of every environment and every branch of the team project:
  a project whose CI runs the suite against `mco` and `integration` shows both. The conclusion (D8) reads these alone.
- **Shown apart**: the shared runs of `LOCAL_RUN_ORIGINS` (`local`, `desktop`, `editor`) that teammates report to the
  team instance, as a third row of the history block, never counted in the conclusion: their machines are not the
  reference.
- **Left out**: every other origin, among them `PRIVATE_RUN_ORIGINS` (a requested run is its requester's alone),
  `LAB_RUN_ORIGINS` and `INVESTIGATION_RUN_ORIGINS`.

### D4. Finding the same test on the team instance

**Recommended.** The desktop app sends the local test's `externalId`, `filePath`, `suitePath`, `title` and Playwright
project. The team instance matches as ingestion does: the `externalId` first, then the three fields. No partial or
fuzzy match: a test the instance does not hold answers "Not on the team instance", with the likely reasons (a new
test, a renamed one, another config in CI). The Playwright project narrows the executions; when CI has none for it,
the comparison uses the test's executions of every project and says so.

### D5. Open on the team instance (settled, first version)

The comparison's answer carries the URLs of the team's test page, of the closest CI pass, of the latest CI execution
and of the matching cluster. The desktop app opens them in the system browser through the shell's opener: the main
window navigates only to its sidecar's origin (`main_window_may_navigate`), and nothing about that rule changes.

### D6. The test's CI history (settled, first version)

The answer carries the test's recent results: the reference runs', then apart the teammates' shared local runs', and
the reference results on the local run's commit even when they are older. Each result is a final attempt with its
status, flaky verdict, date, environment, branch, commit, Playwright project and a link. It also carries the test's
quarantine state and flaky root cause, and the team project's default branch.

The answer also holds the latest results of each environment the CI ran the test in, so a busy one never hides the
others, and marks the runs of an environment incident, which the conclusion leaves out. The desktop app groups the
results **by environment**: one row for each environment the CI ran the test against
(`mco`, `integration`), the local run's environment first when it has one, then the shared local runs. Each row has
its pass rate and flaky rate (`passRate`, `flakyRate`) and shows each result's branch and commit, so a team whose
long-lived branches stand for its environments reads them the same way. Two deployed environments do not run the same
application, so a row never mixes them.

### D7. The same error in CI (settled, first version)

The desktop app sends the local execution's fingerprint and the `FINGERPRINT_VERSION` it was computed with. The team
instance looks it up in the team project's clusters and aliases and answers the cluster: its title, its state, its
reference occurrences (count, first and last seen) and how many tests it touches.

- **Different versions**: when the instance's `FINGERPRINT_VERSION` differs, it answers that the error cannot be
  compared, never "Never seen in CI".
- **The error's text never leaves the machine.** Sending the fingerprint's sample so the instance can hash it again is
  left for later, behind its own decision.

### D8. Environment differences and the conclusion (settled, first version)

The environment differences reuse the execution page's environment diff, with no second registry of keys:

- **The team instance picks the closest CI pass**: a passing reference execution of the same test and Playwright project
  (`browserName`), in this order: in the local run's environment on its commit, in its environment, on its commit, then
  any, each on the local branch first, then the most recent. The environment comes before the commit: two deployed
  environments do not run the same application. The local environment is resolved as a run's label is (its key or an
  alias), and a CI run is read by the environment its label resolved to.
- **It answers that execution's snapshot** (`buildEnvironmentSnapshot`: the registered keys only, with the inferred
  ones marked), its commit and its `scm.worktree`.
- **The desktop app diffs it against its own execution's snapshot** with `computeEnvironmentDiff` and shows it with
  `EnvironmentDiffCard`, informational keys (worker, shard, host name) de-emphasized as today. The local snapshot never
  leaves the machine.

The conclusion is a line of the situation block. When the local run has an environment, it reads the reference
results of that environment alone; otherwise all of them, and the line names the environments it read. It comes from
the first rule that applies:

1. The same fingerprint has reference occurrences: "Same error in CI: not specific to this machine".
2. The test passed in CI on the local commit and the local checkout is clean: "Passes in CI on this commit: the failure
   is likely specific to this machine". With uncommitted changes, it says so instead.
3. The test fails in CI with another error: "Fails in CI too, with another error".
4. The test passed in CI on another commit: "Passes in CI on `main`, N commits away": no conclusion, the commits
   differ.
5. No reference result: "No CI result to compare with".

The rules live in `shared/` as one pure function, unit-tested rule by rule. The environment differences are listed as
facts, never as the cause.

### D9. Where it shows (settled)

In the execution page's layout, where the test's **History** is a line of the situation block and the side panels
hold what does not fit it:

- **A Team CI line** (`teamCi`, an entry of `SITUATION_ROWS` right after `history`) holds the conclusion, with a link
  to the cluster of the same error (D7) or to the CI run it read, then one strip per CI environment and one for the
  teammates' shared runs (D3), each with its pass rate, then **Open on the team instance**.
- **The environment differences** (D8) open from that line in a side panel of their own, with a link to the closest
  CI pass on the team instance.
- When the app cannot compare, the line says why in one sentence (a key to replace, a comparison refused, an instance
  that did not answer), and shows nothing while the app is connected to no team instance or the project's folder is
  linked to no project of it: the comparison is not set up, which is no problem. The line shows on a failed or
  timed-out execution alone.

The test page (`test-cases/[id]`) shows the team's CI history and the link, with no conclusion: it has no single
execution to compare. Pages show the comparison only in the desktop shell (`useIsDesktop`), for a project whose folder
has a team project.

### D10. Sign-in required (settled)

As for Run on my machine, the connection needs sign-in on the team instance: the key belongs to a user. Without it,
the desktop app cannot connect, and the history block shows no team row. Reading an instance without sign-in is not in
this plan.

### D11. The desktop app only

**Recommended.** Piwi Runner has no test page. Its key never holds `project:read`, and its host serves no comparison
route.

### D12. Through the bundled server, never kept

**Recommended.** The bundled server asks the team instance: it holds the key already (`hand_kept_key`), knows the
folder links (`hand_links`, `desktop-links.ts`), and its TypeScript is unit-tested and shared with the conclusion's
rules. Its route sits behind the desktop guard. Each answer is kept in memory for two minutes per team project, test
and fingerprint, and never written to disk. When the team instance cannot be reached, refuses, or the key lacks
`project:read`, the page says why, as the environment pickers do (`teamProblem`). A redirect to another origin never
carries the key, since `fetch` drops the `Authorization` header there, and the call follows `HTTPS_PROXY`,
`HTTP_PROXY` and `NO_PROXY` as the device flow does. An answer serves the connection that read it alone: a disconnect,
a revoke or another key forgets it (`runTargetGeneration`).

## The routes

The team instance:

- `GET /api/run-targets/projects/:id/test-comparison`, with the test's identity (`externalId`, `filePath`, `suitePath`,
  `title`), `playwrightProject`, `environment`, `fingerprint`, `fingerprintVersion`, `commit` and `branch` in the query.
  Target key only, `x-required-permission: project:read`, refused (403) when the key lacks `project:read`
  (`RUN_TARGET_KEY_CANNOT_COMPARE`), the owner cannot read the project, or the instance or the project declines
  `team-comparison` (`TEAM_COMPARISON_OFF`). It answers `{ testCase, defaultBranch, history, cluster,
  fingerprintComparable, closestPass }`, each null when there is none; `closestPass` holds the execution's snapshot
  values, inferred keys, commit and `worktree`. The answer names pages by their path on the instance (`/test-cases/12`):
  the desktop app adds the address it connected to. The demo has no connected app that calls it, so the route has no
  demo handler.

The desktop app's bundled server, behind the desktop guard:

- `GET /api/desktop/team/executions/:id/comparison`: the comparison of a local execution, with the conclusion and the
  environment differences computed locally, or the reason there is none.
- `GET /api/desktop/team/test-cases/:id/comparison`: the comparison of a local test, history and link only.

## Security

- **The key reads what its owner reads, through one route.** `project:read` on a target key opens the comparison route
  alone: never `/api/test-runs`, the files or the traces. A key taken from the keychain reads summaries of the projects
  its owner can read, until it is revoked in Connected apps.
- **What leaves the machine**: the test's identity, the fingerprint and its version, the commit and the branch. The
  error's text and the local environment snapshot (host name, OS, time zone, versions) stay local: the desktop app
  compares them itself.
- **What comes back is what the owner could read in a browser**: the CI execution's snapshot is the one the team's
  execution page already shows them.
- **The window never holds the key.** It asks the bundled server, which asks the team instance.
- **Links open outside the window.** The team instance's pages open in the system browser; the main window's
  navigation rule is unchanged.
- **Revocation is unchanged**: `key-revoked` forgets the key, and the page offers to connect again.

## What changes in other records

- [`1.0-stabilization.md`](../proposals/1.0-stabilization.md): a new entry, D70, for the route and its answer's fields,
  the target key's permissions (`run:receive`, `project:read`), the `team-comparison` capability and the 403 error code
  of a key without `project:read`.
- [`run-on-my-machine.md`](../proposals/run-on-my-machine.md): the connection's key may hold `project:read` beside
  `run:receive`, and the device flow's gate accepts either capability.
- `apps/desktop/AGENTS.md`: the rule on the instance's key names the bundled server's comparison routes as its other
  use.
- The docs: the desktop app's feature page, a section on comparing with the team instance, and the Run on my machine
  page's connection section.

## Delivery

The execution page is being reorganized on another branch (`claude/brave-carson-kown6r`, history at the top, a side
panel). The first two pull requests touch no page and start now; the third waits for that branch to merge.

1. **The team instance.** The `team-comparison` capability; `project:read` on the keys the device flow
   makes for a desktop app; `requireRunTarget` taking a list of
   target permissions and each route checking its own; the confirmation page and Connected apps saying what a key may
   do; the comparison route; the register's D70; the demo's connected app; unit tests for the key rules, the route's
   refusals, the test match, the history, the fingerprint lookup and the closest CI pass. The device flow's gate keeps
   asking for `machine-runs`: a desktop app of this release reads a key without `run:receive` as broken.
2. **The desktop app**, in two parts.
   - **2a, the desktop app reads the comparison.** The request host's `compare` and `compares`; the two routes behind
     the desktop guard, the call to the team instance with the key, the check of its answer, the two-minute cache, the
     conclusion's rules and the history rows in `shared/` (pure, unit-tested), the environment diff against the closest
     CI pass, and **Reconnect to compare** on Settings → Desktop app. A unit test drives them against a fake team
     instance.
   - **2b, a connection for the comparison alone.** The gate accepting a desktop app whose owner may compare where
     `machine-runs` is off, and the verification page saying what the app will do for that person there. The key
     keeps both permissions: with `machine-runs` off, the target routes offer no request, and the request host's
     stream stays open with nothing on it.
3. **The pages**, once the execution page's layout has merged. The history block's team rows, the situation line, the
   same error beside the occurrences, the side panel's section, the link, the test page's team history; the
   capability on the ladder of Settings → Capabilities (its detection: a desktop app's key that may compare); a
   desktop E2E test against a fake team instance; the docs with their screenshots.

## Open questions

1. Whether the conclusion should also show on a passing local execution that fails in CI ("Passes here, fails in CI").
2. How many results each environment's row shows when the side-by-side rows leave less room than the history strip has
   today.

## Not in this plan

- The same comparison for a whole local run (which of its failures happen only here).
- An MCP tool that answers the comparison to an agent, and a section of the AI diagnosis context.
- Reading a team instance without sign-in.
- Sending the error's sample when the fingerprint versions differ.
- Sending local runs to the team instance.
- Piwi Runner.
