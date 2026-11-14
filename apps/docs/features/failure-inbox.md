---
title: Failure inbox
description: "Home's failure inbox: the open failure clusters you still owe a decision, in queues, triaged from the row, the keyboard or a bulk bar."
lang: en-US
---

# Failure inbox

<Needs reporter />

The **Failure inbox** on Home lists the open [failure clusters](./failure-clusters) you still owe a decision, sorts
them into queues, and lets you triage each one from its row or the keyboard. What a cluster is, how failures join one
and whether its fix worked is on [Failure clusters](./failure-clusters).

## What it lists

The inbox lists up to 50 open clusters of the projects you can see, most recently seen first. Each row shows the
cluster's **headline**, its **top clue**, its **owner or assignee**, the **affected tests**, when it was **last
seen**, and exceptional **badges** only (a regression on the default branch, *snoozed, back*).

- **Local runs.** A cluster seen only in developers' local runs, in a project that runs in CI, stays out; **Show
  them** lists them, marked *local runs only*.
- **Environment incidents.** The clusters a run flagged as an
  [environment incident](./environment-incidents#what-a-flagged-run-changes) opened are one row for that run.
- **Snoozed clusters** are out of every queue until their [snooze](./failure-clusters#snoozing) ends.

### Queues

Each queue has a live count and is shareable as `?queue=`:

- **All open**: every open cluster not snoozed.
- **New**: first seen, or seen again, since your previous visit (kept per browser).
- **Mine**: assigned to you, or owned by you when it has no assignee
  ([owners and assignees](./failure-clusters#owners-and-assignees)).
- **Needs ticket**: untracked default-branch clusters older than the binding's age (2 days by default; see
  [issue tracking](./issue-tracking)).
- **Regressions**: regressed on the default branch, failing there still.
- **Fix didn't hold**: a fix landed, then [regressed](./failure-clusters#did-the-fix-work).
- **Quarantine ready**: [quarantined](./flaky-tests#quarantine-with-a-way-out), and the tests stopped failing.
- **Merge suggestions**: in a pending [merge suggestion](./ai-diagnosis#semantic-merging-optional).

### Triage from the row or the keyboard

Open, resolve, ignore, quarantine, assign, snooze, link a known issue or create a tracker issue from the row, by mouse
or [key](/reference/keyboard-shortcuts#failure-inbox); `x` selects rows for a **bulk bar**. The triage actions need
the Maintainer role or above on the project.

Resolve, ignore, snooze and assign on one row can be undone for a few seconds. A known issue pins a URL; with an
[issue tracker](/operate/integrations) bound, Jira links unfurl and stay in sync ([issue tracking](./issue-tracking)).

## From an AI agent

Over the [MCP server](/features/mcp), `list_open_clusters` takes the same `queue`, and each triage action has a
[tool](/reference/mcp-tools): `triage_cluster`, `decide_merge_suggestion`, `link_issue` and `unlink_issue`.

## Related

- [Failure clusters](./failure-clusters): how failures are grouped, the cluster page, and whether the fix worked
- [Triage a run gone red](/recipes/mass-failure): a red run collapsed into causes
- [Keyboard shortcuts](/reference/keyboard-shortcuts#failure-inbox): every key of the inbox
- [Issue tracking](./issue-tracking): the tickets behind **Needs ticket** and a known issue
