# CI re-run on any CI server

A proposal to let **Re-run in CI** and Flake Lab's **Reproduce in CI** start a build on the team's CI server through
one generic HTTP request, filled from a preset (Jenkins, TeamCity, Buildkite, CircleCI, Azure Pipelines) or written by
hand, whatever hosts the code. It answers [PiwiTests/piwi#1062](https://github.com/PiwiTests/piwi/issues/1062), a team
on Bitbucket and Jenkins, and adopts the issue's alternative (a generic trigger) with the Jenkins-specific advantages
kept in the Jenkins preset.

**Status.** Proposed 2026-11-04. PR 1 of the [Delivery](#delivery), `npx @piwitests/reporter rerun`, shipped in
[#1092](https://github.com/PiwiTests/piwi/pull/1092) and fixes the [quoting
defect](#defects-found-while-researching-this-plan). PR 2, the engine, is built: the `ci-server` target with the
Jenkins and Custom presets and the renderer (`shared/ci-server.ts`), the credential binding, the private-host rule and
the send (`server/utils/ci-server-dispatch.ts`), the `ci_server_token` column with `ciServerToken` on
`PATCH /api/projects/:id`, the four `PIWI_CI_SERVER_*` variables, and availability, dispatch, record and matching in
`server/utils/ci-rerun.ts`, with the link to the recorded build for every provider. PR 3 is built: the CI server form
in the project's Source control settings with its request preview, the _dispatched to Jenkins_ line on the cluster and
execution pages, the demo's Jenkins project, the [Re-run in CI](../apps/docs/features/ci-rerun.md) page and the help
topic. PR 5 is built: **Check the jobs** in the form reads each Jenkins job the target names, without starting it,
with the credential a dispatch would carry, and names the parameters it does not declare
(`ciServerCheckPlans` in `shared/ci-server.ts`, `checkCiServerTarget` in `server/utils/ci-server-dispatch.ts`). PR 4
(the other presets) is deferred until a team asks for a preset: each one is a registry entry and its request test.

**Summary.** Today a dispatch goes through the repository host: the project's SCM token starts a GitHub workflow, a
GitLab pipeline or a Bitbucket custom pipeline, and the host of the run's repository picks which one. A team whose CI
is not its repository host (Bitbucket + Jenkins, GitHub + TeamCity, GitLab + Buildkite) cannot use the buttons. This
proposal adds a second way to dispatch, **CI server**: one HTTP request to a base URL, with a credential, whose path,
query, headers and body a **preset** fills from a few fields (Jenkins: the job path and two parameter names). The base
URL and credential come from the instance (`PIWI_CI_SERVER_URL`, `PIWI_CI_SERVER_USER`, `PIWI_CI_SERVER_TOKEN`), and a
project may override both. Two rules make the override safe: **a credential is sent only to URLs under the base URL it
was saved with**, and **a private address is reached only on a host the operator listed**. The finished run is matched
back by the dispatch id the job hands the reporter as `PIWI_ORIGIN_REF`, as the GitHub block does, and the dispatch
then links to the build the run recorded.

## Problem

- **The dispatch is tied to the repository host.** `ciRerunAvailability` (`server/utils/ci-rerun.ts`) derives the
  provider from the run's repository URL, and `dispatchRerun` is a method of `ScmProvider`. A Bitbucket project gets the
  Bitbucket block, whatever runs its tests.
- **The workaround is lossy.** A Bitbucket custom pipeline that `curl`s Jenkins' `buildWithParameters` needs Jenkins
  reachable from Atlassian's cloud, links the dispatch to the Bitbucket pipeline instead of the build, and the finished
  run is never matched to its cluster: it does not carry Bitbucket's build number.
- **Several CI servers per company is common.** Teams of one instance run their own Jenkins controller or TeamCity
  server, so one instance-wide URL is not enough: the base URL has to be settable per project.
- **The reporter already knows these CIs.** It records Jenkins' build number, build URL and job name
  (`collectCiInfo`, `packages/reporter/src/internal/collect/metadata-collector.ts`), and detects TeamCity, Buildkite
  and others as CI (`detectCi`). Only the dispatch is missing.

## What exists

| Piece                              | Where                                                                                                                                                                 | What this proposal reuses                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Settings and availability          | `shared/ci-rerun.ts` (`CiRerunSettings`, `resolveCiRerunSettings`), `projects.ci_rerun`, `server/utils/ci-rerun.ts` (`ciRerunAvailability`, `flakeLabCiAvailability`) | One more target beside the three blocks; the same availability shape for the buttons               |
| Dispatch flow                      | `dispatchRerunOf`, `rerunClusterInCi`, `rerunExecutionInCi`, `runFlakeLabInCi`                                                                                        | The dispatch id, the args, the ref and the record are built once; only the send changes            |
| Arguments                          | `buildRetryArgs` (`shared/retry-command.ts`)                                                                                                                          | Already safe to hand to CI: an argument holding a character a shell expands is left out            |
| Matching                           | `matchRerunDispatch` (`shared/ci-rerun.ts`), `matchCiRerunRun`                                                                                                        | By `PIWI_ORIGIN_REF` first, then by build number, then by branch, start time and files             |
| Token per project, global fallback | `projects.scm_token`, `resolveScmToken` (`server/utils/scm/index.ts`)                                                                                                 | The shape of a project credential: encrypted column, never returned, 409 without `PIWI_SECRET_KEY` |
| Host allow-list for a token        | `PIWI_SCM_GITLAB_HOSTS`, `scmProviderForUrl`, `tests/unit/scm-token-host.test.ts`                                                                                     | The rule "run metadata and project settings never choose the host a credential goes to"            |
| SSRF guard                         | `safeFetch`, `assertPublicHttpUrl`, `publicOnlyLookup` (`server/utils/safe-fetch.ts`)                                                                                 | Public addresses only, checked at connect, redirects checked hop by hop                            |
| Permissions                        | `project:manage` on `PATCH /api/projects/:id`, `run:control` on the dispatch routes                                                                                   | Unchanged                                                                                          |

## Decisions

Taken with the maintainer on 2026-11-04; the shape is to be confirmed with the issue's author.

| #   | Decision                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **One generic target, `ci-server`, beside the three repository blocks.** A preset is a function from a few fields to a request template; the transport, the credential, the host rules and the reading of the answer are written once.                                                      |
| D2  | **The project chooses where a dispatch goes**: `ciRerun.via` is `repository` (today's blocks, the default) or `ci-server`. It is never inferred, so a Bitbucket project with both configured is not ambiguous. Pull-request feedback keeps using the SCM token either way.                  |
| D3  | **Presets in the first cut: Jenkins and Custom.** TeamCity, Buildkite, CircleCI and Azure Pipelines follow as one registry entry and one test each.                                                                                                                                         |
| D4  | **The base URL and credential are the instance's by default, and a project may override both.** Instance: `PIWI_CI_SERVER_URL`, `PIWI_CI_SERVER_USER`, `PIWI_CI_SERVER_TOKEN`. Project: a base URL in `ciRerun.ciServer.baseUrl`, a user name beside it, a token in a new encrypted column. |
| D5  | **A credential is sent only to URLs under the base URL it was saved with** (see [Security](#security)).                                                                                                                                                                                     |
| D6  | **A private address is reached only on a place the operator named**: the host and port of `PIWI_CI_SERVER_URL`, and the entries of `PIWI_CI_SERVER_HOSTS` (a host, any port, or `host:port`). Any other host goes through the public-only lookup.                                           |
| D7  | **The job reads the arguments from an environment variable, through the Piwi CLI**: `npx @piwitests/reporter rerun` runs `playwright test` with the arguments of `PIWI_RERUN_ARGS`, parsed without a shell. No `eval`, no Groovy interpolation of a parameter into `sh`.                    |
| D8  | **Parameter names default to the environment variables the reporter reads**: `PIWI_RERUN_ARGS` and `PIWI_ORIGIN_REF`. Jenkins, TeamCity, Buildkite and Azure Pipelines expose a build parameter as an environment variable, so the job only declares them.                                  |
| D9  | **A matched dispatch links to the build the run recorded** (`ci.buildUrl`), for every provider. Before the match it links to what the CI answered, or to the job's page.                                                                                                                    |
| D10 | **On the desktop app, a project's base URL may reach a private address without `PIWI_CI_SERVER_HOSTS`.** Its server binds 127.0.0.1 only, and its one user is the operator.                                                                                                                 |
| D11 | **One instance CI server, set by environment variables.** Several servers are per-project overrides; no named connections and no admin page in this plan.                                                                                                                                   |
| D12 | **The Jenkins job field takes a `{branch}` segment for a multibranch pipeline**, encoded as Jenkins names branch jobs.                                                                                                                                                                      |
| D13 | **Jenkins authenticates with a user and an API token only**, never the "Trigger builds remotely" token, which sits in a query string that access logs keep.                                                                                                                                 |

## Design

### 1. The target

```ts
/** `ciRerun.via`: where a dispatch goes. Absent means `repository`. */
type CiRerunVia = "repository" | "ci-server";

interface CiServerTarget {
  preset: "jenkins" | "custom"; // then 'teamcity' | 'buildkite' | 'circleci' | 'azure-pipelines'
  /** The project's base URL; absent, the instance's `PIWI_CI_SERVER_URL`. */
  baseUrl?: string;
  /** The user name a Basic credential pairs with the project's token. */
  user?: string;
  /** The preset's fields for the re-run (Jenkins: `job`, `argsParameter`, `dispatchParameter`, `ref`). */
  rerun: Record<string, string>;
  /** The preset's fields for Flake Lab; absent, no Flake Lab in CI. */
  flakeLab?: Record<string, string>;
  /** Custom only: the request templates and where the credential goes. */
  custom?: { auth: CiServerAuth; rerun: CiRequestTemplate; flakeLab?: CiRequestTemplate };
}

interface CiRequestTemplate {
  method: "POST" | "PUT";
  /** Relative to the base URL; `{{name}}` placeholders, each encoded as one path segment. */
  path: string;
  query?: [name: string, value: string][];
  headers?: [name: string, value: string][];
  /** JSON (placeholders only as whole string values) or form fields. */
  body?: { type: "json"; template: string } | { type: "form"; fields: [name: string, value: string][] };
  /** Where the link to watch comes from: a JSON pointer, a response header, or a template. */
  link?: { pointer: string } | { header: string } | { template: string };
  /** A JSON pointer to the build number, matched against the run's `ci.buildNumber`. */
  buildNumber?: string;
}

type CiServerAuth = "none" | "basic" | "bearer" | { header: string };
```

`ciRerun` gains `via` and `ciServer`; both are in the JSON column, so only the token needs a migration. Placeholders:
`{{args}}` (the Playwright arguments, or `flake 12` for Flake Lab), `{{dispatchId}}`, `{{ref}}` (the run's branch,
else the target's `ref` field), `{{commit}}` and `{{branchJob}}` (the ref as Jenkins names a multibranch branch job). A preset is `(fields) => CiRequestTemplate`, and **Customize** in
the form copies a preset's template into Custom, so what a preset sends is never hidden. The form also shows the request
a dispatch would send, with sample values and the credential masked.

Rendering encodes each value for its place: a path placeholder is one percent-encoded segment (`/`, `.` and `..` cannot
change the path's shape), query and form values go through `URLSearchParams`, a JSON template is parsed first and a
placeholder replaced as a string value, and a header value with a CR or LF is refused. No template names the scheme,
the host or the port.

### 2. Presets

| Preset              | Request (relative to the base URL)                                                                                                | Credential                                  | Read from the answer                   | Reaches the job as                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| **Jenkins**         | `POST /job/<a>/job/<b>/buildWithParameters`, form `PIWI_RERUN_ARGS`, `PIWI_ORIGIN_REF`                                            | Basic, user and API token (no crumb needed) | `201`; link: the job's page            | Build parameters, exposed as environment variables                  |
| **TeamCity**        | `POST /app/rest/buildQueue`, JSON `buildType.id`, `branchName`, `env.`-prefixed `properties`                                      | Bearer access token                         | `webUrl`; `number`                     | `env.` parameters, environment variables                            |
| **Buildkite**       | `POST /v2/organizations/<org>/pipelines/<slug>/builds`, JSON `commit: "HEAD"`, `branch`, `env` (base `https://api.buildkite.com`) | Bearer API token, `write_builds`            | `web_url`; `number`                    | `env`, directly                                                     |
| **CircleCI**        | `POST /api/v2/project/<slug>/pipeline`, JSON `branch`, `parameters` (base `https://circleci.com`)                                 | `Circle-Token` header                       | `number`; link built from the slug     | Pipeline parameters, which the config maps to environment variables |
| **Azure Pipelines** | `POST /<org>/<project>/_apis/pipelines/<id>/runs?api-version=7.1`, JSON `refName`, `variables` (base `https://dev.azure.com`)     | Basic, empty user and a PAT                 | `_links.web.href`                      | Queue-time variables, environment variables                         |
| **Custom**          | Any `POST` or `PUT` the form describes                                                                                            | None, Basic, Bearer or one header           | A JSON pointer, a header or a template | Whatever the request names                                          |

Each request shape is checked against the CI's API documentation while its preset is built, and pinned by a unit test.
The Jenkins job field takes the folder path as Jenkins shows it (`polaris/e2e`) and becomes `job/polaris/job/e2e`. For a
multibranch pipeline, a `{branch}` segment stands for the branch job (`polaris/e2e/{branch}`), encoded as Jenkins names
it: `feature/x` becomes `job/feature%252Fx` (D12).

A Jenkinsfile that receives a re-run:

```groovy
pipeline {
  agent any
  parameters {
    string(name: 'PIWI_RERUN_ARGS', defaultValue: '', description: 'Set by Piwi: the tests to re-run')
    string(name: 'PIWI_ORIGIN_REF', defaultValue: '', description: 'Set by Piwi: the dispatch id')
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

### 3. Running the arguments in the job

`buildRetryArgs` writes the arguments as a shell would read them (`"tests/login.spec.ts:10" --project="chromium"`). A
job that expands them from a variable keeps the quotes, and Playwright finds no tests (see
[Defects found](#defects-found-while-researching-this-plan)). Re-parsing them with `eval`, or interpolating a Jenkins
parameter into a Groovy `sh "…"` string, lets anyone allowed to start the job with parameters run commands on the agent.

`npx @piwitests/reporter rerun [extra Playwright arguments]` reads `PIWI_RERUN_ARGS`, splits it into words with
double-quoted strings and no escapes (the inverse of `quoteShellArg`), and runs `playwright test` with those words and
the extra ones, with no shell, on every platform. It exits with Playwright's code. With the variable unset it fails and
names the parameter to declare, since Jenkins drops a parameter the job does not declare and the job would otherwise run
the whole suite. Set and empty, it runs the whole suite. The GitLab and Bitbucket examples switch to the same command.

### 4. Base URL and credentials

|               | Instance (operator)                                       | Project (project admin)                                                              |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Base URL      | `PIWI_CI_SERVER_URL`                                      | `ciRerun.ciServer.baseUrl`                                                           |
| User          | `PIWI_CI_SERVER_USER`                                     | `ciRerun.ciServer.user`                                                              |
| Token         | `PIWI_CI_SERVER_TOKEN` (secret)                           | `projects.ci_server_token`: `{ url, token }`, encrypted, PATCH field `ciServerToken` |
| Private hosts | `PIWI_CI_SERVER_HOSTS`: host[:port] list, comma-separated | None                                                                                 |

A dispatch uses the project's base URL when set, else the instance's. It sends the first credential whose saved URL
holds the request's URL: the project's, then the instance's. The instance's goes only with a preset's request, whose
shape the preset fixes; a Custom request carries the project's own token or none. A project that overrides the base URL to another
server and saves no token sends none. The project token is stored with the base URL it was saved for, so moving the
base URL elsewhere leaves it unsent; the form says so and asks for it again. The project GET returns
`hasCiServerToken` and the URL the token is bound to, never the token.

The instance's URL may include a path: `PIWI_CI_SERVER_URL=https://jenkins.example.com/job/qa/` confines the instance
token to the `qa` folder, whatever base URL a project sets under it.

### 5. Dispatch, link and matching

- **Availability.** `via: 'ci-server'` needs no SCM token and no repository: a target, a base URL (the project's or
  the instance's), and a base URL that is `https`, or `http` on a listed host. DNS is checked at dispatch, not on page
  load. The reasons join the existing ones (`No CI server is configured for this project.`).
- **Send.** `dispatchRerunOf` and `runFlakeLabInCi` branch on `via`: the SCM path stays as it is, the new path renders
  the template and calls `sendCiServerRequest` (`server/utils/ci-server-dispatch.ts`). Success is a 2xx; a 3xx is an
  error naming its status, since no redirect is followed. Ten-second timeout.
- **Record.** `ClusterRerunDispatch.provider` widens to `ScmProviderName | 'ci-server'` with a `preset` field for the
  label ("Dispatched to Jenkins"). `lastRerunDispatch` is JSON: no migration.
- **Link.** The preset's link (TeamCity's `webUrl`, Buildkite's `web_url`), else the job's page, else the base URL.
  Once `matchCiRerunRun` matches the run, the dispatch links to the run's `ci.buildUrl` (Jenkins' `BUILD_URL`) when it
  has one, for every provider (D9). Jenkins answers with a queue item, not a build, so the build link comes from the
  match rather than from polling the queue.
- **Match.** By `PIWI_ORIGIN_REF` first. Then by build number when the preset reads one and the run's `ci.buildNumber`
  holds it: a CI server numbers builds per job, so the number counts only for a run of the dispatch's branch, started
  after it (a minute of clock difference allowed), that ran exactly its spec files. Then by branch, start time and files, the heuristic GitHub uses today,
  extended to `ci-server`.

### 6. Settings

Under **Settings › Source control › CI re-run**, below the switch: **Dispatch through**, _Repository host_ or _CI
server_. _CI server_ shows a preset select, the base URL (its placeholder is the instance's URL, with "Uses the
instance's CI server" when empty), the user and token, the preset's fields, the Flake Lab fields, the request preview
and **Customize**. The repository blocks stay as they are under _Repository host_.

### 7. API, MCP, demo, desktop

- **API.** `PATCH /api/projects/:id` takes `ciRerun.via`, `ciRerun.ciServer` and `ciServerToken`, documented in its
  `defineRouteMeta` block. The dispatch routes and their answers keep their shape.
- **MCP.** `rerun_cluster_in_ci` calls `rerunClusterInCi`: unchanged.
- **Demo.** The seed gives one project a Jenkins target, and the demo's rerun handlers answer for it with a job link,
  as they do for the repository blocks.
- **Desktop.** Same code, except that a project's base URL may reach a private address without
  `PIWI_CI_SERVER_HOSTS` (D10).

## Security

The question was whether a per-project base URL is safe. It is with D5 and D6; without them, it opens two holes.

1. **Sending the instance credential elsewhere.** If the instance token followed any base URL a project admin types,
   any project admin could point it at a server they own and read it. D5 binds every credential to the URL it was
   saved with: the instance token goes only under `PIWI_CI_SERVER_URL`, a project token only under the URL saved with
   it. The instance token also goes only with a preset's request, whose shape the preset fixes, so a Custom template
   cannot use it for any other request under its URL. The request URL cannot leave the base URL: templates fill
   encoded segments and values only, a path value whose slashes would hold a `.` or `..` segment is refused, the check
   runs on the URL after normalization, and no redirect is followed. A base URL or a path segment that climbs once a
   server decodes it (`..%2F`, `%252e%252e`, `..;` as Tomcat reads it, `%u002e`, a decoded `?`, `#` or NUL, or more
   than three levels of encoding) is refused too: a proxy that decodes before routing would otherwise take a token
   bound to `/job/qa/` to `/job/prod/`. A stored target whose base URL fails this rule does not dispatch at all, rather
   than fall back to the instance's server.
2. **Reaching the internal network (SSRF).** A CI server usually lives on a private network, so the webhook rule
   (public addresses only) would refuse the main use case, and allowing any private address would let a project admin
   use Piwi to send requests into the network. D6 allows a private address only on a place the operator named, port
   included for the host of `PIWI_CI_SERVER_URL` and for a `host:port` entry (`:80` too, which `URL` drops as the
   default); any other host goes through the public-only lookup, which checks
   every resolved address at connect. The desktop app is the exception
   (D10): its server binds 127.0.0.1 only, and its one user is both the operator and the only project admin.
3. **Reading answers.** An answer is never echoed. The dispatch keeps the status and the fields the preset reads: a
   link, only when it is an absolute http(s) URL or a root path, and a build number, only when it is digits. An error shows the status and, for a JSON answer, its `message` field, cut to 200 characters.
4. **Headers.** A custom header name must be a token and is refused when it is `Host`, `Content-Length`,
   `Transfer-Encoding`, `Connection`, `Cookie` or `Authorization`: the credential goes through `auth`.
5. **Values from runs.** The branch and the arguments come from run data a reporter token can send. They fill encoded
   slots only, and the arguments are `buildRetryArgs`' output, which leaves out any argument a shell would expand.
6. **What remains.** A project admin can make Piwi `POST` the project's own data to a public URL of their choice, as a
   webhook channel can today, and start any job the configured credential may build. The instance token should belong
   to a CI user whose build permission covers only the jobs Piwi should start, or `PIWI_CI_SERVER_URL` should name
   their folder.
7. **Permissions and secrets.** Configuring is `project:manage`, dispatching is `run:control`, the instance values are
   the operator's: `ciServerInstanceUrl`, and `ciServerTokenUrl`, which may name the instance URL, are returned only
   to a project admin. A project's own target (`ciRerun`) stays readable by its readers, like the repository targets.
   Tokens are encrypted with `PIWI_SECRET_KEY` (409 without it) and never returned.

## Delivery

1. **PR 1, `feat(reporter)`: `npx @piwitests/reporter rerun`** (D7), and the GitLab and Bitbucket examples of
   `features/pr-feedback.md` switched to it. Fixes the [quoting defect](#defects-found-while-researching-this-plan) on
   its own.
2. **PR 2, `feat(app)`: the engine.** `shared/ci-server.ts` (types, `resolveCiRerunSettings` extended, the preset
   registry with Jenkins and Custom, the renderer), `server/utils/ci-server-dispatch.ts` (credential binding, host
   rule, send, read), the `ci_server_token` column (SQLite and PostgreSQL), the four variables in `PIWI_ENV_VARS`,
   availability, dispatch, record and matching wired in `server/utils/ci-rerun.ts`, D9 for every provider.
3. **PR 3, `feat(ui)`: the settings form**, the dispatch label and link on the cluster and execution pages, the demo
   (seed, handlers), the docs and the help topic. The feature is usable from here.
4. **PR 4, `feat(app)`: TeamCity, Buildkite, CircleCI and Azure Pipelines presets**, each with its request test, and
   `collectCiInfo` recording Buildkite's and TeamCity's build number and URL (`feat(reporter)`), so their links and
   build-number match work. Deferred until a team asks for one of these presets.
5. **PR 5, optional, `feat(ui)`: Check.** A read-only request per preset. For Jenkins,
   `GET <job>/api/json?tree=property[parameterDefinitions[name]]` lists the declared parameters, so the form can warn
   when `PIWI_RERUN_ARGS` or `PIWI_ORIGIN_REF` is missing.

PR 2 and PR 3 are the size a contributor can take; the issue's author offered to.

## Tests

- `tests/unit/ci-server-presets.test.ts`: each preset's request (method, URL, headers without the secret, body) for
  sample fields and values, and Customize producing the same request.
- `tests/unit/ci-server-credential.test.ts`: the instance token never sent outside `PIWI_CI_SERVER_URL`, a project
  token only under its saved URL, a placeholder holding `..`, `/` or `%2e%2e` staying one segment, a 3xx not followed.
- `tests/unit/ci-server-host.test.ts`: a private address refused on an unlisted host and reached on a listed one.
- `tests/unit/ci-rerun.test.ts`: availability with `via: 'ci-server'`, matching by id, build number and the heuristic,
  the link after a match.
- Reporter: `rerun` splits `buildRetryArgs`' output back into the words it quoted, fails with the variable unset.
- E2E: the settings form saves a Jenkins target; the cluster page dispatches to a stub HTTP server (as
  `tests/ai-diagnosis.spec.ts` stubs a model) and shows the link.

## Documentation

- `features/ci-rerun.md`: the re-run section of `features/pr-feedback.md` becomes its own page, _Re-run in CI_, with
  the CI server, the Jenkinsfile, the placeholders and the credential and host rules. Both pages stay within the
  1,500-word budget, and `guide/ci.md` is at it.
- `features/ci-rerun.md#flake-lab-on-jenkins`: the Jenkins Flake Lab job, its `sh` and `bat` steps.
- The configuration reference is generated from the four new variables.
- `HELP_TOPICS['project.ci-rerun']`: the CI server option.

## Alternatives considered

- **A Jenkins-specific target** (the issue's main proposal). It covers one CI. Its three advantages are kept by the
  Jenkins preset: folders (`polaris/e2e` → `job/polaris/job/e2e`), the dispatch id (`PIWI_ORIGIN_REF`), and the build
  link (D9).
- **Free-form templates only.** Every team writes the same Jenkins request by hand and gets the encoding or the
  credential wrong. A preset costs one registry entry and one test.
- **A client class per CI, like `ScmProvider`.** More code per CI and a request nobody can see. A preset that produces
  a template keeps one transport, and Customize shows exactly what is sent.
- **The Bitbucket pipeline that `curl`s Jenkins** (the issue's workaround): see [Problem](#problem).

## Risks

- **A CI's trigger API changes.** Each preset is pinned by its test against the CI's documentation; Custom is the way
  out until the preset is fixed.
- **Jenkins drops undeclared parameters silently.** `rerun` refuses to run with `PIWI_RERUN_ARGS` unset; PR 5's Check
  warns before the first dispatch.
- **A CI server behind single sign-on redirects to a login page.** The dispatch fails with the 3xx status, and the docs
  say to use the server's API URL and an API token.

## Not in this plan

- **The Bitbucket toggles.** On a Bitbucket project, **Commit status** and **Gate status** save but post nothing, as
  `features/pr-feedback.md` says, and the settings form does not say it (the issue's side note). A separate UI fix.
- **Pull-request feedback through the CI server.** Commit statuses and comments stay on the repository host.
- **Named CI server connections and an admin page for the instance values** (D11). Either can follow if a team asks.
- **Polling the CI for a build's status.** Piwi learns the outcome from the run the reporter sends.
- **Other features over the generic request** (auto-heal, notifications, which have webhooks).

## Defects found while researching this plan

- **GitLab and Bitbucket re-runs run no tests.** `features/pr-feedback.md` tells GitLab and Bitbucket users to run
  `npx playwright test $PW_ARGS`. `buildRetryArgs` double-quotes each argument, and a shell expanding a variable keeps
  the quotes: with `PW_ARGS='"tests/a.spec.ts:2"'` Playwright answers `Error: No tests found.`, and with
  `PW_ARGS='--project="chromium"'` it answers `Error: Project(s) ""chromium"" not found.` (checked with Playwright
  1.64.1). The GitHub example works because `${{ inputs.args }}` is substituted into the script before the shell reads
  it. PR 1 fixes it.
