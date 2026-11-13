---
title: Re-run in CI
description: "Re-run a cluster's affected tests in CI from the dashboard: a GitHub workflow, a GitLab or Bitbucket pipeline, or a Jenkins job or any CI server reached by one HTTP request."
lang: en-US
---

# Re-run in CI

<Needs reporter />

A [filtered run that passes every affected test closes a cluster](./failure-clusters#did-the-fix-work). The cluster page
can trigger that run in CI: **Re-run in CI**, next to *Copy retry command*, dispatches a workflow, pipeline or job with
the cluster's retry arguments (each affected test's `file:line` from its latest failure, and the projects it failed
in) on the branch of the cluster's latest run, and links to the run it started. The configured ref is used only when
that run has no branch. An execution's Verify section offers **Re-run this test in CI** beside **Re-run the
cluster in CI**; both are recorded as the cluster's last re-run, which says where it went, when, by whom, and links to
the build.

It is **off by default** and configured per project in the **CI** section of the project's **Settings** tab (under
Integrations, beside **Issue tracker**): a list of named [CI actions](#ci-actions), each saying where Piwi starts CI and
what it sends.

Its buttons show to people with [`run:control`](/operate/project-access#what-each-role-can-do) once an action serves the
run; through the repository, an SCM token must be set too.

*Copy retry command* is the local counterpart: it copies an `npx playwright test` command to run the same tests on your
machine. On a run's page, its menu adds run options the browser remembers (headed, trace, repeat each up to 10 without
retries, workers up to 4), and one project the tests ran in.

An action that accepts **Flake Lab** runs `piwi flake` for one flaky test: [Run it in CI](./flake-lab#run-it-in-ci)
shows the GitHub workflow, and [Flake Lab on Jenkins](#flake-lab-on-jenkins) the Jenkins job.

## CI actions

A CI action is a named way to start CI. It has:

- a **name**, unique in the project, ignoring case;
- a **target**: a GitHub workflow, a GitLab or Bitbucket pipeline, a Jenkins job or a Custom request;
- **inputs**: a *fixed* value (`TARGET_ENV=staging`) or a *choice* with a default and options. They are sent beside the
  Playwright arguments, never inside them: as workflow inputs on GitHub, variables on GitLab and Bitbucket, and
  parameters on Jenkins. A name is letters, digits and `_`, and on GitLab and Bitbucket cannot start with `CI_`,
  `GITLAB_` or `BITBUCKET_`. A Custom request sends none;
- what it **accepts**: re-runs, Run on CI, Flake Lab;
- an optional **environment**, such as `staging`, which a run in that environment picks first;
- the kinds it is the **default** for.

A button uses the action of the run's environment, else the project's default for what it starts; MCP and the API can
name another by id or name. A
repository action serves only a run whose repository is on that host; a CI server action serves any run. Settings
saved before CI actions existed were converted when read: each configured target is now an action, and nothing needs
re-entering.

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
| **GitHub** | Workflow file name (e.g. `e2e.yml`), a ref, the `workflow_dispatch` input that receives the arguments, and optionally the input that receives the dispatch id | `actions:write` (a classic PAT's `workflow` scope) |
| **GitLab** | A ref and the pipeline variable name that receives the arguments | `api` |
| **Bitbucket** | The `custom:` pipeline name and the variable name that receives the arguments | `pipeline:write` |

The dispatch uses the project's [SCM token](/guide/source-control) with the scope above.

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

GitHub returns no run id, so its link goes to the workflow's runs page for the branch; GitLab and Bitbucket link to
the pipeline.

## CI server

A CI server action is a **preset**, which builds the request from a few fields, or a **Custom request** you write.

**Jenkins** takes the job as Jenkins shows its path (`polaris/e2e`; `polaris/e2e/{branch}` for a multibranch pipeline)
and posts to its `buildWithParameters` with `PIWI_RERUN_ARGS` (the arguments) and `PIWI_ORIGIN_REF` (the dispatch id),
names you can change, plus the action's inputs. The credential is a user and their API token, sent as Basic
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
| <code v-pre>{{dispatchId}}</code> | The dispatch id, which the run hands back as `PIWI_ORIGIN_REF` |
| <code v-pre>{{ref}}</code> | The branch of the cluster's latest run, else the default branch you set |
| <code v-pre>{{commit}}</code> | The commit of that run, else empty |
| <code v-pre>{{branchJob}}</code> | The branch as Jenkins names a branch job (`feature/x` is `feature%2Fx`) |

A placeholder in a path is percent-encoded inside its segment, and a value that would add a `.` or `..` segment is
refused. In a JSON body it fills a whole string value.

### The credential and the hosts

The **CI server token** is one write-only field of the **CI** section: leave it empty to keep it. It is stored with the
one base URL the CI server actions send under (an action's own, else `PIWI_CI_SERVER_URL`), which the field states, and
sent only under it. Saving it while the actions use more than one base URL is refused. A project without a token uses
the instance's (`PIWI_CI_SERVER_USER`, `PIWI_CI_SERVER_TOKEN`), only with a preset's request under that URL, and then
sends only the inputs the operator lists in `PIWI_CI_SERVER_ALLOWED_INPUTS` (comma-separated, empty by default);
**Check** names the ones left out. A base URL or request path is refused when a segment would climb once a server decodes
it (`..%2F`, `..;`).

A request never follows a redirect, and a link from the answer is kept only as an `http(s)` URL or a path from the
base URL's root. A CI server is reached over `https`; over `http` or on a private address it is reached only when
it is the host and port of `PIWI_CI_SERVER_URL` or is listed in `PIWI_CI_SERVER_HOSTS` (the desktop app reaches any
address). See the [configuration reference](/reference/configuration).

## Matching the run

When the re-run finishes, Piwi recognizes it and records its [origin](/reference/test-metadata#run-origin) as `ci-rerun`.
A Jenkins job matches by the dispatch id it passes on as `PIWI_ORIGIN_REF`; a Custom request by that id too, or by the
build number its `buildNumber` pointer reads from the answer. GitLab matches by its pipeline id and Bitbucket by its
build number; GitHub by the dispatch id when the workflow passes it on. Once matched, the last dispatch links to the
build the run recorded.

GitHub rejects an input the workflow does not declare, so the dispatch id input is optional. Declare it and hand it to
the reporter as `PIWI_ORIGIN_REF`:

```yaml
on:
  workflow_dispatch:
    inputs:
      args:
        required: false
        default: ''
      piwi_dispatch:
        required: false
        default: ''
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright test ${{ inputs.args }}
        env:
          PIWI_ORIGIN_REF: ${{ inputs.piwi_dispatch }}
```

Without it, a run is matched on its branch, a start within six hours of the dispatch, and exactly the dispatched spec
files.

## Limits

- A dispatch is one request: Piwi does not poll the CI, it waits for the run to report.
- The demo runs only CI server actions: it records a dispatch without sending it, and its Check answers as a job that
  declares the default parameters.

## Related

- [Pull-request feedback](./pr-feedback): the result posted on the pull request
- [Source control](/guide/source-control): the SCM token and its scopes
- [Failure clusters & the inbox](./failure-clusters): the clusters a re-run acts on
- [Flake Lab](./flake-lab): the experiment a Flake Lab action runs in CI
- [CLI](/reference/cli#rerun): the `rerun` command a pipeline runs
