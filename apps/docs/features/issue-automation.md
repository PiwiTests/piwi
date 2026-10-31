---
title: Issue automation
description: "Rules that file a Jira issue for a failure that keeps failing on the branches and environments you choose, and keep its comments and description current as the failure evolves."
lang: en-US
---

# Issue automation

<Needs reporter admin />

[Issue tracking](./issue-tracking) files an issue when someone clicks **Create issue**. Issue automation does it for
them: after each run, Piwi files an issue for every failure that a project's **rules** say has failed long enough, on
the branches and environments that matter, and keeps the issue's comments and description current as the failure
evolves. Everything is **off by default** and set per project, under **Project → Settings → Issue tracker**.

<figure>
  <img src="/screenshots/project-integration-auto-create.png" alt="The Automatic creation block of a project's issue tracker settings: two rules, one for release branches at the first occurrence and one for the default branch in staging after three occurrences in two runs over a day, the guards, and a preview listing one open failure filed at its next occurrence and one waiting on a threshold">
  <figcaption>Automatic creation: the rules, the guards, and a preview of what they would file.</figcaption>
</figure>

## Automatic creation

Switch on **File issues automatically** and give the project one or more rules. After a run finishes, Piwi checks each
[failure cluster](/guide/concepts#error-fingerprint-failure-cluster) that failed in it against the rules, in order.
The first rule the cluster meets files the issue; a cluster that meets none yet waits for its next failure.

A rule counts only the runs it names:

| Field | What it means |
|---|---|
| **Branches** | Branch names or `*` patterns (`release/*`). With **Default branch** on, the project's default branch too, whatever it is named. Nothing named: every branch. |
| **Environments** | Environment names or `*` patterns (`prod*`). Nothing named: every environment. |
| **Occurrences** | The failing executions counted in those runs. |
| **Runs** | The distinct runs among them, so one run with ten failing retries counts once. |
| **Days** | The days since the first counted occurrence, measured at the run being checked. |
| **Test tags** | Only failures of a test carrying one of these tags (`@critical`). Nothing named: every test. |
| **Extra labels** | Labels added to the issues this rule files, on top of the binding's. |

The run being checked must be one the rule counts: a failure that met a rule on `main` is filed by its next failure on
`main`, never by a run on a feature branch. A failure that stops failing is never filed, whatever its counts.

A fresh binding starts with one rule: two occurrences in two runs on the default branch. Two rules a team often wants:

- **Release branches at once** — branches `release/*`, one occurrence, one run, the label `release-blocker`.
- **The default branch when it persists** — the default branch in `staging`, three occurrences in two runs over a day.

Whatever the rules say, a cluster is **never** filed automatically when it is resolved, ignored or snoozed, when an issue
still tracks it or its filing is queued, or when it looks flaky (one of its tests passed on a retry since it first failed, or every one passed
at the commit it failed at), unless *Leave out failures that look flaky* is off. Two more guards hold:

- **An open issue in the tracker already carries the failure's labels** (`piwi-cluster-<id>` or `piwi-fp-<hash>`):
  Piwi leaves the link to a person. The cluster's Activity and Issue line name the issue it found and offer *Link an
  issue*, beside a Done issue too. An issue the cluster already links is left for the next sync to read back.
- **The daily cap**: at most this many issues filed automatically per project in any 24 hours (default 5).

With [owner routes](./issue-tracking#the-project-binding), an issue goes to the route of the cluster's owner (its
assignee, else the `piwi:owner` annotation, else CODEOWNERS). A failure whose owner matches no route is filed only with
*File owners with no matching route into the default project* on.

The issue is filed through the same path as a click: the same body, labels and [dedupe by
cluster](./issue-tracking#what-it-does-exactly), the same [required fields](./issue-tracking#required-jira-fields). An
issue that is Done, or whose link was removed, no longer tracks the failure, so a rule files a new one. The exception
is a Done issue the [reopen transition](./issue-tracking#keep-the-ticket-honest) is moving out of Done after a
regression: until the next sync reads that issue back, a rule files nothing beside it. An automatic create the tracker
would refuse for a field the binding leaves empty is recorded as a failed action, naming the field.

### Preview

**Preview** evaluates the rules as the form holds them, before you save, against the project's open failures that no
issue tracks yet. It lists the ones a rule files at their next occurrence in a run it counts, the ones waiting on a
threshold (*Waiting on rule 1: 1 of 2 runs*), and the ones left out with the reason, with the issues already filed
automatically in the last 24 hours and any field the tracker requires that the binding leaves empty. Nothing is
written.

## The runs that write

**Runs that write to the ticket** is a second scope, for the writes that follow a tracked issue: the fix, regression
and still-failing comments, the transitions, and the description updates. It takes branches, the default branch and
environments like a rule, and every run when it names nothing. A fix verified on a feature branch then leaves the
issue alone when the scope names `main`.

Some runs never write to a tracker, whatever the scope: a run from an editor, a Flake Lab or probe run, a bisect step
or a reproduction, a run flagged as an [environment incident](./environment-incidents), and a developer's local or
desktop run of part of the suite ([run origin](/reference/test-metadata#run-origin)).

## Comments and description updates

Each of these is a switch in **Keep the ticket honest**, off by default, and a durable action listed with the others:

- **'Still failing' note** — at most once a day or once a week, and only after the chosen number of new occurrences
  since the last note. It says how many occurrences over how many runs, where the latest one failed, and what is new
  since the last note: a branch or an environment it reached, the tests it now fails in.
- **Comment when the failure is diagnosed** — when a [diagnosis](./ai-diagnosis) of the cluster completes, from Piwi or
  from an agent: the summary, the root cause, and the category with its confidence. It needs the diagnosis switched
  on in what the ticket carries.
- **Keep the description up to date** — Piwi rewrites the description of an issue it filed: at most once a day after
  a run in which the failure failed again, and when a diagnosis completes. The rewrite keeps the language, the toggles
  and the share link the issue was filed with, and changes the title only on an issue a rule filed. Before writing,
  Piwi reads the description back: once someone has edited it in the tracker, Piwi never replaces it again, and the
  activity list says so. A rewrite that would change nothing is not sent.

## What an automatic issue says

It opens with why it was filed: *Filed automatically by Piwi after 4 occurrences in 2 runs since Oct 6, 2026. Counted
on main (staging).*, in the [ticket's language](./issue-tracking#language). The rest is the body every issue carries:
what happened (occurrences over runs, every branch and environment it failed on, the latest commit), the affected tests
with their owner and failure count, the most likely cause with the diagnosis category, the evidence, what to do, the
issues of the same kind of failure fixed before, and the links back to Piwi.

## Requirements

- A [connected Jira](/operate/integrations#connecting-jira-cloud) and a project binding that names the Jira project
  and issue type.
- The **Edit Issues** permission on the Jira project for description updates, besides the ones issue tracking needs
  ([permissions](/operate/integrations#permissions-the-token-needs)).
- The **Project admin** [role](/operate/project-access#what-each-role-can-do) or above to change the rules.

## Limits

- Rules file **failure clusters** only: a flaky test or a whole run is filed by hand.
- Rules are checked when a run finishes, not on a timer: *Days* is measured at the next failing run, and a project
  with no new runs files nothing.
- A description edit is told apart by its text, ignoring whitespace: changing only the formatting of a description
  in Jira does not stop the updates.
- Jira Cloud only, like [issue tracking](./issue-tracking#limits).

## Related

- [Issue tracking (Jira)](./issue-tracking) — creating an issue by hand, the body, the key and the sync.
- [Operate → Integrations](/operate/integrations) — connecting Jira and the permissions the token needs.
- [Failure clusters](./failure-clusters) — what a rule counts.
