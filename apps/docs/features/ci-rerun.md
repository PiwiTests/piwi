---
title: Re-run in CI
description: "Re-run a cluster's affected tests in CI from the dashboard: a GitHub workflow, a GitLab or Bitbucket pipeline, or a Jenkins job or any CI server reached by one HTTP request."
lang: en-US
---

# Re-run in CI

<Needs reporter />

Once a cluster is fixed, the fastest way to prove it is to re-run the affected tests, and a
[filtered run that passes them all closes the cluster](./failure-clusters#did-the-fix-work). The cluster page can
trigger that run in CI: **Re-run in CI**, next to *Copy retry command*, dispatches a workflow, pipeline or job with
the cluster's retry arguments (each affected test's `file:line` from its latest failure, and the projects it failed
in) on the branch of the cluster's latest run, and links to the run it started. The configured ref is used only when
that run recorded no branch. An execution's Verify section offers **Re-run this test in CI**, for that test at its
line and in its project, beside **Re-run the cluster in CI**; both are recorded as the cluster's last re-run. In the
Verify section, the last dispatch says where it went (_dispatched to Jenkins_), when, by whom, and links to the build.

It is **off by default** and configured per project in the **Source control** section of the project's **Settings** tab,
under **CI re-run**. Turn it on and pick what it dispatches through:

- **Repository host**: the CI of the repository host, with the project's SCM token.
- **CI server**: one HTTP request to a CI server, such as Jenkins, with its own credential.

Its buttons, and a next step that runs in CI, show to people with
[`run:control`](/operate/project-access#what-each-role-can-do) once the feature is on and a target is set; through the
repository, an SCM token must be set too. A CI server request goes without a credential when none applies.

An optional **Flake Lab** target names a second workflow, pipeline or job that runs `piwi flake` for one flaky test,
started from that test's next step: [Run it in CI](./flake-lab#run-it-in-ci) shows the GitHub workflow, and
[Flake Lab on Jenkins](#flake-lab-on-jenkins) the Jenkins job.

## Repository host

Fill in the block for your provider:

| Provider | Target you configure | Token scope |
|---|---|---|
| **GitHub** | Workflow file name (e.g. `e2e.yml`), a ref, the `workflow_dispatch` input that receives the arguments, and optionally the input that receives the dispatch id | `actions:write` (a classic PAT's `workflow` scope) |
| **GitLab** | A ref and the pipeline variable name that receives the arguments | `api` |
| **Bitbucket** | The `custom:` pipeline name and the variable name that receives the arguments | `pipeline:write` |

The dispatch uses the project's [SCM token](/guide/source-control), which needs the write scope above.

Your workflow has to actually consume the value. A minimal GitHub example that forwards the input to Playwright:

```yaml
on:
  workflow_dispatch:
    inputs:
      args:
        description: Playwright arguments
        required: false
        default: ''
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright test ${{ inputs.args }}
```

On GitLab and Bitbucket, set the variable name to `PIWI_RERUN_ARGS` and run [`rerun`](/reference/cli#rerun), which
reads the quoted arguments without a shell (unset, it fails):

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

GitHub's `workflow_dispatch` returns no run id, so the link goes to the workflow's runs page filtered to the branch;
GitLab and Bitbucket link straight to the pipeline.

## CI server

A CI server target is a **preset**, which builds the request from a few fields, or a **Custom request** you write.
The form shows the request a re-run sends, filled with sample values and the credential masked, as you type.

**Jenkins** takes the job as Jenkins shows its path (`polaris/e2e`; `polaris/e2e/{branch}` for a multibranch pipeline,
where `{branch}` becomes the run's branch) and posts to its `buildWithParameters` with two string parameters:
`PIWI_RERUN_ARGS` (the arguments) and `PIWI_ORIGIN_REF` (the dispatch id), names you can change. The credential is
a user and their API token, sent as Basic authentication, which Jenkins accepts without a crumb. The link goes to the
job's page. The job declares both parameters and runs `rerun`:

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

### Flake Lab on Jenkins

The preset's Flake Lab job receives `flake 12` or `flake verify 12` in its arguments parameter and hands it to the
reporter, which reads `PIWI_DASHBOARD_URL` and `PIWI_API_KEY`:

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

On a Windows agent the steps are `bat` steps, and the last reads `%PIWI_RERUN_ARGS%`.

### Custom requests

**Customize the request** turns the preset into a Custom request that sends the same thing, to edit from there. A
Custom request is JSON: `auth` (`none`, `basic`, `bearer`, or `{ "header": "X-Token" }`), a `rerun` request and an
optional `flakeLab` one, each with a `method` (`POST` or `PUT`), a `path` relative to the base URL, and optional
`query`, `headers` and `body` (JSON, or form fields), `link` (a JSON pointer, a response header, or a path) and
`buildNumber` (a JSON pointer). Its values may name these placeholders:

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

The token field is write-only: leave it empty to keep the stored token. A token is stored with the base URL in effect
when it is saved and sent only to URLs under it, so changing the base URL asks for the token again. A project without
a base URL uses the instance's CI server (`PIWI_CI_SERVER_URL`), and one without a token the instance's
(`PIWI_CI_SERVER_USER`, `PIWI_CI_SERVER_TOKEN`): it goes only with a preset's request under that URL, never with a
Custom one. A base URL or a request path is refused when a segment would climb once a server decodes it (`..%2F`,
`..;`), so a token bound to a folder stays in it.

A request never follows a redirect, and a link from the answer is kept only when it is an `http(s)` URL or a path from
the base URL's root (`/queue/item/12/`). A CI server
is reached over `https`. Over `http`, or on a private address (a `10.x` host, `localhost`), it is reached only when it
is the host and port of the instance's `PIWI_CI_SERVER_URL` or is listed in `PIWI_CI_SERVER_HOSTS` (`host` for any
port, `host:port` for one); the desktop app reaches any address. The
variables are in the [configuration reference](/reference/configuration).

## Matching the run

When the re-run finishes, Piwi recognizes it and records its [origin](/reference/test-metadata#run-origin) as `ci-rerun`.
A Jenkins job matches by the dispatch id it passes on as `PIWI_ORIGIN_REF`; a Custom request by that id too, or by the
build number its `buildNumber` pointer reads from the answer, for a run of the same branch and spec files that started
after the dispatch. GitLab matches by its pipeline id and
Bitbucket by its build number, which the dispatch answered with; GitHub by the dispatch id when the workflow passes it
on. Once matched, the last dispatch links to the build the
run recorded.

GitHub rejects an input the workflow does not declare, so that input is a separate, optional setting. Declare it and
hand it to the reporter as `PIWI_ORIGIN_REF`:

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

Without it, a GitHub run, or a CI server run with neither, is matched on its branch, a start within six hours of the
dispatch, and running exactly the dispatched spec files.

## Limits

- A dispatch is one request: Piwi does not poll the CI for the build's state, it waits for the run to report.
- The demo records a CI server dispatch without sending it, and links to the job's page.

## Related

- [Pull-request feedback](./pr-feedback): the result posted on the pull request
- [Source control](/guide/source-control): the SCM token and its scopes
- [Failure clusters & the inbox](./failure-clusters): the clusters a re-run acts on
- [Flake Lab](./flake-lab): the experiment a Flake Lab target runs in CI
- [CLI](/reference/cli#rerun): the `rerun` command a pipeline runs
