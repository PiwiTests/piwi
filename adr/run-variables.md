# Run variables

- Status: accepted
- Date: 2026-11-17

A plan to let a project carry a few environment variables, its **run variables**, that every run Piwi starts for the
project gets, and that every command Piwi gives to copy shows. It answers a team whose one app serves several tenants
from one folder: each tenant is a Piwi project of their team instance, and building, starting and testing the app needs
an environment variable that picks the tenant (`TENANT=acme`). Before it, nothing Piwi started or showed set it, so a
run started from Piwi tested the default tenant and reported to the wrong project.

**Status.** Proposed and built 2026-11-17, the four steps of the delivery in one pull request: the setting and the
copied commands (D2, D3, D4), the desktop app's runs and the folder's other projects (D5, D9), Run on my machine (D6)
and the editors (D7). What the build and its review changed from the proposal is written into each decision: a light route
of its own for the variables (`GET /api/projects/:id/run-variables`), values limited to plain text (D2), a longer list
of refused names (D3), the shell a copy button copies for (D4), the feature a target declares with each claim (D6), and
the person's **Allow** before an editor applies them (D7). Left open, as
written under Open questions: values per deployment environment, the project an editor follows for a folder linked to
several (the lowest id), and the desktop app's own projects taking a team project's variables.

## Summary

- A project has at most 10 run variables, `NAME=value`, set in **Project → Settings → Run variables** by someone who
  holds `project:manage`. They are never secrets: they show in copied commands and in confirmations.
- Every place that starts Playwright for the project, or shows a command to run its tests, applies them: the copied
  commands of the dashboard, the desktop app's runs (Re-run, Reproduce, Bisect, Flake Lab), **Run on my machine** in
  Piwi Runner and the desktop app, and the editors' runs.
- Names that change what code runs or where results go are refused everywhere (D3), and each target checks them again.
- Building and starting the app stay in the Playwright config (`webServer`, `globalSetup`): Piwi adds no "command before
  the run" (D8).
- It amends one rule of [run-on-my-machine.md](../proposals/run-on-my-machine.md) (D3: a request never carries an
  environment variable) for this one case, under the rules of D3 and D6 here.

## Terms

- **Run variable**: one `NAME=value` pair of a project, applied to the runs Piwi starts for it. Not to be confused with
  a run's **environment** (`test_runs.environment`, the deployment it ran against, `PIWI_ENVIRONMENT`) nor with the
  **environment snapshots** of [1.0-stabilization.md](../proposals/1.0-stabilization.md) D65.
- **Tenant variable**: the run variable that picks the tenant in the example of this record (`TENANT`). Piwi gives it no
  special meaning.
- **Target**: an app that takes **Run on my machine** requests, the desktop app or Piwi Runner, as in
  [run-on-my-machine.md](../proposals/run-on-my-machine.md).

## What existed

- **The project a run reports to** comes from the Playwright config alone: the reporter's `projectName` option, then
  `PIWI_PROJECT_NAME`, then the config folder's `.env` (`packages/reporter/src/internal/config/env.ts`). The config is
  code, so it can compute it: ``projectName: `shop-${process.env.TENANT}` ``. A requested run is the exception: it goes
  to the request's project whatever the config says.
- **Nothing Piwi started set a variable of the project.** Each place passed its own variables and the parent process's
  environment:
  - the desktop app's local runs (`desktop_run_local_tests`, `apps/desktop/src-tauri/src/runner.rs`): `PATH`, colors,
    the run's origin and the hub's channel;
  - Reproduce, Bisect and Flake Lab (`run_test_phase`, `worktree.rs`): the same, plus the desktop app's address and
    token. Their checkout is a fresh worktree, which also lacks the folder's untracked `.env`;
  - **Run on my machine** (`run_target.rs`, `packages/editor/src/request-run.ts`): the request token's file and the
    instance. [run-on-my-machine.md](../proposals/run-on-my-machine.md) D3 says a request is "never an absolute path, a
    command line, an environment variable, a URL or code";
  - the editors' runs: the run's origin, breakpoints and channels from the editor service; VS Code and JetBrains add the
    IDE's own environment.
- **Copied commands carried no variable**: the retry command and its run options (`shared/retry-command.ts`), the
  reproduce recipe (`shared/reproduce.ts`), a selection's command. CI re-runs pass arguments only, and a CI action's
  fixed `inputs` can already carry a tenant per deployment environment (`shared/ci-actions.ts`).
- **One folder may be linked to several projects** in the desktop app: the links are per project id. The run still
  reports where the config sends it, and the editor service, which picks a project by folder, takes the lowest id
  without a word (`packages/editor/src/context.ts`).
- **The desktop app's folder check** read `projectName` only when the config writes it as a literal, so a computed name
  showed as unknown (`apps/desktop/src-tauri/src/inspect.rs`).

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
- **A value**: 1 to 500 letters, combining marks and digits of any script, spaces and `_ - . , : / @ + =`
  (`PLAIN_VALUE`), with no space at either end, none of the hidden characters a request refuses (`HIDDEN_CHARACTER` of
  `@piwitests/core/run-request`), and not starting with `//`. It holds a tenant, a region, a brand or an address. No
  `$` (an editor's task expands `${env:…}` and `${command:…}` in its environment), no `\` (a Windows or UNC path that
  points a loader at another machine's file), no quote, backtick or shell operator. The proposal allowed any text and
  an empty value; the review found what each opens, and Windows PowerShell removes a variable it sets to `''`.
- **At most 10 per project**, names once each.
- **Never a secret.** The value is stored as it is, shown in copied commands, in the desktop app and in a target's
  confirmation. The setting says so, and a secret stays in each machine's own `.env`.

One module of core holds these rules (`@piwitests/core/run-variables`: `parseRunVariables`, the name and value checks,
the refused names of D3 and the shell forms of D4), so the instance, the editor service and the dashboard check the
same way, and any problem refuses the whole list: a target never runs with part of a project's variables. The shell
checks again in Rust (`apps/desktop/src-tauri/src/run_variables.rs`) with the same lists and limits, held to core's by
`apps/application/tests/unit/run-variables-shell.test.ts`.

### D3. The names Piwi refuses

A run variable never sets a variable that changes which code runs, which shell or browser starts, which certificates
are trusted, or where results and requests go. Refused, whatever the case, since Windows reads names without it
(`REFUSED_RUN_VARIABLE_NAMES` and `REFUSED_RUN_VARIABLE_PREFIXES`):

- what finds or loads code: `PATH`, `PATHEXT`, `CLASSPATH`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, `_JAVA_OPTIONS`,
  and every name starting with `NODE_` (`NODE_OPTIONS`, `NODE_PATH`, `NODE_TLS_REJECT_UNAUTHORIZED`), `NPM_`, `YARN_`,
  `PNPM_`, `BUN_`, `COREPACK_`, `ELECTRON_`, `LD_`, `DYLD_`, `DOTNET_`, `COR_`, `CORECLR_`, `PYTHON`, `PERL`, `RUBY`;
- what a shell reads as it starts or runs a script: `SHELL`, `COMSPEC`, `ENV`, `IFS`, `PS4`, `SHELLOPTS`, `BASHOPTS`,
  `CDPATH`, `ZDOTDIR`, `PROMPT_COMMAND`, names starting with `BASH_` (`BASH_ENV` runs a file, and expands a command,
  as bash starts), and the programs a tool opens (`EDITOR`, `VISUAL`, `PAGER`, `LESSOPEN`, `LESSCLOSE`, `BROWSER`);
- Piwi's, Playwright's and git's own: `PIWI_`, `PLAYWRIGHT_`, `PW_`, `PWDEBUG`, and `GIT_` (`GIT_CONFIG_COUNT` sets any
  git setting, `core.fsmonitor` among them, for the git the reporter runs), and `SSH_` (`SSH_ASKPASS`);
- trust and the network: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `AUTO_PROXY`, `SOCKS_SERVER`,
  `SSLKEYLOGFILE`, how a host name resolves (`HOSTALIASES`, `LOCALDOMAIN`, `RES_OPTIONS`), names starting with `SSL_`
  or `OPENSSL_`;
- the libraries a browser or a build loads (`GTK_`, `VK_`, `LIBGL_`, `MESA_`, `QT_`, `GIO_`, `GST_`, `DBUS_`, `__`,
  `ESBUILD_`, `NAPI_RS_`, `COMPLUS_`, `GCONV_PATH`, `RUSTC_WRAPPER`, `MAVEN_OPTS`, `GRADLE_OPTS`, `JAVA_OPTS`), npm's
  prefix (`PREFIX`, `DESTDIR`, which point npm at another `npmrc`), Playwright's own (`PWTEST_`, `DEBUG_FILE`, which
  truncates a file), and the folders Windows installs programs in (`PROGRAMFILES` and its kin);
- what a shell runs or keeps to itself: `STTY` (zsh runs it), `PS0` to `PS4`, `UID`, `EUID`, `GID`, `EGID`, `PPID`,
  `USERNAME`, `_`, PowerShell's module path and execution policy, and the colors Piwi sets (`NO_COLOR`,
  `FORCE_COLOR`);
- the CI a run reports it ran in, which the reporter reads: `CI`, `TF_BUILD`, `JENKINS_URL`, `BUILD_NUMBER` and their
  kin, and names starting with `GITHUB_`, `GITLAB_`, `CI_`, `BITBUCKET_`, `BUILDKITE_`, `CIRCLE_`, `TRAVIS`,
  `APPVEYOR_`, `TEAMCITY_`, `DRONE_`, `SEMAPHORE_`, `CODEBUILD_`, `RUNNER_`;
- the folders and the display programs read: `HOME`, `HOMEDRIVE`, `HOMEPATH`, `USERPROFILE`, `APPDATA`,
  `LOCALAPPDATA`, `PROGRAMDATA`, `SYSTEMROOT`, `WINDIR`, `TMP`, `TEMP`, `TMPDIR`, names starting with `XDG_`,
  `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`.

The proposal named a shorter list; the build and its review added each variable a common runtime, shell or tool reads
to load code, run a command, write a file or send a request elsewhere. `ENV` stays allowed (`ENV=staging`): a
non-interactive shell does not read it, and no value can hold the `$(…)` an interactive one would run. The list is a
deny list, so it cannot be complete: what keeps the feature safe is that only a project's managers set the variables,
that values are plain text (D2), and that the person sees every variable before it applies: in the command they
copy, in the confirmation of **Run on my machine**, and in the question an editor asks (D7). A name it refuses is refused when the setting is
saved, and again by every target before it runs anything (D5, D6, D7).

### D4. Copied commands

Every command the dashboard shows for the project's tests starts with its run variables, in each shell form
([cross-platform rule](../apps/docs/AGENTS.md#cross-platform-shell-commands)):

- bash: `TENANT=acme npx playwright test …`, each value bare when it holds only plain characters, else single-quoted
  (`bashQuote`). A command of several `&&`-joined commands (one per Playwright project) sets them for each
  (`commandWithRunVariables`, `shared/run-variables.ts`), since `NAME=value a && b` sets it for `a` alone;
- PowerShell: `$env:TENANT='acme'; npx playwright test …`, which sets the variable for the rest of the session, each
  value single-quoted with `'` and the curly single quotes PowerShell reads as `'` doubled (`powerShellQuote`).

The retry commands of a run, a test and a selection, **Copy as command** in the desktop app, the fix plan's verification,
a saved selection's commands (`npx playwright test …` and `npx @piwitests/reporter run …`) and the Flake Lab commands
are copied by a button with no shell of its own, which waits for the project's variables before it copies: it copies the form of the shell the
viewer last picked in a command block (`useCommandShell`, kept in the browser), else the one of their computer. The reproduce recipe's test step carries both forms. Its bisect runs `env NAME=value …` in bash; in PowerShell it sets
the variables for the session before `git bisect run`, since Windows PowerShell 5.1 passes a native command's
arguments without escaping their quotes. The fix plan's Markdown, an issue's body and an auto-heal pull
request's verify command are documents: they show the bash form. The fix plan names the variables beside its verify
command (`verify.runVariables`) and the verify command itself stays bare, since the editor service reads it as Playwright
arguments. CI re-runs stay as they are: the pipeline picks its tenant through the CI action's `inputs`.

### D5. The desktop app's runs

The shell reads the project's run variables from its own server by project id (`GET /api/projects/:id/run-variables`,
on a connection that proved it holds the token), never from the window, checks them again (D3) and sets them on the
process before the variables it sets itself, never through a shell line. A read or a check that fails refuses the run
with its words:

- **local runs**: Re-run, **Run with options…** and the tray's runs (`desktop_run_local_tests`);
- **Reproduce, Bisect and Flake Lab**: the test step of the worktree job, and the `piwi flake` process that starts
  Playwright. The install step (`npm ci` and the like) gets none: building belongs to the config (D8);
- **a bug report's reproduction** (`repro.rs`), its listing of the project's tests included, since the config may read
  them.

The run's line in the tray and the commands **Run with options…** shows start with the variables in the bash form of
D4.

### D6. Run on my machine

The variables reach a target the way the folder hints of
[run-on-my-machine.md](../proposals/run-on-my-machine.md) do, never as a field of the request, which an older target's
parser refuses:

- `GET /api/run-targets/requests/:id/run-variables` answers the target that claimed the request with the project's run
  variables;
- a target that applies them says so with each claim (`POST /api/run-targets/requests/:id/claim`, body
  `{ features: ['run-variables'] }`), and the instance keeps it on the request (`claim_features`). A claim without the
  feature of a request of a project with run variables answers 409 and leaves the request waiting for an app that
  applies them, with words that say to update the app, which the requester reads if no app takes it; **Run** on a
  request claimed without the feature, whose project set variables since, ends it as `refused` with the same words.
  The proposal had the target declare the feature when it describes itself (`PUT /api/run-targets/self`); the review
  found that a stored description outlives a downgrade, and that ending the request at an older app's claim could
  take it from an updated app of the same person. An instance that predates the feature ignores the claim's body and
  answers 404 for the variables: its projects set none;
- the editor service's plan (`request-run.ts`) checks the list with `parseRunVariables` and fails its `variables` check
  with the problems when it does not pass, or when it cannot be read; the next check reads a list it could not read
  again;
- the confirmation lists them among its checks and shows them in the command, `TENANT=acme npx playwright test …`
  (PowerShell's form on Windows). **Run** reads them again: when they changed since the window showed the command, it
  shows the new command instead of running. The shell takes them with the command from its server at launch
  (`POST /api/desktop/run-target/requests/:id/launch`, `runVariables`), never from the window, and checks them again.

This amends [run-on-my-machine.md](../proposals/run-on-my-machine.md) D3 and the recommendation of
[1.0-stabilization.md](../proposals/1.0-stabilization.md) D64 for this case only: a request still never carries a
command line, a path, a URL or code, and the variables it is run with are the project's, checked by the target and shown
to the person before anything runs.

### D7. The editors' runs

Once it knows the project, the editor service reads its run variables (`GET /api/projects/:id/run-variables`, a call
it did not make before: it names projects from `/api/projects/menu`) once per refresh, and sets them on every command it
builds for the project's tests: runs by location, by test, a selection, a debug run and the runs an agent starts. The first run of a set asks the person (`window/showMessageRequest`, which both clients' language-server
support shows: **Allow** or **Not now**), once per set while the service runs, except on the desktop app's own server,
whose projects are theirs; nothing runs with a set they did not allow. A run waits for the read, and for a project a
refresh is resolving; with no project known (the instance unreachable), it starts with none and the person hears it
once. A list that does not pass `parseRunVariables`, or that the instance did not answer, runs nothing and says why
(`piwi/notice`); a read that failed is asked again by the next run. The Flake Lab commands and the fix plan's
verification above a test are left out until the set is allowed. The proposal applied them silently; the review found
that an editor's run, unlike a copied command or a requested run, showed them nowhere. VS Code
passes them to the task's environment and JetBrains to `withEnvironment`, as they pass the service's own variables; the
clients needed no change. An instance that predates them answers 404: its projects set none. A run started in a
terminal is the person's: Piwi sets nothing there, and the listing of a config's tests for the test tree sets none.

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

- the desktop app's **Local folder** section names the other projects linked to the same folder
  (`desktop_folder_projects`, by project id from the shell's links);
- the folder check says when the config computes `projectName` rather than writing it out, since the shell reads it
  only as a literal;
- which project an editor follows for a folder linked to several stays an open question (below): the lowest id.

## Surfaces

1. **Project → Settings → Run variables**, a section of `PROJECT_SETTINGS_SECTIONS` (`shared/app-places.ts`) in the
   project group: a list of name and value rows, **Add a variable**, the checks of D2 and D3 as the person types, the
   note that values are never secret, a command in each shell, and the config pattern of D8 in its help. Saved with
   `project:manage`.
2. **The commands**: every command of D4 starts with the variables.
3. **The desktop app**: the run's line in the tray and the commands of **Run with options…**, the other projects of
   the folder in **Local folder** and a computed project name in its checks (D9).
4. **A target's confirmation**: a `variables` check and the command with its variables (D6).

## The instance's routes

- `GET /api/projects/:id` gains `runVariables: { name, value }[]`; `PATCH /api/projects/:id` takes it, checked by D2
  and D3 (`project:manage`), a refused list answering 400; `GET /api/projects/:id/run-variables` answers
  `{ runVariables }` (`project:read`) to the shell, the editor service and the dashboard's copy buttons. The demo's
  handlers and seed mirror them.
- `GET /api/run-targets/requests/:id/run-variables` (target key, `run:receive`, the request claimed by this target).
- `POST /api/run-targets/requests/:id/claim` takes `{ features }`, kept on the request.

## Security

- **Who sets them**: a project's managers, on the team instance. What they set runs on teammates' machines through
  **Run on my machine** and the editors, so values are plain text (D2), the refused names of D3 keep out what a known
  runtime or tool reads, and the person sees every variable before it applies: the command they copy, the
  confirmation, the editor's question.
- **Checked twice**: on save, and by every target before it runs (the editor service's plan and runs, the shell), so an
  instance that sends a refused name, or an older one that does not check, runs nothing with it.
- **Never a secret**: values are shown and copied. The setting says so; a secret stays in the machine's `.env`.
- **Nothing reaches a shell**: the desktop app and Piwi Runner pass the variables as the process's environment, before
  their own, never through a shell line; the copied commands quote each value.
- **No older app runs without them**: a claim that does not say it applies them never takes a request of a project that
  sets some, and **Run** checks the claim's word again.

## What changes in other records

- [run-on-my-machine.md](../proposals/run-on-my-machine.md) D3: "never an environment variable" gains "but the
  project's run variables of [run-variables.md](run-variables.md) D6".
- [1.0-stabilization.md](../proposals/1.0-stabilization.md): D64's recommendation gains the same exception, and D67
  lists `runVariables` on the project, its route, the `run-variables` target route and feature, and the refused names.
- [developer-loop-audit.md](../proposals/developer-loop-audit.md) R7 (a project linked through a monorepo subfolder
  cannot reproduce, bisect or run Flake Lab) is unchanged: it is
  [#1516](https://github.com/PiwiTests/piwi/issues/1516).

## Delivery

1. **The setting and the commands**: core's `run-variables` module, the project field with its migration and API, the
   settings section, the copied commands (D4), the demo's seed and handlers, the docs (the setting, the config pattern
   of D8).
2. **The desktop app's runs** (D5) and the folder's other projects (D9).
3. **Run on my machine** (D6): the route, the target feature, the plan's checks, the confirmation, and the amendments
   of the other records.
4. **The editors** (D7).

All four shipped together.

## Open questions

- **Values per deployment environment**: a project whose tenant also differs by environment (staging, production)
  would need a value per environment. Not needed by the team that asked; a later addition to D2 if it comes up.
- **An editor's project for a folder linked to several**: the editor service takes the lowest id. It could follow
  the project whose run variables match the workspace's environment, or a setting that names the project.
- **The desktop app's own projects**: the desktop app runs its own server and projects. Whether a project linked to a
  team instance's project could take that project's run variables, rather than set them twice, is left for later.
