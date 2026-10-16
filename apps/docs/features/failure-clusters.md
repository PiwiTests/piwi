---
title: Failure clusters & the inbox
description: "Failures that share an error fingerprint grouped into one cluster, triaged once from the failure inbox with an owner, a known issue and snoozing."
lang: en-US
---

# Failure clusters & the inbox

<Needs reporter />

One root cause usually breaks several tests, run after run. Piwi groups failures by root cause into **failure clusters**, and Home turns them
into a **failure inbox**: the problems you still owe a decision.

## How failures are grouped

Failed executions sharing an **error fingerprint** join one cluster, so twenty stack traces read as
*"20 failures, 3 root causes"*. Clustering is always on.

- The fingerprint **masks volatile fragments** of the error: timeouts and other numbers, UUIDs and hashes, URLs and
  emails, the *expected* and *received* values of an assertion, and dynamic locator options such as the
  `{ name: '…' }` of a table row, wherever the error prints the locator. The locator target itself (the test id, the
  role) still tells different failures apart.
- It is **call-site agnostic**: the failing stack frame is shown for context but does not split a cluster, so one root
  cause reached from several spec files stays one cluster.
- The fingerprint is computed from the error the cluster was created from, so an improved normalization
  regroups clusters in place and keeps their triage, notes and diagnoses.
- A run's **Tests** tab can group its failures by cluster, each group with its triage status; the
  `get_failure_groups` [MCP tool](/reference/mcp-tools#get_failure_groups) adds a **worker-correlation** flag: "the
  app is broken" versus "worker 3 is misbehaving".

<figure>
  <img src="/diagrams/failure-clustering-fingerprint.svg" alt="The fingerprint pipeline: a raw error is normalized, hashed and routed to one cluster">
</figure>

With an embedding model configured, near-duplicate clusters that the fingerprint keeps apart are merged too: see
[semantic merging](./ai-diagnosis#semantic-merging-optional).

## The failure inbox

The **Failure inbox** on Home lists up to 50 open failure clusters across the projects you can see, most
recently seen first. Each row shows the cluster's **headline**, its **top clue**, the **owner or assignee**, the
**affected-test count**, when it was **last seen**, and only the exceptional **badges**, such as a regression on the
default branch.

### Queues

The inbox is split into queues, each with a live count, shareable in the URL as `?queue=`.

| Queue | What it holds |
|---|---|
| **All open** | Every open, non-snoozed cluster. |
| **New** | Clusters first seen, or seen again, since you last opened the inbox (kept per browser). |
| **Mine** | Clusters whose assignee, or `piwi:owner` annotation, is you. |
| **Needs ticket** | Untracked default-branch clusters older than 2 days, by default; see [issue tracking](./issue-tracking). |
| **Regressions** | Clusters that regressed on the default branch and are still failing there. |
| **Fix didn't hold** | Clusters whose fix landed then regressed. |
| **Quarantine ready** | Quarantined clusters whose tests stopped failing. |
| **Merge suggestions** | Clusters in a pending merge suggestion (see [semantic merging](./ai-diagnosis#semantic-merging-optional)). |

### Triage from the row or the keyboard

Every row can be triaged in place. Select a row with the mouse or `j` / `k`, then: `o` open, `r` resolve, `i` ignore,
`q` quarantine the cluster's tests, `a` assign, `s` snooze, `l` link a known issue, `c` create a Jira issue (when a
tracker is connected). `x` selects rows for a **bulk bar** that applies the same actions to all of them. Resolve, ignore, snooze and assign on
one row can be undone for a few seconds. [Keyboard shortcuts](/reference/keyboard-shortcuts#failure-inbox) lists every key.

Linking a known issue (`l`) pins a URL; with an [issue tracker connected](/operate/integrations), Jira links unfurl
and stay in sync, and you can **[file the issue from the failure](/features/issue-tracking)** (`c`).

## Owners and assignees

A cluster's **owner** is derived, not stored: it comes from the failing test's `piwi:owner` annotation; the
cluster and execution pages (not the inbox) fall back to the repository's `CODEOWNERS`. **Assigning** the cluster to a person overrides it:
an assignee takes precedence over the derived owner, and the **Mine** queue matches either one against the
signed-in user (by name or email).

## The cluster page

A cluster page leads with a failing execution's situation block ([Your first
failure](/guide/first-failure)), across every test sharing the failure. The heading is the latest failure's
headline when it says more (a timeout, a count) than the cluster's name, which sits under it.
Three lines are cluster-specific:

- **The state line**, right above **Next**.
- **The occurrence sparkline**: how often it failed across recent runs, *N occurrences in M tests over D · last X ago*;
  a single test is named, *quarantined* if it is.
- **What changed**: the commits and files since the last passing run (or your baseline), with **See the changes**
  for the diff and, with [coverage](./server-coverage), the first
  [suspect line](/guide/concepts#suspect-lines): a changed line the failing tests ran, marked in the diff. Missing
  setup (no commit or repository URL, an unsupported host, a missing or refused [SCM token](/guide/source-control))
  shows the range, the host's error, its **Compare** page and a hint on what to set up;
  **More actions › Copy git log** lists the range in your checkout. With no passing run yet, **Browse commits** picks
  a baseline. The same commit on both sides means the change is not in the code.

With several tests, the **Affected tests** list picks the one the evidence shows; **Move to a new cluster**
[splits tests off](./ai-diagnosis#split-a-cluster-by-hand). The fix section **Next** points at leads under the block;
the rest fold into [**More ways to fix**](./fix-plans#more-ways-to-fix).

### The state line

The cluster page states where a cluster stands in **one sentence with one verb**, next to a colored dot:
*still failing*, *not seen for N runs*, *fixed and verified, still open*, *fixed, but the diagnosed patch still
applies*, *stopped failing*, *regressed, the fix did not hold*, *resolved*, *ignored*, *snoozed* or *all tests
quarantined*. When an open cluster stopped failing, or its ticket is Done and the latest finished run no longer fails
it, the page offers **one action**, *Mark resolved*, which a fix whose patch still applies keeps in the **Next** menu;
a snoozed cluster offers *Unsnooze*, an all-quarantined one *Release*. Beside it, **Triage** sets the status (open /
resolved / ignored), a note and the assignee, and [snoozes](#snoozing) the cluster. A status change keeps the
triage note and the lines Piwi added.

### Occurrences over time

Folded under the fixes, a chart counts failures per day, week or month since first seen, marking the **fix landed**;
the sparkline opens it.

## Did the fix work?

When a run executes every test a cluster covers and they all pass, Piwi records the fix: the run, the commit, and how
long the cluster was open. Three verdicts, each a different claim:

| Verdict | Means |
|---|---|
| **Stopped failing** | The tests pass again. A flaky test can achieve this by accident. |
| **Diagnosis verified** | The commits since the last failing run touched a file the [suggested patch](./ai-diagnosis#what-a-diagnosis-contains) named. |
| **Regressed** | A fix was recorded, and the cluster is failing again. |

**Every affected test must pass**: a test that did not run counts against the fix. A filtered run can close a cluster
if it covered all of it, so `--grep` over exactly the affected tests is enough.

**The commit must have changed.** A run at the commit the cluster last failed at (a CI retry, or **Re-run in CI**)
proves nothing was fixed: Piwi records it as flake evidence and the state line says *passed again at the same commit,
which is flake evidence, not a fix*. **The branch must match**: only a run on the branch the cluster last failed on, or
on the default branch, records a fix, so a green pull-request or heal branch leaves a cluster that fails on `main`
open.

The verdict moves the status only on strong evidence: *Diagnosis verified* sets an **open** cluster **resolved**, and
*Regressed* sets a **resolved** one back to **open**, each adding a line to the triage note. *Stopped failing* alone
changes nothing, and an *ignored* cluster is never touched. The [notifications](./notifications) `cluster.fixed` and
`cluster.regressed` follow the verdict, and with [pull-request feedback](./pr-feedback) on, the comment gains a
**Fixed by this change** section, even with *only comment on failures* set.

## Snoozing

**Snoozing** hides a cluster from every inbox queue without touching its status: it is still *open*. **1 day** and
**1 week** return it when the deadline passes; **Until it recurs** returns it to the **New** queue, with a **snoozed,
back** badge, when a new run fails it again.

## From an AI agent

Over the [MCP server](/features/mcp), `list_open_clusters` takes the same `queue` argument, and the inbox's actions
have tools: `triage_cluster` sets the status (with a note), assigns, snoozes, quarantines or releases clusters,
`decide_merge_suggestion` decides a merge suggestion, `move_tests_to_new_cluster` moves tests out of a cluster,
`rerun_cluster_in_ci` re-runs a cluster's tests in CI, and `link_issue` and `unlink_issue` manage tickets.

## Related

- [Triage a run gone red](/recipes/mass-failure): the clusters, used to collapse a red run into a few causes
- [AI diagnosis](./ai-diagnosis): an explanation of a cluster against your git diff
- [Failure evidence](./evidence): everything captured about one execution in the cluster
- [Core concepts](/guide/concepts#error-fingerprint-failure-cluster): fingerprint and failure cluster
