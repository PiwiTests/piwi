---
title: Run variables
description: 'Environment variables a project sets on every Playwright run Piwi starts for it, and at the start of every command it gives to copy: the tenant, region or brand one app serves several projects from.'
lang: en-US
---

# Run variables

Run variables are a few environment variables, `NAME=value`, that a project sets on every run Piwi starts for its
tests and at the start of every command it gives to copy. They are for one app that serves several projects from one
folder: each tenant is a project of the instance, and its tests need `TENANT=acme` to build, start and test the right
one.

## Set them

A project admin sets them in **Project → Settings → Run variables**: up to 10 rows of a name and a value, checked as
you type.

- **A name** is capital letters, digits and `_`, not starting with a digit, 64 characters at most, each name once.
- **A value** is at most 500 characters, with no line break or invisible character. An empty value sets the variable
  to an empty string.
- **Never a secret.** Every copied command and every confirmation shows the values. A secret stays in each machine's
  own `.env`.
- **Refused names**: a run variable never sets a variable that changes which code runs, which browser starts, which
  certificates are trusted or where results and requests go. `PATH`, `HOME`, `NODE_OPTIONS`, `BASH_ENV`,
  `HTTPS_PROXY` and `COMSPEC` are refused, and so is every name starting with `PIWI_`, `PLAYWRIGHT_`, `NODE_`, `NPM_`,
  `GIT_`, `LD_` or `DYLD_`, among others. Windows reads names whatever their case, so `Path` is `PATH`.

The settings save refuses a list with one refused name whole, and each app that runs the tests checks the list again
before it runs anything: a name refused there runs nothing, rather than run without it.

## Where they apply

- **Copied commands**: the retry commands of a run, a test and a selection, **Copy as command** in the desktop app,
  the verify command of a fix plan, a saved selection's command, and the test step of the reproduce recipe. In bash a
  command starts with the variables (`TENANT=acme npx playwright test …`); in PowerShell it sets them for the rest of
  the session first (`$env:TENANT='acme'; npx playwright test …`). A copy button copies the form of the shell you last
  picked in a command block, else your computer's. The Markdown of a fix plan, an issue and an auto-heal pull request
  show the bash form.
- **The desktop app's runs**: Re-run, **Run with options…**, Reproduce, Bisect, Flake Lab and a bug report's
  reproduction. The app reads the variables of its own project when it starts each run, never from the page, and the
  run's line in **Local runs** shows them. The install step of a checkout gets none.
- **[Run on my machine](./run-on-my-machine)**: the confirmation lists them among its checks and starts the command with
  them. **Run** reads them again: when one changed since the window showed the command, it shows the new command
  instead of running. An app too old to apply them refuses the request with words that say to update it, rather than
  run the default tenant.
- **The editors' runs**: VS Code and JetBrains run a test, a file, a selection, a debug run and the runs an agent starts
  with the variables of the project their folder follows. A run you start in a terminal is yours: Piwi sets nothing
  there.

A re-run in CI passes arguments only: a CI action picks its tenant with its fixed inputs, per
[deployment environment](./ci-rerun).

## Building and starting the app

Piwi runs no command of a project's settings before a run. Building and starting the app for a tenant belong in the
Playwright config, so CI, a terminal, the editors and every Piwi run take the same steps, reviewed with the code:

```ts
const tenant = process.env.TENANT ?? 'acme';
const port = { acme: 3001, globex: 3002 }[tenant] ?? 3000;

export default wrapConfig(
  defineConfig({
    use: { baseURL: `http://localhost:${port}` },
    webServer: {
      command: 'npm run build && npm start',
      env: { TENANT: tenant, PORT: String(port) },
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
    },
  }),
  { projectName: `shop-${tenant}` },
);
```

A port for each tenant keeps `reuseExistingServer` from reusing a server another tenant started. The project name the
config computes sends each run to its tenant's project.

## One folder, several projects

The desktop app links one folder to as many projects as you like. **Local folder** in a project's settings names the
other projects linked to its folder, and says when the config computes its project name rather than writing it out.
An editor follows one project per folder: the one with the lowest id.

## Limits

- One value per project: a project whose tenant also differs by deployment environment needs a project per pair.
- The commands the MCP tools return name no variable. The fix plan lists the project's run variables beside its verify
  command.
- Listing the tests of a config for the editors' test tree sets no variable.

## Related

- [Run on my machine](./run-on-my-machine)
- [Desktop app](./desktop)
- [Re-run in CI](./ci-rerun)
- [Test selections](./test-selection)
- [Glossary: run variable](/guide/concepts#run-variable)
