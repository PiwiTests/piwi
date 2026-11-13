# CI actions

- Status: accepted
- Date: 2026-11-13

## Context

A project's CI re-run was one block of settings: a target for each repository host, an optional CI server target, and
`ciRerun.via` choosing between the two ([ci-server-dispatch.md](ci-server-dispatch.md), D2). It could start one thing
per kind, so a team with a staging and a production environment, or a re-run and a nightly job, had nothing to choose
between, and the choice of `via` was a project-wide switch that no run could override.

A project now has a list of named CI actions. Each says where Piwi starts CI, which inputs it adds, what it accepts
(a re-run, a run on CI, a Flake Lab experiment) and the environment it runs in. This record supersedes D2 of
[ci-server-dispatch.md](ci-server-dispatch.md): the other decisions of that record, the one generic target, the
presets, the credential rules, the host rules and the `rerun` command, stand as they were written.

## Decision

| #   | Decision                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **The setting is `ciRerun = { enabled, actions, defaults }`.** An action is `{ id, name, target, inputs, accepts, environment? }`; its target is a GitHub workflow, a GitLab or Bitbucket pipeline, or a `ci-server` target. `defaults` maps a kind to the action id its buttons use. This replaces `via`: where a dispatch goes is the target of the action picked, never inferred from a switch. |
| D2  | **An action is picked by id or name, else by the run's environment, else by the kind's default, else the first that accepts the kind.** An action of a repository host serves only a run of that host; a CI server action serves any run. The environment is the one the run recorded.                                       |
| D3  | **A value with no `actions` list is converted, never lost.** Each configured side becomes an action with a stable id (`rerun-<side>`, `flakelab-<side>`), both the CI server side and the repository side. The default of a kind is the action on the side `via` selected. The converted value is what the project list, the project and the dispatch all read; saving writes the list. |
| D4  | **Inputs are named values beside the arguments, never inside them.** A fixed value or a choice; a name is `[A-Za-z_][A-Za-z0-9_]*`; a GitLab or Bitbucket input may not start with `CI_`, `GITLAB_` or `BITBUCKET_`, in any case, because those hosts reserve the variables. A save that breaks the rule answers 400, and a dispatch refuses a stored action that does. |
| D5  | **Limits are checked on save and in the editor**: 20 actions, 20 inputs an action, a name or an environment of 80 characters, a fixed value or an option of 500, 50 options in a choice, and a unique id and name (names ignoring case).                                                                                          |
| D6  | **A project has one CI server token, bound to one base URL.** The token is a field of the CI section, outside any action. It is sealed with the one base URL every CI server action sends under (an action's own, else `PIWI_CI_SERVER_URL`, which counts as its own value) and sent only under it. A save that would bind it to more than one answers 400. |
| D7  | **A request that carries the instance credential sends only the inputs `PIWI_CI_SERVER_ALLOWED_INPUTS` lists** (comma-separated, empty by default). The credential is the operator's: a project's inputs must not be able to steer a job the operator's token reaches. A request on the project's own token sends every input. Check names the inputs a request leaves out. |
| D8  | **The settings live in a CI section of the project's settings,** in the Integrations group beside the issue tracker, with its own form and Save, for the roles that manage the project.                                                                                                                                          |

## Consequences

- `ciRerun.via` and the per-host blocks are read for conversion only: the API documents `actions`, and a client that
  still sends the old value keeps working.
- The project's stored token keeps its sealed `{ url, token }` form, so a token saved before this record is bound to the
  URL it was saved with and needs no migration.
- An operator who relied on a project's inputs reaching a job through the instance credential lists those names in
  `PIWI_CI_SERVER_ALLOWED_INPUTS`, or gives the project a token of its own.
- Two CI server actions with different base URLs cannot both be served by a stored token: one of them uses the instance
  credential or no credential until the URLs match.
