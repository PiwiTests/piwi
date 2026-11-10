---
title: Issues about a run or a test
description: "File a Jira issue about a whole Playwright run, or about one test that belongs to no failure cluster, with your own comment first in its body."
lang: en-US
---

# Issues about a run or a test

<Needs reporter admin />

Not every finding is a failure Piwi groups: a test that passes but misses a case, a step too slow to be useful, a
suite that passed while the feature is broken. **Create issue** also files those, through the same modal, connection
and [project binding](./issue-tracking#the-project-binding) as an issue about a failure.

## Where it is

- **On a run's page**, the header's **Create issue** files an issue about the whole run.
- **On an execution with no failure cluster** (a passed or skipped test, or a failure not grouped), the **More
  actions** menu's **Create issue** files one about that test. An execution with a cluster files on its cluster, as
  [Issue tracking](./issue-tracking#what-it-does-exactly) describes.

## What the issue holds

- **Comment** comes first: your own words, up to 5,000 characters, under your name. The modal offers it for a
  failure cluster's issue too; when the cluster already has its issue, the comment is added to that issue instead,
  and a later update of the issue's description keeps it first. The modal says whether the comment was added, is
  still queued, or was refused by Jira.
- **A run's issue** lists the run (project, branch, commit, environment, start), its results, its tests with failed
  ones first (25 listed, then a count), the failure clusters of its failures with the issue each one already has
  (the 10 with the most failures, then a count), links back to the run, and who filed it from Piwi. Its proposed
  title counts the failures and names the branch.
- **A test's issue** has the same body for that one test, titled after it, with its error when it failed.
- Each carries the labels `piwi` and `piwi-run-<id>` and a `Piwi-Run: <id>` trailer, for JQL. A run's issue shows in
  the run's **Links**.
- The body follows the [ticket's language](./issue-tracking#language). Only Piwi's own copy is translated, never your
  comment or the test data.

## Several issues, each filed once

A run, or a test with no cluster, **can have several issues**: the modal lists the ones already linked and files a new
one. Each opening of the modal files at most one, so a second click on **Create**, or opening it again while a filing
waits on Jira (after a reload too, or in another tab of the same browser, for a day), never files twice. Create sent
again while that filing is still queued files it with what the modal holds now. Any create, a cluster's too, that Jira
may have received without its answer coming back (a timeout, or the server restarted during the call) fails with
**Outcome unknown** rather than risking a second issue: check Jira for it, then create it again if it is not there.

## Limits

- **Filed by hand only**: [Issue automation](./issue-automation) rules file failure clusters, never a run or a test.
- The body is a **snapshot** at creation; the [write-back policies](./issue-tracking#keep-the-ticket-honest) follow
  clusters, not runs.
- From an AI agent, the [`create_issue` MCP tool](/reference/mcp-tools#create_issue) files about a cluster, an
  execution in a cluster or a bug report, one issue per cluster: never a whole run, nor a test with no cluster.

## Related

- [Issue tracking (Jira)](./issue-tracking): issues about a failure cluster, the binding and the sync
- [Issue automation](./issue-automation): tickets filed by rule
