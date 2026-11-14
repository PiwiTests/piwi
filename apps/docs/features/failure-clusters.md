---
title: Failure clusters & the inbox
description: "Failures that share an error fingerprint grouped into one cluster, triaged once from the failure inbox with an owner, a known issue and snoozing."
lang: en-US
---

# Failure clusters & the inbox

<Needs reporter />

How Piwi groups failures by root cause into **failure clusters**, where a cluster stands, whether its fix worked,
and the **failure inbox** on Home. A model's explanation is on [AI diagnosis](./ai-diagnosis), fixing on
[Fix plans](./fix-plans).

## How failures are grouped

Failed executions sharing an **error fingerprint** join one cluster: *"20 failures, 3 root causes"*. Always on, the
fingerprint hashes the error type, message and locator, **masking what varies**:
numbers, UUIDs, hashes, ids glued to an underscore (`order_5f3a9c1e2b`), URLs, emails, timestamps, the folders of a
path under a home folder, CI workspace or Windows drive, a temporary folder's random suffix, an assertion's *expected*
and *received* values, the elements a strict-mode violation lists, and dynamic locator options such as a row's
`{ name: '…' }`. The locator's target (test id, role) still tells failures apart.

It **ignores the failing stack frame** when the error says what failed, so one root cause reached from several spec
files, through a helper or page object, stays one cluster. A **generic** error says nothing of its own: it names no
locator, and its message is an `expect(…)` matcher whose values are all masked, a test timeout, or a bare `TypeError`
or `ReferenceError` line. Its fingerprint also hashes the file of its failing stack frame (the spec, or the helper).

A cluster keeps its first error, so an improved normalization **regroups clusters in place** with their triage,
notes, diagnoses and merges. A run's **Tests** tab groups failures by cluster;
[`get_failure_groups`](/reference/mcp-tools#get_failure_groups) adds a **worker-correlation** flag ("worker 3 is
misbehaving").

<figure>
  <img src="/diagrams/failure-clustering-fingerprint.svg" alt="The fingerprint pipeline: a raw error is normalized, hashed and routed to one cluster">
</figure>

With an embedding model, near-duplicates the fingerprint keeps apart are merged too
([semantic merging](./ai-diagnosis#semantic-merging-optional)). **A merge never buries a live failure**: the survivor
ends open when either cluster was open and not snoozed, takes the other's assignee when it has none, appends its note,
and inherits its tickets, fix attempts, tracker history and the merges decided against.

### Split a cluster by hand

When some tests fail with the same error for another reason, select them in **Affected tests** and choose **Move to a
new cluster** (Maintainer or above; no AI). Their failures move to a new cluster with your note, the old one gains a
line naming the move, their later failures with that error join the new one, and the two never merge automatically.

<figure>
  <img src="/screenshots/failure-clusters-tab.png" alt="A project's Failures tab: its open clusters with type, triage, tests and occurrences">
</figure>

## The failure inbox

The **Failure inbox** on Home lists up to 50 open clusters you can see, most recently seen first: **headline**, **top
clue**, **owner or assignee**, **affected tests**, **last seen**, and exceptional **badges** (a regression on the
default branch). A cluster seen only in local runs, in a project that runs in CI, stays out; **Show them** lists them.

### Queues

Each queue has a live count and is shareable as `?queue=`:

- **All open**: every open cluster not snoozed.
- **New**: first seen, or seen again, since your previous browser session (kept per browser).
- **Mine**: [yours](#owners-and-assignees).
- **Needs ticket**: untracked default-branch clusters older than the binding's age (2 days by default; see
  [issue tracking](./issue-tracking)).
- **Regressions**: regressed on the default branch, failing there still.
- **Fix didn't hold**: a fix landed, then regressed.
- **Quarantine ready**: [quarantined](./flaky-tests#quarantine-with-a-way-out), and the tests stopped failing.
- **Merge suggestions**: in a pending [merge suggestion](./ai-diagnosis#semantic-merging-optional).

### Triage from the row or the keyboard

Open, resolve, ignore, quarantine, assign, snooze, link a known issue or create a tracker issue from the row, by mouse
or [key](/reference/keyboard-shortcuts#failure-inbox); `x` selects rows for a **bulk bar**.
Resolve, ignore, snooze and assign on one row can be undone for a few seconds. A known issue pins a URL; with an
[issue tracker](/operate/integrations) bound, Jira links unfurl and stay in sync ([issue tracking](./issue-tracking)).

## Owners and assignees

A cluster's **owner** is derived: the failing test's `piwi:owner` annotation, else, on the cluster and execution pages
(not the inbox), the repository's `CODEOWNERS`. An **assignee** overrides it. **Mine** matches either against your
name, username or email.

## The cluster page

Top to bottom:

1. The [situation block](/guide/first-failure) across every test sharing the failure, headed by the latest failure's
   headline when it says more than the cluster's name. Its own lines:
   - **the state line**, right above **Next**;
   - **the occurrence sparkline**: *N occurrences in M tests over D · last X ago*, naming a single test, *quarantined*
     if it is;
   - **What changed**: commits and files since the last passing run (or your baseline), the diff, and with
     [coverage](./server-coverage) the first [suspect line](/guide/concepts#suspect-lines). Missing setup shows what to
     set up ([troubleshooting](/guide/source-control#troubleshooting)); **Browse commits** picks a baseline when none
     passed. One commit on both sides: the change is not in the code.
2. The section **Next** points at (the AI diagnosis, the locator fix…) as its own card.
3. **Affected tests**, picking whose evidence shows, then that evidence.
4. [**More ways to fix**](./fix-plans#more-ways-to-fix), then the [occurrence chart](#occurrences-over-time) and the
   activity, folded.

### The state line

**One sentence with one verb**, beside a colored dot: *still failing*, *not seen for N runs*, *fixed and verified,
still open*, *fixed, but the diagnosed patch still applies at the fix's commit*, *stopped failing*, *regressed, the fix
did not hold*, *resolved*, *ignored*, *snoozed* or *all tests quarantined*. It reconciles the triage status with the
[verdict](#did-the-fix-work), offering **the one action** closing a gap unless **Next** does:
*Mark resolved* (an open cluster stopped failing, or its ticket is Done and the failure stopped; a fix whose patch
still applies keeps it in the **Next** menu), *Unsnooze*, or *Release* (all tests quarantined). **Triage** sets the
status (open / resolved / ignored), note and assignee, and [snoozes](#snoozing); a status change keeps the note, a
note edit the status.

#### Which runs count

*Not seen for N runs* counts finished runs since the last failure, on its branch or the default branch, that ran the
cluster's tests without that failure: never a Flake Lab run, bisect step, reproduction or
[environment incident](./environment-incidents). A skipped, not-run or interrupted test was not run. A whole-suite run
that reached its end counts even when a cluster test no longer exists; one stopped early (interrupted, cancelled, timed
out, `maxFailures`) only if it ran the cluster's tests. A Done ticket's failure has stopped once such a run follows.

### Occurrences over time

A chart of failures per day, week or month since first seen, marking the **fix landed**; the sparkline opens it.

## Did the fix work?

When a run executes every test of a cluster and all pass, Piwi records the fix (run, commit, time open) and a verdict:

- **Stopped failing**: the tests pass again, which a flaky test can do by accident.
- **Diagnosis verified**: the commits since the last failing run touched a file the
  [suggested patch](./ai-diagnosis#validated-patches) named.
- **Regressed**: a fix was recorded, and the cluster fails again.

**A fix needs every affected test to pass** in the Playwright projects it last failed in that the run ran (a `--grep`
over them is enough), in a run started after the last failing run, at another commit (a pass at the failing commit,
such as a CI retry, is flake evidence the state line names), on the cluster's last failing branch or the default
branch: a green pull-request branch leaves a cluster failing on `main` open. **A regression needs a run started after
the fix landed**, failing on its branch or the default branch.

**Projects.** A project the run left out but its config lists (another CI job runs it) says nothing; one the config
no longer lists (removed, renamed) does not count, and a test that last failed only there is answered by a pass in any
project. CI jobs loading different project lists (a config per job, a list from a variable) thus record a fix from any
job where the tests pass: give them one list, and pick each job's projects with `--project`.

Only strong evidence moves the status. *Diagnosis verified* resolves an **open** cluster at once, so *fixed and
verified, still open* reads only once something reopened it (a person, or a merge with a live cluster). *Regressed*
reopens a **resolved** cluster, as does a new failure after a person resolved one with no fix on record; each adds a
note line. *Stopped failing* changes nothing; an *ignored* cluster is never touched. The `cluster.fixed` and
`cluster.regressed` [notifications](./notifications) follow the verdict, and the [pull-request](./pr-feedback)
comment gains **Fixed by this change**, even with *only comment on failures*.

## Snoozing

**Snoozing** hides a cluster from every queue, status untouched. **1 day** and **1 week** return it then; **Until it
recurs** returns it to **New** when a run fails it, badged **snoozed, back** until your next visit.

## From an AI agent

Over the [MCP server](/features/mcp), `list_open_clusters` takes the same `queue`, and each action above has a
[tool](/reference/mcp-tools): `triage_cluster`, `decide_merge_suggestion`, `move_tests_to_new_cluster`,
`rerun_cluster_in_ci`, `link_issue` and `unlink_issue`.

## Try it in the demo

<DemoExamples />

## Related

- [Triage a run gone red](/recipes/mass-failure): a red run collapsed into causes
- [AI diagnosis](./ai-diagnosis): a cluster explained against your diff
- [Failure evidence](./evidence): one execution's evidence
- [Core concepts](/guide/concepts#error-fingerprint-failure-cluster): the terms
