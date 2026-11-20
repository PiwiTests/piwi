---
title: Source control
description: "Connect the dashboard to your GitHub, GitLab or Bitbucket repository with an SCM credential, and see which features read or write through it."
lang: en-US
---

# Source control

Piwi reads your repository through the Git host's API with an **SCM token** (a personal or project access token for
GitHub, GitLab or Bitbucket), saved once as an [SCM credential](/operate/credentials). Nothing needs it
to store runs, but every feature that looks at the code behind a failure, or writes back to a pull request, goes
through it.

## What uses it

| Feature | What it does with the repository | Access |
|---|---|---|
| [AI diagnosis](/features/ai-diagnosis#scm-grounded-context) | Reads the commits and diffs since the [last green run](/features/run-changes#the-baseline), and the full source of the most suspect files | read |
| The failure cluster's **What changed** panel | Lists commits, shows their diffs, and lets you pin a baseline commit | read |
| [Uncovered changes](/features/uncovered-changes) | Diffs the run's commit against the pull request's base, or the last passing run, and flags changed files no test reached | read |
| [Did the fix work?](/features/failure-clusters#did-the-fix-work) | Checks whether the commits after a fix touched the failing files | read |
| [Notifications](/features/notifications) | Names the author of the fixing commit on `cluster.fixed` and `cluster.regressed` | read |
| Ownership and the default branch | Reads `CODEOWNERS` for test owners, and the repository's default branch when the project sets none | read |
| [Pull-request feedback](/features/pr-feedback) | Posts a summary comment and a commit status, and the [CI merge gate](/features/merge-gate#on-the-pull-request)'s status when it is on | write |
| [Re-run in CI](/features/ci-rerun) | Dispatches a workflow or pipeline (a CI server takes its own token) | write |
| [Auto-heal PRs](/features/auto-heal) | Opens a pull request with a locator fix | write |

Every call is best-effort: a missing token, a private repository the token cannot see or an unreachable host is
logged, and the feature shows nothing rather than failing a run.

## Set the credential

Save the token under **Settings → Credentials** (**New credential**, service **Source control**), or with **New
credential** beside any picker below. Its destination is the host's API, which the form offers in one click
(`https://api.github.com/`, `https://gitlab.com/`, `https://api.bitbucket.org/`), or a path under it that keeps the
token to one owner's repositories on GitHub or Bitbucket (`https://api.github.com/repos/acme/`), or to one project on
GitLab (`https://gitlab.com/api/v4/projects/acme%2Fweb/`). Then pick it:

- **Per project**: **Project → Settings → Source control**, field **Credential**. Prefer one per project for write
  access: a token the instance shares can write everywhere it reaches.
- **Instance-wide**: **Settings → Source control**, field **SCM credentials** in its **Repository access** card,
  for every project that picks none. It lists credentials shared with all projects; for each repository, the one
  whose destination holds the repository's API applies, the narrowest first, so one instance can hold a GitHub and a
  GitLab token.
- **Per CI action**: a GitHub, GitLab or Bitbucket action of [Re-run in CI](/features/ci-rerun) may name its own, so a
  token scoped to CI dispatches (on GitHub, **Actions: write**, and **Contents: read** for the action's **Check**),
  and the project's keeps reading and writing feedback.

The token is encrypted with [`PIWI_SECRET_KEY`](/reference/configuration#general), never returned by the API, sent
only to its destination, and each use is in the credential's log. A token saved on a project or the instance before
credentials existed is moved to one at startup (below). The page stays open
when the Source control [capability](/operate/capabilities) is declined, so the credentials can still be taken out.

Public repositories work without a token for the read features, within the host's rate limit for anonymous calls.
A private repository needs one, except on the desktop app with a linked folder (below).

### How it is used and logged

Opening a credential for a repository's calls is counted like a **Check** in its log, `ok` once opened (a token the
host refuses shows on the page that read). Each write (a comment, a commit status, an auto-heal branch, commit or pull
request, a dispatch) is a row of its own, checked again before it is sent. A refused credential is logged; the reads
go on without it, and a dispatch, or the **Check** of an action that names its own, is refused.

At startup, a project's token saved before credentials existed moves to a credential bound to the API of its
repository; it waits while the project has no repository, or one on a GitLab host `PIWI_SCM_GITLAB_HOSTS` does not
list. The instance's moves to one credential per API it could reach (GitHub's, Bitbucket's, the GitLab cloud's and
each listed host's), shared with all projects and listed in **Settings → Source control**: delete the ones your
repositories do not use.

### On the desktop app

The [desktop app](/features/desktop) needs no token for the read features. When a project is
[linked to a folder](/features/desktop#projects-from-local-folders) that is a clone of the repository (one of its
remotes points at the run's remote URL), Piwi reads the commits, diffs and files with `git` in that folder, on your
machine. A commit or branch the clone does not have is asked of the host as above, so run `git fetch` in the folder to
see commits pushed since your last fetch. With a credential set, the host is read instead, as on a server, and the
write features always need one. A repository on another host (a self-hosted Bitbucket or Gitea, a GitLab host not listed
below) is read from the clone alone, token or not: what the clone does not have stays unavailable.

### Which repository

Each project reads one repository, shown in the **Repository** field of the **Source control** section. The reporter
records the Git remote URL, the branch and the commit of the checkout it runs in (see
[SCM information](/reference/test-metadata#scm-information-git)), and the first run that names a remote sets the
field. A run whose remote names another repository is left out of every call that uses the token: its commits, diffs
and source are not read, and nothing is written for it. A project admin can change the field, or clear it so that the
next run sets it again. With the instance's credentials, a link to a repository no readable project uses is unfurled
as a public page, without a token.

Supported hosts are `github.com`, `gitlab.com`, `bitbucket.org` and self-hosted GitLab. A remote on a host's SSH
alias (`ssh.github.com`, `ssh.bitbucket.org`, `altssh.bitbucket.org`) names the same repository as on the host. List
each self-hosted GitLab host in [`PIWI_SCM_GITLAB_HOSTS`](/reference/configuration#integrations): Piwi sends a token
only to a host you named. A run without a remote URL has nothing to diff.

### Scopes

| Host | Read features | Write features |
|---|---|---|
| GitHub | read access to repository contents | `repo` (classic), or fine-grained **Contents: write**, **Pull requests: write** and **Commit statuses: write**; **Actions: write** for re-runs |
| GitLab | `read_api` | `api` |
| Bitbucket | repository read | repository write; `pullrequest` for pull-request comments; `pipeline:write` for re-runs |

## Verify

Open a failure cluster from a run that has a commit. The **What changed** panel lists the commits since the last green
run. The diagnosis context preview (**Context sent to AI**) shows the same thing in its data coverage: when the SCM
section is absent, it says why.

## Troubleshooting

- **No commits or diff.** The cluster's **What changed** line keeps the range, shows the host's error when it returned
  one (*GitHub error: Not Found*), and links the host's compare page when there is one; its help hint says what to set
  up: a commit and a repository URL on the run (the reporter reads both from the Git checkout the tests run in, the URL
  from its `origin` remote), a host Piwi reads, an SCM credential, or, with one set, a token that can read the
  repository. A refused credential (disabled, not shared with the project, or bound to another host) is in its log.
  A 404 from GitHub on a private repository means the token cannot see it. On the desktop app, the hint says to fetch
  the commits in the linked folder. The cluster's **More actions › Copy git log** copies the command that lists the
  range in your checkout.
- **No baseline.** The diff starts at the last green run before the failure first appeared; a project with no green
  run falls back to the last run before it where the test passed, and a manual baseline commit overrides both.
- **No pull-request comment.** Pull-request feedback also needs `PIWI_SITE_URL` and a write-scoped token, and posts on
  GitHub, GitLab and Bitbucket Cloud only.

## Related

- [AI provider](./ai-provider): the model that reads this context
- [Pull-request feedback](/features/pr-feedback): what gets posted on a pull request
- [Privacy & data flow](./privacy): what Piwi sends to your Git host
