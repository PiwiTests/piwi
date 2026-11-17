# Run variables

A plan to let a project carry a few environment variables, its **run variables**, that every run Piwi starts for the
project gets, and that every command Piwi gives to copy shows. It answers a team whose one app serves several tenants
from one folder: each tenant is a Piwi project of their team instance, and building, starting and testing the app needs
an environment variable that picks the tenant (`TENANT=acme`). Today nothing Piwi starts or shows sets it, so a run
started from Piwi tests the default tenant and reports to the wrong project.

**Status.** Proposed 2026-11-17. Nothing is built. The maintainer chose to keep one project per tenant (D1) and to write
this record before any code.

## Summary

- A project has at most 10 run variables, `NAME=value`, set in **Project → Settings → Run variables** by someone who
  holds `project:manage`. They are never secrets: they show in copied commands and in confirmations.
- Every place that starts Playwright for the project, or shows a command to run its tests, applies them: the copied
  commands of the dashboard, the desktop app's runs (Re-run, Reproduce, Bisect, Flake Lab), **Run on my machine** in
  Piwi Runner and the desktop app, and the editors' runs.
- Names that change what code runs or where results go are refused everywhere (D3), and each target checks them again.
- Building and starting the app stay in the Playwright config (`webServer`, `globalSetup`): Piwi adds no "command before
  the run" (D8).
- It amends one rule of [run-on-my-machine.md](run-on-my-machine.md) (D3: a request never carries an environment
  variable) for this one case, under the rules of D3 and D6 here.

## Terms

- **Run variable**: one `NAME=value` pair of a project, applied to the runs Piwi starts for it. Not to be confused with
  a run's **environment** (`test_runs.environment`, the deployment it ran against, `PIWI_ENVIRONMENT`) nor with the
  **environment snapshots** of [1.0-stabilization.md](1.0-stabilization.md) D65.
- **Tenant variable**: the run variable that picks the tenant in the example of this record (`TENANT`). Piwi gives it no
  special meaning.
- **Target**: an app that takes **Run on my machine** requests, the desktop app or Piwi Runner, as in
  [run-on-my-machine.md](run-on-my-machine.md).

## What exists

- **The project a run reports to** comes from the Playwright config alone: the reporter's `projectName` option, then
  `PIWI_PROJECT_NAME`, then the config folder's `.env` (`packages/reporter/src/internal/config/env.ts`). The config is
  code, so it can compute it: ``projectName: `shop-${process.env.TENANT}` ``. A requested run is the exception: it goes
  to the request's project whatever the config says.
- **Nothing Piwi starts sets a variable of the project.** Each place passes its own variables and the parent process's
  environment:
  - the desktop app's local runs (`desktop_run_local_tests`, `apps/desktop/src-tauri/src/runner.rs`): `PATH`, colors,
    the run's origin and the hub's channel;
  - Reproduce, Bisect and Flake Lab (`run_test_phase`, `worktree.rs`): the same, plus the desktop app's address and
    token. Their checkout is a fresh worktree, which also lacks the folder's untracked `.env`;
  - **Run on my machine** (`run_target.rs`, `packages/editor/src/request-run.ts`): the request token's file and the
    instance. [run-on-my-machine.md](run-on-my-machine.md) D3 says a request is "never an absolute path, a command line,
    an environment variable, a URL or code";
  - the editors' runs: the run's origin, breakpoints and channels from the editor service; VS Code and JetBrains add the
    IDE's own environment.
- **Copied commands carry no variable**: the retry command and its run options (`shared/retry-command.ts`), the
  reproduce recipe (`shared/reproduce.ts`), a selection's export. CI re-runs pass arguments only, and a CI action's
  fixed `inputs` can already carry a tenant per deployment environment (`shared/ci-actions.ts`).
- **One folder may be linked to several projects** in the desktop app: the links are per project id. The run still
  reports where the config sends it, and the editor service, which picks a project by folder, takes the lowest id
  without a word (`packages/editor/src/context.ts`).
- **The desktop app's folder check** reads `projectName` only when the config writes it as a literal, so a computed name
  shows as unknown (`apps/desktop/src-tauri/src/inspect.rs`).

## Decisions

### D1. One project per tenant, with run variables (settled)

The tenants stay separate projects, as the team registered them, and each project gets run variables.

The alternative was one project whose runs carry the tenant as their **environment**, which the config computes from
the tenant variable. It would give one folder, one link and one test catalog, and the filters, baselines and CI action
choice that already read the environment. It would lose what is per project: permissions, quarantine, flaky state,
failure clusters and settings per tenant. It would also still need the tenant variable on every run Piwi starts, set
per environment instead of per project. The maintainer chose to keep the projects.

### D2. What a run variable is

- **A name**: capital letters, digits and `_`, starting with a letter or `_`, 64 characters at most
  (`^[A-Z_][A-Z0-9_]{0,63}$`).
- **A value**: 500 characters at most, with no line break, no NUL and none of the hidden characters a request refuses
  (`HIDDEN_CHARACTER` of `@piwitests/core/run-request`). An empty value is allowed: it sets the variable to `''`.
- **At most 10 per project**, names once each.
- **Never a secret.** The value is stored as it is, shown in copied commands, in the desktop app and in a target's
  confirmation. The setting says so, and a secret stays in each machine's own `.env`.

One module of core holds these rules (`@piwitests/core/run-variables`: the name and value checks, the refused names of
D3 and the shell forms of D4), so the instance, the editor service and the dashboard check the same way. The shell
checks again in Rust with the same list, held to core's by a test.

### D3. The names Piwi refuses

A run variable never sets a variable that changes which code runs, which browser starts, or where results go. Refused,
whatever the case, since Windows reads names without it:

- `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `ELECTRON_RUN_AS_NODE`;
- every name starting with `LD_`, `DYLD_`, `NPM_CONFIG_`, `PIWI_` (Piwi's own: project, server, key, origin) or
  `PLAYWRIGHT_` (browsers path, download host);
- `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TMP`, `TEMP`, `TMPDIR`, `SHELL`, `COMSPEC`.

The list is short on purpose and lives in one place (D2). A name it refuses is refused when the setting is saved, and
again by every target before it runs anything (D6).

### D4. Copied commands

Every command the dashboard shows for the project's tests starts with its run variables, in each shell form the
dashboard already shows ([cross-platform rule](../apps/docs/AGENTS.md#cross-platform-shell-commands)):

- bash: `TENANT=acme npx playwright test …`, each value quoted as `quoteShellArg` (`shared/retry-command.ts`) quotes an
  argument;
- PowerShell: `$env:TENANT='acme'; npx playwright test …`, which sets the variable for the rest of the session, as the
  help next to the command says.

This covers the retry command and its run options, **Copy as command** of a selection, the reproduce recipe's test step
and the fix plan's verification. CI re-runs stay as they are: the pipeline picks its tenant through the CI action's
`inputs` (`shared/ci-actions.ts`), which the CI settings already offer per deployment environment.

### D5. The desktop app's runs

The shell reads the project's run variables from its own server by project id, as it reads a request's folder search
(`POST /api/desktop/run-target/requests/:id/folder-search`), never from the window, and checks them again (D3) before it
adds them to the process:

- **local runs**: Re-run, **Run with options…** and the tray's runs (`desktop_run_local_tests`);
- **Reproduce, Bisect and Flake Lab**: the test step of the worktree job. The install step (`npm ci` and the like)
  gets none: building belongs to the config (D8), and an install script that needs the tenant is the config's to call;
- **a bug report's reproduction** (`repro.rs`), which runs one spec the same way.

The run's command, as the tray and the run options show it, starts with the variables in the form of D4.

### D6. Run on my machine

The variables reach a target the way the folder hints of [run-on-my-machine.md](run-on-my-machine.md) do, never as a
field of the request, which an older target's parser refuses:

- `GET /api/run-targets/requests/:id/run-variables` answers the target that claimed the request, with the project's
  run variables;
- a target that applies them says so when it describes itself (`PUT /api/run-targets/self`, a `features` list with
  `run-variables`). The instance offers a request of a project with run variables only to such a target. To an older
  target it ends the request with words that say to update the app, rather than let it run the default tenant;
- the editor service's plan (`request-run.ts`) checks each variable (D2, D3) and refuses the request with the failed
  check when one does not pass;
- the confirmation shows them in the command, `TENANT=acme npx playwright test …`, before **Run**, and the shell takes
  them with the command from its server at launch (`POST /api/desktop/run-target/requests/:id/launch`), never from the
  window.

This amends [run-on-my-machine.md](run-on-my-machine.md) D3 and the recommendation of
[1.0-stabilization.md](1.0-stabilization.md) D64 for this case only: a request still never carries a command line, a
path, a URL or code, and the variables it is run with are the project's, checked by the target and shown to the person
before anything runs.

### D7. The editors' runs

Once it knows the project, the editor service reads its run variables (`GET /api/projects/:id`, a call it does not make
today: it names projects from `/api/projects/menu`) and adds them to every command it builds for the project's tests: runs by location, by test, a debug run and the runs an agent starts. VS Code
passes them to the task's environment and JetBrains to `withEnvironment`, as they pass the service's own variables
today. A run started in a terminal is the person's: Piwi sets nothing there.

### D8. No command before the run

Piwi does not run a command of the project's settings before a run. Building and starting the app for a tenant belong
in the Playwright config, so CI, a terminal, the editors and every Piwi path run the same steps, versioned and reviewed
with the code:

```ts
const tenant = process.env.TENANT ?? 'acme';

export default wrapConfig(
  defineConfig({
    use: { baseURL: `http://localhost:${portOf(tenant)}` },
    webServer: {
      command: 'npm run build && npm start',
      env: { TENANT: tenant, PORT: String(portOf(tenant)) },
      url: `http://localhost:${portOf(tenant)}`,
      reuseExistingServer: !process.env.CI,
    },
  }),
  { projectName: `shop-${tenant}` },
);
```

A command stored in a project setting would let anyone who can change the project's settings run code on every
teammate's machine, through **Run on my machine** and the editors. A port per tenant keeps `reuseExistingServer` from
reusing a server started for another tenant. The docs show this pattern next to the setting.

### D9. One folder, several projects

Linking one folder to several projects stays allowed, and becomes the expected case for a multi-tenant app:

- the desktop app's **Local folder** section names the other projects linked to the same folder;
- the folder check shows the project name the config computes with the project's run variables, when the shell can
  tell it: it reads `projectName` only as a literal today, so it says the name is computed rather than unknown;
- which project an editor follows for a folder linked to several stays an open question (below).

## Surfaces

1. **Project → Settings → Run variables**, a new section of `PROJECT_SETTINGS_SECTIONS` (`shared/app-places.ts`) in the
   project group: a list of name and value rows, **Add**, the checks of D2 and D3 as the person types, the note that
   values are never secret, and the config pattern of D8 as help. Saved with `project:manage`.
2. **The commands**: every command of D4 starts with the variables.
3. **The desktop app**: the run's command in the tray and in **Run with options…**, and the other projects of the
   folder in **Local folder** (D9).
4. **A target's confirmation**: the command with its variables (D6).

## The instance's routes

- `GET /api/projects/:id` gains `runVariables: { name, value }[]`; `PATCH /api/projects/:id` takes it, checked by D2
  and D3 (`project:manage`). The demo's handlers and seed mirror it.
- `GET /api/run-targets/requests/:id/run-variables` (target key, `run:receive`, the request claimed by this target).
- `PUT /api/run-targets/self` takes `features`.

## Security

- **Who sets them**: a project's managers, on the team instance. What they set runs on teammates' machines through
  **Run on my machine** and the editors, so the refused names of D3 keep it to plain values, and the confirmation and
  the commands show every variable before it applies.
- **Checked twice**: on save, and by every target before it runs (the editor service's plan, the shell), so an instance
  that sends a refused name, or an older one that does not check, runs nothing with it.
- **Never a secret**: values are shown and copied. The setting says so; a secret stays in the machine's `.env`.
- **Nothing reaches a shell**: the desktop app and Piwi Runner pass the variables as the process's environment, never
  through a shell line; the copied commands quote each value.

## What changes in other records

- [run-on-my-machine.md](run-on-my-machine.md) D3: "never an environment variable" gains "but the project's run
  variables of [run-variables.md](run-variables.md) D6".
- [1.0-stabilization.md](1.0-stabilization.md): D64's recommendation gains the same exception, and a new entry lists
  `runVariables` on the project, the `run-variables` target route and feature, and the refused names, frozen as they
  ship.
- [developer-loop-audit.md](developer-loop-audit.md) R7 (a project linked through a monorepo subfolder cannot
  reproduce, bisect or run Flake Lab) is unchanged: it is
  [#1516](https://github.com/PiwiTests/piwi/issues/1516).

## Delivery

1. **The setting and the commands**: core's `run-variables` module, the project field with its migration and API, the
   settings section, the copied commands (D4), the demo's seed and handlers, the docs (the setting, the config pattern
   of D8). It helps the team at once: every command copied from the dashboard runs the right tenant.
2. **The desktop app's runs** (D5) and the folder's other projects (D9).
3. **Run on my machine** (D6): the route, the target feature, the plan's checks, the confirmation, and the amendments
   of the other records.
4. **The editors** (D7).

Each step updates the Status paragraph above and the docs of what it ships.

## Open questions

- **Values per deployment environment**: a project whose tenant also differs by environment (staging, production)
  would need a value per environment. Not needed by the team that asked; a later addition to D2 if it comes up.
- **An editor's project for a folder linked to several**: the editor service takes the lowest id today. It could follow
  the project whose run variables match the workspace's environment, or a setting that names the project. To settle
  with D7.
- **The desktop app's own projects**: the desktop app runs its own server and projects. Whether a project linked to a
  team instance's project could take that project's run variables, rather than set them twice, is left for later.
