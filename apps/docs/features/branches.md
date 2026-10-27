---
title: Branches
description: "Branch as a first-class dimension: how Piwi records it, filtering by branch, and baselines computed per branch."
lang: en-US
---

# Branches

<Needs reporter />

Every run Piwi stores is tagged with the git **branch** it came from, and that branch is a real, queryable dimension — not a string buried in metadata. Filter any view to one branch, compare like with like, and let baselines and flakiness scoring stop mixing your feature branches together.

**Needs:** the reporter only — the branch is collected automatically with the rest of the git metadata (`collectScmInfo`, on by default). Nothing to install or switch on.

## How the branch is recorded

On CI, git alone is unreliable: a pull-request checkout is usually a detached `HEAD`, so `git rev-parse` reports the literal string `HEAD` instead of a branch. The reporter resolves the real branch through a fallback chain instead:

1. **`PIWI_BRANCH`** — an explicit operator override, when you want to name the branch yourself.
2. **The CI provider's branch variables** — `GITHUB_HEAD_REF` / `GITHUB_REF_NAME` on GitHub Actions, the merge-request and commit refs on GitLab, and the equivalents for CircleCI, Travis, Azure, Jenkins and Bitbucket. On a pull-request build the **source** branch wins over the plain ref, so the run records the branch under test.
3. **`git rev-parse --abbrev-ref HEAD`** — the local answer, used only when it is a real branch. A detached `HEAD` is discarded rather than recorded.

When the provider exposes it, the reporter also captures the **pull-request number**, so [pull-request feedback](/features/pr-feedback) can look the PR up exactly instead of guessing from the branch name, and the pull request's **target branch** (`GITHUB_BASE_REF`, `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, `SYSTEM_PULLREQUEST_TARGETBRANCH`, `BITBUCKET_PR_DESTINATION_BRANCH`, Jenkins' `CHANGE_TARGET`, Travis' `TRAVIS_BRANCH` on a PR build), which becomes the run's **base branch** — the branch baselines fall back to. Set `PIWI_BASE_BRANCH` to name it yourself. Branch, PR and base-branch detection happen automatically as part of the reporter's git metadata collection (`collectScmInfo`) — see [CI & sharding → What gets detected](/guide/ci#what-gets-detected).

## The default branch

Each project has a **Default branch** setting in the **Source control** section of its **Settings** tab (placeholder `e.g. main`). Leave it blank and Piwi resolves it from your SCM provider; when the provider cannot tell (no token, or no access to the repository), Piwi asks again ten minutes later. The default branch is the reference point for the rest of this page: baselines fall back to it, and "already flaky on the default branch" is measured against it.

## Filtering by branch

On a project page, the **Filters** block carries a **branch** multi-select (the git-branch icon) next to the environment filter. It appears once any of the project's runs carries a branch. With no branch picked, the page reads the project's default branch and the runs that report no branch, like [Analytics](./analytics#branch-policy); **All branches** beside it reads every branch, and the branches you pick read exactly those. The header, the runs list, the test catalog, the failure clusters, the flaky leaderboard, the Flake Lab and the performance trends all follow it; a note under the filters counts the runs on other branches they hide.

The branch is an indexed column, so every project tab, Analytics and the MCP `list_runs` tool filter by it in the database; the project's runs list filters its latest 200 runs in the browser. Runs reported before the column existed fall back to the branch recorded in their metadata, so old history still filters.

## Branch-aware baselines

**Baselines are chosen within an environment and a branch.**

- **The run-level baseline**, what the Changes tab, the stored regression signals, the CI gate, pull-request feedback, the bisect window and the AI diagnosis all compare against, follows the [baseline rule](/guide/concepts#baseline-last-green-run): same environment first, then the same branch, the base branch, any branch. Two feature branches reporting interleaved runs never become each other's baseline. When no earlier full run passed, the Changes tab [falls back to the last failed run](./run-changes#when-no-earlier-run-passed).
- **Choosing the base branch** — the Changes tab lets you take the baseline from any branch with an earlier full run, so a long-lived branch can be compared against `release/2` rather than `main`; the choice is in the URL (`?baseBranch=`) and on the API and MCP tool. See [What changed in a run](./run-changes#the-baseline).
- **The visual-diff baseline** follows the same rule for one execution.
- **Pull-request feedback** builds its "new failures vs. pre-existing" split from the same baseline, so a failure the PR did not introduce is reported as pre-existing, and the `max-new-regressions` [CI gate](/guide/ci#blocking-a-merge) counts the same new failures. A failure whose test is already flaky on the default branch is also marked *Also flaky on `main` … — likely not yours*; the mark does not move it out of the new failures or the gate's count.
- **Performance alerts** — the `perf.regression` [notification](./notifications) measures a run against the previous runs on the same branch **in the same environment**.

## From an agent (MCP)

The MCP `list_runs` tool takes a `branch` argument, so an agent can ask "what is failing on `main`" without pulling every run. `list_flaky_tests` takes no branch; it reads the same default-branch view as the dashboard's flaky leaderboard. See the [MCP server](/features/mcp).

## Notifications

Notification subscriptions can filter by branch and alert only on the default branch, so a noisy work-in-progress branch does not page you. See [Notifications & alerts](./notifications).

## Limits

- **Views read the default branch by default.** Analytics counts each project's default branch (plus runs with no branch) until you pick branches or *All branches* (see [Branch policy](./analytics#branch-policy)). The flaky leaderboard does the same unless you scope it, but only once the project's default branch is known (set on its Settings tab, or resolved from the SCM provider); until then it reads every branch.
- **Branches are a run dimension, not yet entities.** There is no per-branch merge-readiness verdict, branch-class gate policy, or retention by branch class yet — those are the "branches as entities" work still under *Exploring* in the [roadmap](https://github.com/PiwiTests/piwi/blob/main/ROADMAP.md).
- **A run needs a resolvable branch.** A purely local run with no CI variables, a detached `HEAD`, and no `PIWI_BRANCH` records no branch at all, so it will not appear under any branch filter.

## Related

- [CI & sharding](/guide/ci) — how the branch and PR number are detected on each provider
- [Flaky tests](./flaky-tests) — the leaderboard and regression signals the branch filter scopes
- [Analytics](./analytics) — trends you can read one branch at a time
- [Core concepts](/guide/concepts) — where branch sits among run, execution and baseline
