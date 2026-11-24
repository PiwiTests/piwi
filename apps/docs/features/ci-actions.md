---
title: CI actions
description: "The named ways a project starts CI from the dashboard: a GitHub workflow, a GitLab or Bitbucket pipeline, a Jenkins job or a Custom request, with their inputs, credential and Check."
lang: en-US
---

# CI actions

<Needs reporter />

A CI action is a named way for a project to start CI: the run button's [Re-run in CI](./ci-rerun) and the MCP tool
`rerun_cluster_in_ci` go through one. They are **off by default** and set per project in the **CI** section of the
project's **Settings** tab (under Integrations, beside **Issue tracker**).

## What an action has

A CI action has:

- a **name**, unique in the project, ignoring case;
- a **target**: a GitHub workflow, a GitLab or Bitbucket pipeline, a Jenkins job or a Custom request;
- **inputs**: a *fixed* value (`TARGET_ENV=staging`) or a *choice* with a default and options. They are sent beside the
  Playwright arguments, never inside them: as workflow inputs on GitHub, variables on GitLab and Bitbucket, and
  parameters on Jenkins. A name is letters, digits and `_`, and on GitLab and Bitbucket cannot start with `CI_`,
  `GITLAB_` or `BITBUCKET_`. A Custom request sends none;
- what it **accepts**: re-runs, Run on CI, Flake Lab;
- an optional **environment**, one of the project's [environments](./environments), which a run of that environment
  picks first;
- the kinds it is the **default** for.

Unless you pick another, a dispatch uses the action that started the run it re-runs, else the one of the run's
environment, else the project's default. A repository action serves only a run whose repository is on that host; a CI
server action serves any run. Settings saved before CI
actions existed were converted when read.

**Check** reads an action's target without starting it and says whether it declares every name a dispatch sends, the
inputs included. It reads a GitHub workflow file and a Jenkins job; GitLab and Bitbucket pipelines and Custom requests
cannot be read, and Check says so.

Two actions on one workflow, one per environment, differ only in their inputs:

```yaml
on:
  workflow_dispatch:
    inputs:
      args: { description: Playwright arguments, default: '' }
      TARGET_ENV: { description: Environment under test, default: staging }
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright test ${{ inputs.args }}
        env:
          TARGET_ENV: ${{ inputs.TARGET_ENV }}
```

*Smoke · staging* and *Smoke · production* both target `e2e.yml`, each with one fixed input, `TARGET_ENV=staging` or
`TARGET_ENV=production`.

## Repository host

Choose the provider of the action:

| Provider | What the target names | Token scope |
|---|---|---|
| **GitHub** | Workflow file name (e.g. `e2e.yml`), a ref, the `workflow_dispatch` input that receives the arguments, and optionally the input that receives the dispatch id | **Actions: write** (fine-grained), `repo` (classic) |
| **GitLab** | A ref and the pipeline variable name that receives the arguments | `api` |
| **Bitbucket** | The `custom:` pipeline name and the variable name that receives the arguments | `pipeline:write` |

The dispatch, and a GitHub action's **Check**, carry the action's **Credential**, else the repository's
[SCM credential](/guide/source-control#set-the-credential), with the scope above.

On GitLab and Bitbucket, name the variable `PIWI_RERUN_ARGS` and run [`rerun`](/reference/cli#rerun), which reads the
quoted arguments without a shell:

::: code-group

```yaml [GitLab]
e2e: # the job that runs your tests
  variables:
    PIWI_RERUN_ARGS: "" # empty runs the whole suite; a re-run sets it
  script:
    - npm ci
    - npx @piwitests/reporter rerun
```

```yaml [Bitbucket]
pipelines:
  custom:
    rerun: # the custom pipeline name in the Bitbucket block
      - variables:
          - name: PIWI_RERUN_ARGS
      - step:
          script:
            - npm ci
            - npx @piwitests/reporter rerun
```

:::

GitHub answers with the run it started, which the link opens; a server that answers none (an older GitHub Enterprise
Server) links to the workflow's runs page for the branch. GitLab and Bitbucket link to the pipeline.

## CI server

A CI server action is a **preset**, which builds the request from a few fields, or a **Custom request** you write.

**Jenkins** takes the job as Jenkins shows its path (`polaris/e2e`; `polaris/e2e/{branch}` for a multibranch pipeline)
and posts to its `buildWithParameters` with `PIWI_RERUN_ARGS` (the arguments) and `PIWI_ORIGIN_REF` (the dispatch id),
names you can change, plus the action's inputs. The credential is a Jenkins user and their API token, sent as Basic
authentication. The link goes to the job's page. The job declares both parameters and runs `rerun`:

```groovy
pipeline {
  agent any
  parameters {
    string(name: 'PIWI_RERUN_ARGS', defaultValue: '', description: 'Playwright arguments of a re-run')
    string(name: 'PIWI_ORIGIN_REF', defaultValue: '', description: 'The dispatch Piwi matches the run to')
  }
  stages {
    stage('e2e') {
      steps {
        sh 'npm ci'
        sh 'npx @piwitests/reporter rerun'
      }
    }
  }
}
```

**Check** reads the Jenkins job as it is in the form, unsaved fields included. Jenkins drops a parameter its job does
not declare, so a re-run would fail or never be matched. A Pipeline job declares its Jenkinsfile's parameters on its
first build: run a new job once, then check it. A multibranch pipeline is checked on its default branch.

### Flake Lab on Jenkins

A Jenkins action that accepts Flake Lab receives `flake 12` or `flake verify 12` in its arguments parameter and hands
it to the reporter, which reads `PIWI_DASHBOARD_URL` and `PIWI_API_KEY`:

```groovy
pipeline {
  agent any
  parameters {
    string(name: 'PIWI_RERUN_ARGS', defaultValue: '', description: 'flake 12, or flake verify 12')
    string(name: 'PIWI_ORIGIN_REF', defaultValue: '', description: 'The dispatch Piwi started')
  }
  environment {
    PIWI_DASHBOARD_URL = 'https://piwi.example.com'
    PIWI_API_KEY = credentials('piwi-api-key')
  }
  stages {
    stage('flake') {
      steps {
        sh 'npm ci'
        sh 'npx playwright install --with-deps chromium'
        sh 'npx @piwitests/reporter $PIWI_RERUN_ARGS'
      }
    }
  }
}
```

On a Windows agent use `bat` steps and read `%PIWI_RERUN_ARGS%`.

### Custom requests

**Customize the request** turns the preset into a Custom request that sends the same thing, to edit from there. A
Custom request is JSON: `auth` (`none`, `basic`, `bearer`, or `{ "header": "X-Token" }`) and a `rerun` request with a
`method` (`POST` or `PUT`), a `path` relative to the base URL, and optional `query`, `headers`, `body`, `link` and
`buildNumber`. Its values may name these placeholders:

| Placeholder | Value |
|---|---|
| <code v-pre>{{args}}</code> | The Playwright arguments, or `flake 12` for Flake Lab |
| <code v-pre>{{dispatchId}}</code> | The dispatch id the run hands back as `PIWI_ORIGIN_REF` |
| <code v-pre>{{ref}}</code> | The branch asked, else the run's (the project's for its whole suite), else the action's |
| <code v-pre>{{commit}}</code> | That run's commit, else empty |
| <code v-pre>{{branchJob}}</code> | The branch as Jenkins names a branch job (`feature/x` is `feature%2Fx`) |

A placeholder in a path is percent-encoded inside its segment, and a value that would add a `.` or `..` segment is
refused. In a JSON body it fills a whole string value.

### The credential and the hosts

A CI server action names a [credential](/operate/credentials): a user, a secret and the base URL it may be sent
under, saved once, shared with projects, and logged on each use. Its base URL can stay empty to use the credential's. A
request carrying it sends only the inputs it allows; **Check** names the ones left out. With no credential, a preset's
request under `PIWI_CI_SERVER_URL` carries the instance's (`PIWI_CI_SERVER_USER`, `PIWI_CI_SERVER_TOKEN`) and sends
only the inputs `PIWI_CI_SERVER_ALLOWED_INPUTS` lists. A base URL or request path is refused when a segment would climb
once a server decodes it (`..%2F`, `..;`).

A request never follows a redirect, and a link from the answer is kept only as an `http(s)` URL or a path from the
base URL's root. A CI server is reached over `https`; over `http` or on a private address it is reached only when
it is the host and port of `PIWI_CI_SERVER_URL` or is listed in `PIWI_CI_SERVER_HOSTS` (the desktop app reaches any
address). See the [configuration reference](/reference/configuration).

## Related

- [Re-run in CI](./ci-rerun): the run button and dialog that dispatch an action, and how its run is matched
- [Source control](/guide/source-control): the SCM credential and its scopes
- [Credentials](/operate/credentials): the credential a CI server action names
- [Flake Lab](./flake-lab): the experiment a Flake Lab action runs in CI
- [CLI](/reference/cli#rerun): the `rerun` command a pipeline runs
