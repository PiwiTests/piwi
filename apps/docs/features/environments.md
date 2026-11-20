---
title: Environments
description: "The deployments a project's Playwright tests run against, kept as records of the project: how a run's label finds its environment, and what a run Piwi starts for one gets."
lang: en-US
---

# Environments

An environment is a deployment of the application a project's tests run against: Local, Integration, Staging,
Production. Each one is a record of the project, with a key, a name and its own [run variables](./run-variables). A
run's label files it under one, and a run Piwi starts, or a command it gives to copy, can be for one.

## What an environment holds

A project admin keeps the list in **Project → Settings → Environments**:

- **Key**: the label its runs report (`staging`), unique in the project ignoring case: 1 to 80 letters, digits,
  spaces and `_ - . , : / @ + =`. A changed key stays as an alias.
- **Name**, shown in the pickers and the project's filters (`Staging`), and a **description** for the team ("data
  reset every night at 02:00").
- **Aliases**: up to 20 other labels that name it (`stg`), or patterns where `*` matches any run of characters
  (`pr-*`).
- **Run variables**: up to 10, set over the project's on the runs Piwi starts for it.
- **Built from the checkout**, the **env file**, **protected** and its **required tags**: the sections below.
- **The order** every picker shows.

<figure>
  <img src="/screenshots/project-environments-settings.png" alt="Project Settings, Environments: Local, Integration, Staging and a protected Production, each with its key, aliases, run variables and env file, then a discovered preview environment">
  <figcaption>Four declared environments and a discovered one.</figcaption>
</figure>

**Archive** takes an environment out of the pickers: its runs keep it, and no run Piwi starts can be for it.
**Delete** removes it: its runs keep their label and lose their environment, and the next run that reports the label
adds it back as a discovered one. Archive it to keep a label from coming back. Deleting one a URL pattern or CI action
names is refused.

## How a run's label resolves

A run's label is the reporter's `environment` option, else `PIWI_ENVIRONMENT`
([Reporter options](/reference/reporter-options)). Piwi keeps it as it came, trimmed and cut at 200 characters, and
resolves it once, when it stores the run:

1. no label: no environment;
2. the environment whose key equals the label, ignoring case;
3. else the one with an alias equal to it, ignoring case;
4. else the first, in the list's order, with a `*` alias that matches it.

A label nothing takes adds a **discovered** environment, with the label as its key and name, so a project whose
settings nobody opened still gets a complete list. A project holds at most 50 discovered environments and 100 in all;
past that, a run keeps its label and has no environment. A discovered environment stays marked as such until a project
admin saves it.

Saving an environment resolves the project's runs again. Adding `stg` as an alias of Staging moves the runs that
reported `stg` to Staging, and removes the discovered `stg` that held them.

## Default environment

The project page's **Filters** and status filter offer its environments, the labels none takes, and **No environment**;
Staging keeps the runs resolving to it, `stg` included. With a **default environment**, set below the list, the project
page, its tabs, [Analytics](./analytics#environment-policy), [quarantine candidates](./flaky-tests#quarantine-with-a-way-out)
and pull-request feedback read only its runs, never one with no environment, until you pick another or **All
environments**, like the [default branch](./branches#filtering-by-branch). A copy carries it to a project with none.

## Choose the environment of a run

Each place Piwi starts a run offers the project's environments that are not archived, and **None**. With **None**,
Piwi applies the project's run variables only and sets no label: the config decides, as in a terminal.

A run Piwi starts for an environment gets:

- **the run variables**: the project's, then the environment's, which wins for a name both set; at most 20, checked as
  one list by every app that runs the tests, which runs nothing when one is refused;
- **`PIWI_ENVIRONMENT`** set to the environment's key, which the reporter sends as the run's label. A config that sets
  the reporter's `environment` option reports that one instead;
- for a protected environment, the filter of its [required tags](#protected-environments).

Where you pick it:

- **Copied commands**: in **Copy retry command**'s options on a run, under **More** on an execution, and beside
  selection, locator and Flake Lab commands, starting on the environment of the run the page shows, unless protected
  or archived, else **None**.
- **[Run on my machine](./run-on-my-machine)**: the request's window offers the same picker, and the app's
  confirmation names the environment and lists its variables.
- **[The desktop app](./desktop)**: its runs offer the environments of the project the folder is linked to. A folder
  also linked to a project of a team instance offers that project's environments too, read from the team instance at
  each run and never kept on the machine.
- **[The editors](./editors)**: VS Code and JetBrains run with the environment picked for the workspace folder. The
  **Allow** question the editors ask covers each new set of values, an environment's included.

A command copied for Staging:

::: code-group

```bash [Linux / macOS]
TEST_ENV=staging BASE_URL=https://staging.example.com PIWI_ENVIRONMENT=staging npx playwright test tests/checkout.spec.ts
```

```powershell [Windows (PowerShell)]
$env:TEST_ENV='staging'; $env:BASE_URL='https://staging.example.com'; $env:PIWI_ENVIRONMENT='staging'; npx playwright test tests/checkout.spec.ts
```

:::

## The Playwright config

Piwi never reads or changes the config: the config reads the variables. The common pattern, with one `.env` file per
environment for its secrets:

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

With it, Piwi's Staging holds `TEST_ENV=staging` and the env file `.env.staging`, and its key is `staging`, the label
the config reports. CI sets `TEST_ENV` and the secrets itself. `dotenv` never overrides a variable already set, so the
values Piwi sets win over the file's.

## Built from the checkout, or deployed

An environment is **built from the checkout** when the application under test comes from the same commit as the tests:
a `webServer` in the config, a preview deployment of the pull request. Any other is
[deployed](./deployed-environments): Piwi reads the application's commit its runs tested.

## Secrets and the env file

An environment holds no secret: its values show in every copied command and confirmation. A secret stays in the
machine's own file, ignored by git, or in the CI's secret store. The **env file** names that file: `.env`, then parts
after a dot (`.env.staging`), never a folder. Piwi never reads it and never sends it:

- the desktop app's folder check says when the file is missing in the linked folder;
- Reproduce, Bisect and Flake Lab run in a worktree, which holds no untracked file: they copy the env file into it from
  the linked folder, and delete it with the worktree.

## Protected environments

A protected environment, Production as a rule, holds at least one required tag (`@smoke`). Every run Piwi starts
against it:

- **runs only the tests carrying one of its required tags**, and the setup and teardown projects they depend on, which
  Playwright runs whole: Piwi adds a `--grep-invert` that leaves out every other test, and keeps the run's own filter.
  The command shown carries it. On Windows, PowerShell may break its quoting when `npx` resolves to `npx.cmd`: start
  these runs from the desktop app or Run on my machine;
- **is confirmed**, its name shown, in the desktop app, the app taking a Run on my machine request and the editors'
  question;
- **is started by a project admin only**: the instance gives a protected environment's run variables, and takes a
  request naming it, only to someone holding `project:manage`. For anyone else the pickers show it locked, and the
  list hides its variables;
- **is never picked by default**: a re-run of one of its runs, and a command on its run's page, start on **None**;
- **is never an agent's**: an agent's request naming it is refused.

These rules govern what Piwi starts. A command you type in a terminal stays yours.

## Copy from another project

**Copy from another project**, in **Project → Settings → Environments**, copies the declared environments of a project
you can read into one you manage: every field, at the end of its list. An environment whose key or one of its aliases
the project already names is left as it is, and listed. Nothing links a copy to its source: a value that differs per
project, such as a tenant's `BASE_URL`, is edited on each copy.

## The run page's warnings

The run page names the run's environment, and says when the run may not have tested it:

- **Started for Staging; the config reported production.** A run requested for one environment whose label resolved
  to another, or to none: the config's `environment` option wins over `PIWI_ENVIRONMENT`, so a config that writes
  its own label reports it.
- **The tests opened http://localhost:3000, which no URL pattern of Staging matches.** The run's Playwright `baseURL`
  is outside every [URL pattern](./extension-connection#url-patterns) of its environment, which catches a config that
  ignores the variables. It shows only for an environment some URL pattern names.

## Limits

- Each project has its own environments: a Staging in two projects is two records, kept apart.
- A filter (notifications, issue automation, test management) keeps keys and `*` patterns, matched against a run's
  environment key and aliases.

## Related

- [Run variables](./run-variables)
- [Run on my machine](./run-on-my-machine)
- [Desktop app](./desktop)
- [Run environment](./run-environment): where a run executed
- [Environment incidents](./environment-incidents): runs that failed because the app was down
- [Glossary: environment](/guide/concepts#environment)
