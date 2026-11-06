# Run on my machine

A plan to let a person start, from a page of the team instance, a Playwright run of the tests they are looking at, on
their own machine, in a browser window they can see; follow it from the page; and file what they found as an issue
with their own comment. It answers [#1163](https://github.com/PiwiTests/piwi/issues/1163), asked by a team whose QA
engineers read CI failures on a team instance and have no way from that page to their own machine.

It merges two records: a first analysis written for the maintainer, and `proposals/local-runner.md`, which the issue's
author (balaji8385) wrote in the repository's format on their fork (commit `bcc65c5`). From the latter it takes the
claim of a request, the polling fallback, the demo's simulated target, the outbox marker of an issue, the `workers`
option and entry D64 of the 1.0 register.

**Status.** Proposed 2026-11-06. Nothing is built, and nothing here is on [`ROADMAP.md`](../ROADMAP.md) yet. The
maintainer settled on 2026-11-06: the desktop app and Piwi Runner take run requests, the desktop app first (D7); IDE
windows are left to runs-from-the-dashboard (D7); every run is confirmed in the target (D2); a request carries
resolved tests and is the same object as a CI dispatch, parsed in `@piwitests/core` (D3); a target connects to one
team instance at a time (D9); a requested run shows to its requester alone (D14); the administrator's switch is off by
default in the first release (D15); no request comes from an AI agent in the first version (D6); the existing **Copy
retry command** gains the run options and ships first, with **Create issue** (D17, D18). Every other decision is a
recommendation, and says which written decision it amends. The plan builds on three records that are not on `main`:

- `proposals/runs-from-the-dashboard.md` (branch `claude/nifty-hopper-lnt8h6`): this plan keeps its rules on what a
  request may name and its list of request kinds for later, and leaves it the IDE as a target.
- `proposals/browser-grids.md` (branch `claude/dazzling-tesla-4tdf8v`): its dispatch that carries an id (D8) is the same
  object as a run request here, and this plan answers its open question 8 ("the first self-hosted runner: the desktop
  app taking a team instance's work for its own user, or a headless process?").
- `proposals/desktop-remote-connect.md` (branch `claude/desktop-remote-instance-connect-l1sbyt`): this plan keeps its
  device key in the OS keychain and its folder links per instance, for a narrower purpose, and does not need its
  window showing the team instance.

Its contracts are entry D64 of [`1.0-stabilization.md`](1.0-stabilization.md).

## Summary

- **One object, the run request.** A page asks for a run of tests the instance resolves (relative spec path, title,
  line, Playwright project) with options from a closed list. The instance stores the request, a target claims it once,
  and it expires unclaimed after two minutes. The same object serves CI dispatch (browser-grids D8), so the menu that
  offers **Re-run in CI** offers **Run on my machine** beside it.
- **The instance carries, the machine decides.** A request reaches the person's connected app over a connection the app
  opens to the instance (a stream, or polling where a proxy cuts it). The app shows it in its own window and runs
  nothing before **Run** is clicked there. A `piwi://` link never carries a run.
- **Two targets, one implementation.** The desktop app first, then Piwi Runner (the standalone app), both through one
  request host written in TypeScript beside the existing `@piwitests/editor/run-host`. Each shows the same
  confirmation, the same checks and the same states.
- **Two credentials, both narrow.** A target key, from the device flow Piwi Picker and the editors already use, can only
  receive and answer its owner's requests. Each accepted request gives a run token that uploads that one run, to the
  instance that issued it.
- **A requested run never pages the team.** It carries its own origin, sends no notification, writes nothing to the
  tracker, stays out of the team's measures and shows to its requester alone. That is also why a Contributor may ask
  for one without `run:submit`.
- **Off until an administrator turns it on**, in the first release, and enforced on the server.
- **Create issue works on a run and on a single test, with the person's comment.** It is independent of the rest and
  ships first, with the run options added to **Copy retry command**.

## Terms

| Term | Meaning in this document |
| --- | --- |
| **team instance** | A Piwi server that several people and CI report to. |
| **run request** | What a page asks for: a kind, a project, the resolved tests, and options from a closed list. Stored on the instance with an id, claimed once, expired unclaimed after two minutes. |
| **target** | A program on the person's machine that takes run requests: the desktop app, or Piwi Runner. |
| **Piwi Runner** | The standalone target: a small app with no dashboard and no database, that takes run requests, checks the folder, asks, runs Playwright and reports. |
| **request host** | The code both targets share to take a request: check the tests against the folder, show the confirmation, build the command, run it, report its state. |
| **target key** | The credential a target holds on the team instance: an API key that holds one permission, `run:receive`. |
| **run token** | A credential the instance gives a target for one accepted request: it uploads one run, with the request's id as its ref, to one project. |
| **hub** | The local process that steers a run's workers over the run channel (`@piwitests/core/run-hub`): the desktop app's server, or Piwi Runner's request host. |

The word **agent** is not used for Piwi Runner: in Piwi it names the coding agents (Claude Code, Copilot), in the MCP
tools, the `agent-diagnoses` capability and "Paused by the agent".

## What exists

| Piece | Where | What this plan takes |
| --- | --- | --- |
| Run locally | `DesktopRunLocallyButton.vue`, `useDesktopLocalRuns.ts`, `runner.rs` | The plan per Playwright project (`buildLocalRunPlan`), the allowed flags (`validate_args`), the stop with a grace period (`interrupt.rs`), the checks for the folder, the specs and Playwright. Missing: a check of the browsers and of the branch. |
| Copy retry command | `RunHeader.vue`, `useRunRetryCommand.ts`, `TestCasesList.vue`, `test-run-cases/[id].vue`, `retry-command.ts` | A copyable `npx playwright test` command for a run's failures, an execution or a selection, by line or by title. Missing: the run options (headed, trace, repeat). |
| Test selection by title | `buildBisectArgs` in `local-run-args.ts` | The files and an escaped `--grep` of the titles, so a test whose line moved still matches. |
| Folder links | `projectLinks` in the shell's `settings.json` | Links stay on the machine. They are keyed by the bundled server's project ids, so they need the instance in their key. |
| `piwi://` | `link_page` in `lib.rs`, the rule in `apps/desktop/AGENTS.md` | "A `piwi://` link only shows a page." This plan keeps the rule and adds one route that only asks. |
| Device flow | `server/utils/extension-connect.ts`, `app/pages/extension/connect.vue`, `extension_device_codes` | A code like `ABCD-EFGH`, valid 10 minutes, single use, named after the client and the device, confirmed on both sides (RFC 8628). Used by Piwi Picker, VS Code and JetBrains. `clientKind` (`picker` or `editor`) is read from the client name's prefix, not stored. |
| API keys | `api_keys`, `ApiKeysManager.vue` in Settings → Account | No scope: a key carries its owner's access (`adr/extension-connect.md`). Remote browsers propose keys that hold one permission (`grid:connect`, entry D61 of the register), not built. |
| Desktop jobs | `DesktopJobRequest` in `@piwitests/core/desktop-job`, `shared/desktop-repro.ts`, `DesktopReproRequestModal.vue` | The rule "names commits, tests and lab conditions, never code or command-line flags"; a spec path relative to the config, with no leading `-`, `/` or drive and no `..` (D36); a window that runs nothing before a click. |
| Event stream | `GET /api/stream` (SSE) | Authenticated by session or key. The bus is in memory, so an instance runs one replica ([deployment](../apps/docs/operate/deployment.md)). |
| Following a run by its ref | `GET /api/projects/:id/latest-run?origin&ref`, `run-started` on `/api/stream` | How the editor follows its own runs; the page follows a requested run the same way. |
| Run host | `@piwitests/editor/run-host` | The hub, the run sessions, the stop actions and the agents' tools, already shared by the editor service and the desktop app's server. |
| Run origins | `RUN_ORIGIN_KINDS` (`packages/core/src/wire.ts`), `RUN_USES` (`shared/run-eligibility.ts`) | A run from `local` or `desktop` that runs the whole suite sends notifications, pull-request feedback and tracker writes (`completeOnlyFor`), and every local origin counts in flakiness and analytics. |
| Create issue | `CreateIssueModal.vue`, `POST /api/integrations/issues`, the integration outbox | The issue type is already chosen in the modal, from Jira. A run is not an entity it files (`IssueEntityType`), an execution files for its cluster only, and the body has no free text. |
| Capabilities | `shared/capabilities.ts`, Settings → Capabilities | An instance or a project declines a feature. Enforced on the server for the MCP tools only. |
| Permissions | `shared/permissions.ts` | `issue:create` from Contributor; `run:submit` for Maintainer, Project admin and Uploader only. |

## The flow

A CI run on `main` failed overnight. A QA engineer opens the run on the team instance.

1. On the run, a test or a spec file, **Run on my machine** names where it will run: "Piwi Desktop · LAPTOP-42". Its
   menu sets what to run (this test, the failed tests, the spec file) and the options (headed by default, trace,
   repeat, workers, Playwright project), and lists the other ways: **Re-run in CI**, **Copy retry command**.
2. The desktop app comes to the front with the request: the instance that asked, the tests, the folder, the checks and
   the exact command. **Run**.
3. The browser opens on their screen and the test runs. On the page they clicked, the button has become the run:
   "Running on LAPTOP-42 · 2 of 3 · Stop".
4. At the end: "Failed · 1 of 3 · Run again · Create issue · Open the run". **Create issue** files a Jira issue of the
   type they choose, their comment first, then what Piwi attaches.

## Decisions

### D1. The instance carries the request; the machine decides

**Recommended.** The page creates a run request on the instance. The instance delivers it to the person's own
connected targets over a connection the target opened itself (D11). The target shows it and runs nothing before
**Run** is clicked in its own window. A `piwi://` link never carries a run: it opens a page, starts the app, or starts
a connection the person confirms (D5).

Why:

- One route for every browser, with no extension and no "Open Piwi Desktop?" prompt for each click.
- The page learns from the instance which of the person's targets are online, so the button names one without the
  page reaching the machine.
- It works behind a VPN or NAT, and from a browser on another device, since the target only connects out.

Alternatives:

| Route | Why not as the main route |
| --- | --- |
| A `piwi://run?…` link per request (#1163 option 1) | Any page can open the link, so it must carry a secret or the app must hold a key anyway. The browser asks for each click (Safari every time), the page cannot tell whether the link was taken, and Stop needs another link. |
| Piwi Picker carries the request (runs-from-the-dashboard D2) | It checks that a person clicked (`isTrusted`), which this route cannot. But it needs the extension in the browser, and a QA engineer may not have it. |
| The page calls the target on `127.0.0.1` (#1163 option 3) | Rejected by #1163 and by [live-runs.md](live-runs.md) for the same reasons: Chrome's local network access prompt, mixed content in Safari, and any page could try the port. |

No **Links only** mode: links never carry runs.

Amends: [run-control.md](../adr/run-control.md) D8 ("the team instance never steers a run") and
[live-runs.md](live-runs.md) D7, which already lets the instance carry a request that a local tool shows for the person
to accept (**Ask to watch**). This plan widens that exception to starting and stopping a run, and nothing else: the
instance never pauses, steps or drives a page.

### D2. The target asks before every run (settled)

**Settled 2026-11-06.** Every request is confirmed in the target, every time. No **Run without asking** in the first
version.

Why: with the instance carrying the request, a click in the page proves nothing to the target. A script injected in an
instance page, or a stolen session, can create requests (runs-from-the-dashboard reached the same conclusion in its
open question 2). A QA suite often writes to a shared test environment, so an unasked run has effects beyond the
machine. The confirmation is one click, with **Run** focused.

Possible later, if people ask: **Run without asking** per project and per machine, for the `run` kind only, shown as a
five-second "Starting in 5 s · Cancel" notice in the target, and turned off from the target or from Connected apps
(D16).

### D3. A request carries resolved tests and options, never a command (settled)

**Settled 2026-11-06.**

- **One object with the CI dispatch.** A run request and browser-grids D8's dispatch that carries an id are one shape,
  with one parser in `@piwitests/core/run-request` (MIT), read by the instance, the request host, the dashboard and the
  reporter. It refuses an unknown field or a value out of bounds, field by field.
- **Kinds**: `run` in the first version; `debug`, `verify`, `reproduce` and the others of runs-from-the-dashboard's list
  later, each a new kind an older target refuses with a message to update.
- **Tests, resolved by the instance**: from an execution, a test case, a run (its failed tests, or all its tests), a
  spec file of a run, or a saved selection. Each test is `{ filePath, title, line, projectName }`, 1 to 200 of them,
  with `filePath` relative to the Playwright config under D36's rule (no leading `-`, `/` or drive, no `..`).
- **Options**: `headed` (default on), `trace` (`on` or `retain-on-failure`), `repeatEach` (1 to 10), `workers` (1 to 4),
  and the Playwright `project` among those the instance recorded for those tests. `--ui`, `--debug`, `--grep` and
  `--timeout` are not offered.
- **What the request came from**: the run, the execution, the branch and the commit, for the confirmation's branch check
  and for the issue (D17).
- **Never** an absolute path, a command line, an environment variable, a URL or code. The target checks each test
  against its own folder, and builds the command itself (`buildLocalRunPlan`, `validate_args`).

```ts
interface RunRequest {
  id: string; // random, single use; the run's ref
  kind: "run";
  projectId: number;
  tests: { filePath: string; title: string; line: number | null; projectName: string | null }[];
  options: {
    headed: boolean;
    trace?: "on" | "retain-on-failure";
    repeatEach?: number;
    workers?: number;
    project?: string;
  };
  source: { runId?: number; executionId?: number; branch?: string; commit?: string };
}
```

Why resolved tests rather than ids: the confirmation shows the tests' titles before **Run**, so a request of ids needs
a target key that reads the project's tests. With the tests in the request, the target key reads nothing but its own
requests (D5), and the paths follow a rule repro requests already follow.

### D4. A request is claimed once and starts at most one run

**Recommended**, from local-runner.md:

- `POST /api/run-targets/requests/:id/claim` moves `waiting` to `claimed` in one conditional update. A second claim,
  from a reconnect or a second process, answers 409 and starts nothing.
- A request not claimed within 2 minutes expires, and the page says the target did not answer.
- The target records each request id it has seen and refuses to start a second run for one, so a crash between the
  claim and the run leaves the request `claimed`, and the page offers **Run again**, which is a new request.

### D5. A target key and a run token

**Recommended.**

- **Connecting a target uses the device flow that exists.** The target shows a code and opens the instance's connect
  page; the person signs in, checks that both show the same code, and allows. `clientKind` becomes a stored column with
  `desktop` and `runner` added, and the page gains their words ("Connect Piwi Runner", "My Piwi Runner shows this same
  code"). `piwi://connect?instance=<origin>` from the instance's page starts the same flow in the app, which first asks
  "Connect to piwi.acme.com?" and connects nothing from the link alone. Where the link is blocked, or the browser is on
  another machine, the person types the instance's address in the app.
- **The key it gets is a target key**: it holds `run:receive` alone, which opens the request stream of its owner, reads
  and claims those requests, and writes their state. It cannot read the project's data, submit a run or act as the
  person. It is kept in the OS keychain (the `keyring` crate in the shell).
- **Each accepted request gives a run token**: the answer to **Run** carries a token that uploads one run, with the
  request's id as its ref, to the request's project, valid for that run and its retries of the upload. The target
  hands it to the reporter through a file only the person can read, never on the command line.
- **The reporter sends a requested run to the instance that issued the token, whatever the Playwright config names.**
  Today a server set in the config wins over `PIWI_DASHBOARD_URL` and `PIWI_API_KEY` (`cli/configure.ts`). A requested
  run needs an override that wins over the config and that the reporter refuses to send anywhere but the token's
  origin.

Alternatives:

- **The person's own full key in the target** (#1163 as written, desktop-remote-connect): simpler, but a stolen laptop
  key then reads and writes everything the person can.
- **A runner key that also uploads** (local-runner.md): one credential, but a stolen key then writes runs to every
  project of the person until revoked.
- **No key at rest, a secret in each link**: keeps the desktop app's rule that it never holds a team key, but brings
  back the link per request of D1, and every click opens an OS prompt.

Amends: [`1.0-stabilization.md`](1.0-stabilization.md) D36 and D51 ("the app never holds the team's key"): the desktop
app holds a target key, which is not the team's key and cannot read the team's data. It meets the rules
[desktop-native.md](desktop-native.md) sets for "The team's CI on the developer's desk": a narrow key in the keychain,
an explicit consent, and links that only open a page or ask in the window first.

### D6. Who may ask (settled for agents)

**Recommended.** A new project permission, `run:request` ("Run tests on my machine from the dashboard"), from
Contributor up. The run uploads through its run token, so it does not need `run:submit`, which Contributor lacks.

**Settled 2026-11-06**: only a signed-in session creates a request, never an API key or an MCP client. An Uploader key,
which is how CI reports, cannot start runs on laptops, and an AI agent cannot either in the first version.

Why Contributor: putting a run on the instance is safe because a requested run counts in nothing the team reads and
shows to its requester alone (D14).

### D7. The targets: the desktop app first, then Piwi Runner (settled)

**Settled 2026-11-06**: the desktop app and Piwi Runner take run requests; the desktop app is built first, Piwi Runner
after it; IDE windows are not a target in this plan.

- **One request host in TypeScript**, in `packages/editor` (FSL) beside `run-host`: the desktop app's server runs it, as
  it runs `run-host` for its own runs; Piwi Runner runs it as a small Node process, without the server or the database
  (D8).
- **Each target is a hub for the runs it starts**, through `run-host`, so a requested run can be paused, watched and
  shared live from that machine's own surfaces like any local run.
- **The native parts stay native**: starting and stopping the process tree, the keychain, the tray, the notifications
  and the `piwi://` scheme stay in the Rust shell.
- **Which target takes a request**: the page lists the person's online targets for the project (a target says which
  projects it has a folder for, never the folder); the button names the one used last for that project, kept for the
  person on the instance; its menu lists the others.
- **IDE windows** stay with runs-from-the-dashboard, which may later take this plan's request object and stream for its
  open question 2 (a route without Piwi Picker).

Amends: [live-runs.md](live-runs.md) D9 ("no daemon"). Piwi Runner is one more program to install and secure, which D9
avoids; it is the price of a target without the dashboard, which the issue's author asks for so that a QA engineer
need not install the dashboard, reproduce, bisect, Flake Lab and MCP. It stays a target and the hub of its own runs
only: it does not become the fallback hub of terminal runs, which stays the desktop app (live-runs P7).

### D8. How Piwi Runner is built

**Recommended**, each point to confirm with a spike before its PR:

- **The same Rust crate as the desktop app**, built with a cargo feature (`runner`) and its own Tauri configuration:
  product name "Piwi Runner", its own identifier, no server sidecar, no database, no file associations, the `piwi`
  scheme shared with the desktop app (the one installed last answers; both read the same routes).
- **Its windows are pages of the dashboard's own code, built as a static app.** The demo already builds the app with no
  server (`app:generate:demo`). Piwi Runner's build keeps the confirmation, the folders and the connection pages, so the
  desktop window and Piwi Runner show the same components with the same words. If the spike shows this does not hold,
  Piwi Runner gets a small app of its own sharing only the words.
- **Node**: bundled, as the desktop app bundles it (`binaries/node`), so the run code takes one path on both and does
  not depend on the `PATH` a launch from Finder or the Start menu sees.
- **Updates**: signed, from the same release, as a separate artifact on each platform.

Alternatives:

- **A mode of the desktop app's installer, with the dashboard hidden** (#1163 option A): one artifact, but it installs
  the whole server and database, which a managed laptop must approve.
- **A Node command only** (`npx @piwitests/runner`, FSL like `@piwitests/server`), with the confirmation in the
  terminal: no window for a QA engineer, but useful on a Linux machine, in WSL or in a remote development container.
  Possible later on the same request host.

### D9. One instance at a time; folders stay on the machine (settled for the instance)

**Settled 2026-11-06**: a target is connected to one team instance at a time. Connecting to another disconnects the
first, after the person confirms. The desktop app's own bundled server is not a team instance and keeps its own links.

**Recommended** for the folders: a target keeps `instance origin → project id → folder` on the machine only
(desktop-remote-connect's shape), so reconnecting to an earlier instance finds its folders again. The desktop app's
existing links move under its own server's origin. A request for a project with no folder asks for one in the
confirmation itself (**Choose the folder**), and the folder is checked before **Run** is enabled.

### D10. The checks before each run

**Recommended.** Shown as rows in the confirmation, each with its fix where one exists; the request host runs them, so
both targets check the same things:

| Check | Fails | Warns |
| --- | --- | --- |
| The folder is linked and exists | **Choose the folder** | |
| The specs are in it | which are missing | |
| Its Playwright is installed | "Run `npm install` in the folder" | |
| The browsers of the chosen projects are installed | **Install browsers** (the target runs `playwright install <browser>` with the folder's Playwright, after the click) | |
| The branch and commit | | "Your folder is on `feat/cart` at `a1b2c3d`; the run you came from was on `main` at `9f8e7d6`" |
| Uncommitted changes | | "Your folder has uncommitted changes" |

**When the branch or commit differs, the target selects the tests by title**, as `buildBisectArgs` does (the files and
an escaped `--grep` of the titles), since a line may have moved; the confirmation shows the command it will run. On the
same commit it selects by `file:line`.

The browser and branch checks also serve **Run locally**, which lacks them today.

### D11. The connection: a stream, and polling where it is cut

**Recommended**, from local-runner.md:

- **One outbound stream per target**: `GET /api/run-targets/stream` (server-sent events) with a heartbeat, authenticated
  by the target key. It carries new requests and stops. The target reconnects with backoff, and on each connection
  reads the requests still `waiting` (`GET /api/run-targets/requests`), so a request made while it was away is not
  lost.
- **Polling where a proxy cuts long responses** (a Kubernetes ingress, a corporate proxy): the same list, every few
  seconds while the target is open. A WebSocket is not needed: requests flow one way, and claims and states are plain
  requests.
- **Presence** (whether a target is online, for the button) is kept in memory, like the event bus: an instance runs one
  replica, as the deployment page already requires. The feature page says so.

### D12. Following, stopping and running again from the page

**Recommended.**

- **Following**: the run's ref is the request's id. The page finds the run as the editor finds its own
  (`latest-run?origin&ref`, `run-started` on `/api/stream`) and reads its progress from the run's stream, which the
  reporter already sends (live-runs P4 and P5). No new channel.
- **Before the run exists**, the page shows the request's state from the instance: waiting for the target, declined,
  expired, a check that failed (its words, not the folder's path).
- **Stop** on the page sends a stop for that ref to the target that runs it, on its stream; the target obeys without
  asking, since stopping is safe and the run is the person's own, and says so in its window ("Stopped from the
  dashboard").
- **Run again** is a new request with the same content: the target asks again.
- Pause, Step, Resume and driving a stopped page stay on the machine's own surfaces (run-control D8).

### D13. Watching from the page

**Recommended.** The confirmation has a **Share live with the team** box, off by default and shown only when the
project's live view is on. Ticked, the target shares the run as **Share live** does today, so teammates can **Watch**
it. The person who asked sees the real browser on their screen and needs no relay. This follows
[live-runs.md](live-runs.md) D14 (pixels go through the instance for CI and shared runs only) and P9 (share by intent).

### D14. How a requested run counts, and who sees it (settled for who sees it)

**Recommended.** A new origin kind, `request`, for every run started by a run request, whatever the target; the target
is recorded beside it (`piwiInteractive.client`, as live-runs P3 records the steering tool).

- It sends no notification, no pull-request feedback and no `test.stuck`, makes no tracker write and does not make a
  cluster recur (the `editor` rule).
- It stays out of flakiness, analytics, baselines and the selection catalog: it was run to look, on a branch and a
  machine the team did not choose.

**Settled 2026-11-06**: a requested run shows to its requester alone: on its run page, in the test's history marked "on
your machine", and in their own runs. Run lists, test histories, search and the MCP tools filter out another person's
`request` runs; a link to one answers 404. Whether instance administrators see them is open question 2.

Why one origin: `ci-rerun` already names a run by how it came to be rather than by its launcher, and one origin keeps
the rule in one row of `RUN_USES` and the visibility filter in one predicate. Today a whole suite run from a laptop as
`local` or `desktop` notifies the team; a requested run never does.

Alternative: keep the launcher's origin (`desktop`, a new `runner`) and recognize requested runs by their ref's prefix
(local-runner.md, runs-from-the-dashboard D7). It spreads the rule over several origins and every query that filters on
them.

Origin kinds freeze at 1.0, so the kind is added before.

### D15. The administrator's control (settled for the default)

**Settled 2026-11-06**: a capability, **Run on my machine** (`machine-runs`), **off by default in the first release**,
turned on per instance and declined per project in Settings → Capabilities. Unlike most capabilities it is **enforced
on the server**: off or declined, the request routes answer 403 and targets receive nothing. The default turns on in a
later release, once the feature has been used (open question 3).

**Recommended**: no limit in Settings. The largest `repeatEach` (10), `workers` (4), the tests per request (200) and the
request's lifetime (2 minutes) are fixed by the parser.

### D16. Connected apps

**Recommended.** Settings → Account gains **Connected apps** above the API keys: every key the device flow made (Piwi
Picker, VS Code, JetBrains, the desktop app, Piwi Runner), each with its kind, its device, when it last connected and,
for a target, whether it is online now, with **Revoke**. Revoking a target closes its stream at once, and its next
request answers 401; the target then asks to connect again. Administrators see the same list per user in Settings →
Users. This answers #1163's "Profile → Connected runners" without a page of its own: there is no Profile page, and Piwi
Picker's and the editors' keys lack the same list today.

### D17. Create issue on a run and on a test, with a comment (settled to ship first)

**Settled 2026-11-06** to ship first, independent of the rest. **Recommended** content:

- **Create issue** (the existing name, not "Raise a ticket") on a run's page, on the progress of a requested run, and
  on an execution with or without a failure cluster.
- The modal gains **Comment**, the person's own words, placed first in the issue under their name. The rest stays
  built by the server, never by the browser.
- A run's issue attaches: the run's link, its tests and their results, the branch and commit, the options it ran with
  (from the request when there is one), the failure clusters of its failures, and who filed it from Piwi (#1152).
- `IssueEntityType` gains `test_run`; an execution without a cluster files for itself. Several issues per run are
  allowed, the existing links shown in the modal.
- **Each submission files once**: the modal sends an id for the submission, the outbox keys the `create-issue` action by
  it, and a row reclaimed after its lease writes the same "create started" marker as the test management sync
  ([#1161](https://github.com/PiwiTests/piwi/issues/1161)): a reclaim that finds the marker without an issue key fails
  with "Outcome unknown" instead of filing twice.
- It is the "run tickets" left in step 4 of [issue-tracker-integrations.md](issue-tracker-integrations.md).

### D18. Copy retry command gains the run options (settled to ship first)

**Settled 2026-11-06** to ship with D17. **Copy retry command** exists on the run page, the execution page and the
test list's selection. It gains the menu's options (headed, trace, repeat, workers, project), so a person with no
target can run the same thing from a terminal in their folder. It keeps its name, and appears in the **Run on my
machine** menu among the other ways.

### D19. One word per concept

**Recommended.** The same words on every surface, held by a drift test as live-runs D6 does for the live words:

| Concept | Word | Not |
| --- | --- | --- |
| The page's action | **Run on my machine** | Run locally (stays the desktop window's own button), Reproduce on my machine |
| The standalone app | **Piwi Runner** | agent, local runner |
| The confirmation | **Run on this machine?** with **Run** and **Not now** | Allow, Accept |
| Connecting | **Connect** a target to an instance; the list is **Connected apps** | pair, link (a folder is linked, an app is connected) |
| Ending a run | **Stop** | Cancel, Kill |
| Starting it again | **Run again** | Re-run (kept for **Re-run in CI**) |
| Filing | **Create issue** | Raise a ticket, File a ticket |
| Showing it to the team | **Share live**, then **Watch** | |

## The surfaces

Wireframes; words as in D19.

### 1. The team page

```
 Run #4211 · main · 9f8e7d6 · Failed · 3 of 120 failed
 ┌───────────────────────────────────────────────┐
 │ ▶ Run on my machine · Piwi Desktop · LAPTOP-42 ▾│   Re-run in CI ▾   Create issue
 └───────────────────────────────────────────────┘
   Where      ● Piwi Desktop · LAPTOP-42           online
              ○ Piwi Runner · DESKTOP-7            offline
   What       ● The 3 failed tests  ○ checkout.spec.ts (8 tests)  ○ All 120 tests
   Options    [x] Headed   [ ] Trace   Repeat [1 ▾]   Workers [1 ▾]   Project [chromium ▾]
   Other ways   Re-run in CI (Jenkins) ·  Copy retry command
```

With no target connected, the button reads **Set up Run on my machine**: what it does, the download of the desktop app
(and of Piwi Runner once it ships), and **Connect** (`piwi://connect?instance=…`). With the capability off, the button
is not shown.

### 2. The confirmation in the target

The same window in the desktop app and in Piwi Runner.

```
 Run on this machine?
 Asked by you from piwi.acme.com · 10:42

 Tests     checkout.spec.ts › pays with a coupon
           checkout.spec.ts › applies a gift card
           cart.spec.ts › keeps the basket after sign-in
 Folder    ~/work/web-portal-tests                     Change
 Checks    ✓ Specs found   ✓ Playwright 1.64.1   ✓ Chromium installed
           ⚠ Your folder is on feat/cart at a1b2c3d; the run was on main at 9f8e7d6
 Command   npx playwright test checkout.spec.ts cart.spec.ts
           --grep="(pays with a coupon|applies a gift card|keeps the basket after sign-in)"
           --project=chromium --headed
 [ ] Share live with the team

                                          Not now      [ Run ]
```

### 3. Following it on the page

```
 ▶ Running on Piwi Desktop · LAPTOP-42 · 2 of 3 · 0:41                Stop
   ✓ pays with a coupon   ✓ applies a gift card   ● keeps the basket after sign-in
   Watch (shared live)

 ✕ Failed on Piwi Desktop · LAPTOP-42 · 1 of 3 failed     Run again   Create issue   Open the run
```

Before the run starts: "Waiting for Piwi Desktop on LAPTOP-42 to confirm", then "Declined", "Expired after 2 minutes"
or "Not started: Chromium is not installed on LAPTOP-42".

### 4. Piwi Runner

```
 Tray: Piwi Runner · connected to piwi.acme.com
       Running: checkout.spec.ts · 2 of 3        Stop
       Open Piwi Runner
       Quit

 Window
  Connection   piwi.acme.com · as Dana Lee · since 4 Nov       Disconnect
  Folders      web-portal / Checkout     ~/work/web-portal-tests     Change
               web-portal / Admin        not linked                  Choose
  Defaults     [x] Headed  [ ] Trace  Repeat 1  (per project, on this machine)
  Recent       10:42  3 tests · Failed 1 of 3 · Open the run
               09:15  1 test · Passed · Open the run
```

The desktop app shows the same connection, folders and recent requests in a page of its window.

### 5. Connecting a target

The existing connect page, with the target's words: "Connect Piwi Desktop", the code, "[ ] My Piwi Desktop shows this
same code", **Allow**. The target names the device ("Piwi Desktop on LAPTOP-42, macOS"), and the key is named after
it.

### 6. Connected apps

```
 Settings › Account › Connected apps
  Piwi Desktop on LAPTOP-42 (macOS)      online · connected 4 Nov      Revoke
  Piwi Runner on DESKTOP-7 (Windows)     last seen 2 h ago             Revoke
  Piwi in VS Code on LAPTOP-42           last used yesterday           Revoke
  Piwi Picker in Chrome on LAPTOP-42     last used 3 Nov               Revoke
```

### 7. The administrator

Settings → Capabilities: **Run on my machine**, off by default, turned on per instance and declined per project.

### 8. Create issue on a run

```
 Create issue · Run #4213 on LAPTOP-42
  Project   WEB  ▾        Type   Missing test ▾
  Comment   The coupon is accepted twice when the page reloads; no test covers it.
  Attached  The run and its 3 tests (1 failed) · main at 9f8e7d6 · headed, chromium
            · cluster #42 · filed by Dana Lee from Piwi
  Preview ▸
                                                         Cancel   [ Create issue ]
```

## One state model

A request and its run are in one state, an enum in `@piwitests/core/run-request`, and each surface words it (live-runs
D5 and D6): `waiting` (stored, not claimed), `claimed` (shown in the target, not answered), `declined`, `expired`,
`refused` (a check failed, with which), `starting`, `running` (with counts), `stopping`, `ended` (`passed`, `failed`,
`stopped`, `error`). The page, the target's window and its tray show the same state with the same words.

## The instance's routes

| Route | Who | What |
| --- | --- | --- |
| `POST /api/run-requests` | a signed-in session with `run:request` | Creates a request for one of the person's targets; answers its id. |
| `GET /api/run-requests/:id` | its requester | The request's state. |
| `POST /api/run-requests/:id/stop` | its requester | Sends a stop to the target that runs it. |
| `GET /api/run-targets/stream` | a target key | New requests and stops, with a heartbeat. |
| `GET /api/run-targets/requests` | a target key | The requests still `waiting`, for a reconnect or polling. |
| `POST /api/run-targets/requests/:id/claim` | a target key | `waiting` to `claimed`; 409 on a second claim. |
| `POST /api/run-targets/requests/:id/answer` | a target key | **Run** (answers the run token), **Not now**, or a failed check. |
| `POST /api/run-targets/requests/:id/state` | a target key | `starting`, `stopping`, `ended`, and a stop obeyed. |

Two tables, in both schemas with a migration each: `run_requests` (the request, its requester, its target, its state,
its claim and expiry, the run once it begins) and `run_targets` (the key, the kind, the device name, the platform, the
version, the projects it has a folder for, `last_seen_at`, `revoked_at`).

## Security

The rules every tool follows:

1. **The instance carries, the machine decides.** A run starts only after **Run** in the target's own window (D1, D2).
2. **A request names tests by relative spec path and title, and options from a closed list**; the target checks them
   against its own folder and builds the command (D3).
3. **A request is personal**: created by a signed-in session of the person (never an API key or an MCP client),
   delivered only to that person's targets, claimed once, expired after two minutes (D4, D6).
4. **A `piwi://` link never carries a run.** It opens a page, starts the app, or starts a connection the person
   confirms on both sides (D5).
5. **Narrow credentials**: a target key holds `run:receive` alone, in the OS keychain; a run token uploads one run to
   the instance that issued it (D5).
6. **A requested run never pages the team**, counts in nothing the team measures, and shows to its requester alone
   (D14).
7. **The administrator's switch is off by default and enforced on the server** (D15).

| Threat | What happens |
| --- | --- |
| A script injected in an instance page, or a stolen session | It can create requests for that person. Each is shown in the target and runs only on **Run**; the tests are the person's own checkout, the options bounded. |
| A malicious `piwi://` link | It can open a page or ask to connect to an instance; the connection needs the same code on both sides and a signed-in person who allows it. |
| A stolen target key | It receives that person's requests until revoked in Connected apps. It cannot read the project's data or upload a run. |
| A run token that leaks | It uploads one run with one ref to one project, for the life of that run. |
| A Playwright config that names another server | The reporter sends a requested run only to the token's instance (D5). |
| A request whose spec path climbs out of the folder | The parser refuses it, and the target checks each path against its folder before showing the confirmation (D3). |
| Another person's account | Requests reach only the targets of the person who created them. Starting a run on someone else's machine is not possible. |
| Another user of the machine | The key is in the person's keychain; the run token's file is readable by the person only. |

What leaves the machine: what the reporter already sends for a run, and which projects have a folder. Never a
folder's path.

## Compared with #1163 and local-runner.md

| Asked | This plan |
| --- | --- |
| Run on my machine from a test, a spec file or a run | Kept, plus a saved selection (D3) |
| The runner checks the folder, the spec, Playwright, the browsers and the branch | Kept, as one request host for both targets, with selection by title when the branch differs (D10) |
| Options: headed by default, headless, trace, capped repeat, workers, Playwright project; defaults per project on the machine | Kept (D3, surface 4) |
| A runner mode of the desktop app, or a separate app (local-runner.md prefers the separate app) | Both, the desktop app first (D7, D8) |
| Option 2 (paired runners through the instance) with option 1 (links) as fallback; an Off / Links only / Paired setting, off by default | Option 2 alone; links only open, start or connect; the setting is a capability, off by default (D1, D15) |
| Pairing with a single-use code that names the device; a typed code as fallback | The existing device flow, with the instance's address typed in the app as fallback (D5) |
| A scoped runner key in the OS keychain that also uploads; Profile → Connected runners | A target key that only receives, and a run token per run; Settings → Account → Connected apps for every client (D5, D16) |
| A claim that answers 409 the second time; one run per request | Kept (D4) |
| SSE with a polling fallback | Kept (D11) |
| Run without asking, per project on the machine | Not in the first version (D2) |
| A progress panel with Stop, Run again and Watch | Kept; Watch needs **Share live** in the confirmation (D12, D13) |
| Raise a ticket with a type and a comment, filed once | **Create issue** on runs and tests with a comment, filed once per submission, several per run (D17) |
| Local runs out of analytics by default | Requested runs out of every team measure, by a new origin, and shown to their requester alone (D14) |
| The request schema in the app's `shared/` | In `@piwitests/core/run-request`, as the same object as the CI dispatch (D3) |

## What changes in other records

- [run-control.md](../adr/run-control.md) D8 and [live-runs.md](live-runs.md) D7: the instance carries a request to
  start or stop a run, which the machine accepts; it still never steers.
- [live-runs.md](live-runs.md) D9: Piwi Runner is one more program, a target and the hub of its own runs only.
- [`1.0-stabilization.md`](1.0-stabilization.md) D36 and D51: the desktop app holds a target key, never the team's key.
  Entry D64 lists this plan's contracts.
- [desktop-native.md](desktop-native.md) "The team's CI on the developer's desk": the target key and `piwi://connect`
  follow its rules for a team key.
- `apps/desktop/AGENTS.md`: "A `piwi://` link only shows a page" becomes "only shows a page or asks to connect", in the
  PR that adds the route.
- runs-from-the-dashboard (unmerged): it keeps the IDE as a target. Its D7 (no new origin kind) gives way to D14 here: a
  run started by a run request is `request`, whatever its route. Its request list and D3 carry over here for later
  kinds.
- browser-grids (unmerged): D8's dispatch with an id and the run request are one object; its open question 8 is
  answered by D7; its D12 (a self-hosted runner polls outbound) matches D11.
- desktop-remote-connect (unmerged): its device key and per-instance folders are taken for targets; its window on the
  team instance is not needed for this plan.
- local-runner.md (the issue author's fork): merged here.

## Delivery

Each PR is usable on its own, and ships its demo (`app/demo/AGENTS.md`): the handlers of any new route, the seed and
the simulator, and `npm run app:seed:demo`. From PR 2 the demo has a simulated connected target whose requests the
simulator answers, so **Run on my machine**, the confirmation's outcome and the progress work there.

| PR | Content | Size |
| --- | --- | --- |
| 1 | **Create issue on runs and tests, with a comment** (D17), and the run options on **Copy retry command** (D18) | M |
| 2 | **The instance's side**: `run_requests` and `run_targets`, the routes, `@piwitests/core/run-request`, `run:request` and `run:receive`, keys that hold one permission, the stored `clientKind`, run tokens, the stream and its polling, the `request` origin with its rules and its visibility, the capability off by default, Connected apps | L |
| 3 | **The request host and the desktop app as a target**: the confirmation, the checks (browsers and branch for Run locally too, selection by title), folders per instance, `piwi://connect`, the device flow for `desktop`, the keychain, the reporter's override; on the page, the button, its menu and the progress | L |
| 4 | **Piwi Runner**, after the spike of D8: the `runner` build, its windows, signed releases and updates | L |
| 5 | **Share live from the confirmation** (D13), with live-runs P9 | S |

Each PR updates the docs it changes: a feature page for Run on my machine (connect, link a folder, run, follow, stop,
create an issue; what leaves the machine; the administrator's switch; one replica), the desktop app's page, a page for
Piwi Runner, the privacy page, the connect page and the issue tracker page. PR 2 adds the plan to `ROADMAP.md`.

## Tests

- Unit (`@piwitests/core`): the parser refuses an unknown field, a spec path with a leading `-`, `/` or drive or a `..`,
  an option out of bounds and more than 200 tests.
- Unit (instance): a second claim answers 409; an expired request cannot be claimed; a target key reads no project data
  and uploads nothing; a run token uploads only its ref to its project; a `request` run is out of every team use of
  `RUN_USES` and invisible to another user; the routes answer 403 with the capability off.
- Unit (request host): a target that has seen a request id starts no second run for it; a differing branch selects by
  title; a path outside the folder is refused.
- Unit (reporter): a requested run is sent to the token's origin even when the config names another server.
- Unit (outbox): a `create-issue` row reclaimed after its lease, with the marker and no issue key, never calls the
  tracker again.
- Rust: `piwi://connect` brings the window forward and connects nothing without a confirmation; every other unknown path
  still returns nothing.
- E2E: **Run on my machine** with a simulated target, from the request to the progress's end and **Run again**;
  **Revoke** closes the target's stream; **Create issue** on a run with a comment.

## Open questions

1. **Piwi Runner's windows** (D8): does the static build of the dashboard's pages hold up, or does Piwi Runner need a
   small app of its own sharing only the words? Settled by the spike before PR 4.
2. **Administrators and requested runs** (D14): do instance administrators see other people's requested runs, for
   support and audit, or the requester alone?
3. **The capability's default** (D15): in which release does **Run on my machine** turn on by default?
4. **Run without asking** (D2): later as described, once the first version has been used, or never?
5. **Requests from an AI agent** through MCP (D6): later, with the same confirmation, or never?

## Not in this plan

- **IDE windows as targets**: runs-from-the-dashboard.
- **Starting a run on another person's machine**, or on a machine shared by a team (a self-hosted runner in the sense
  of browser-grids D12).
- **The instance running tests**, or driving a browser itself (browser-grids D1).
- **The desktop app's window showing the team instance** (desktop-remote-connect).
- **Pause, Step and driving a stopped page from the team page**: they stay on the machine (run-control D8).
- **A headless Piwi Runner for servers**: possible later on the same request host (D8).
