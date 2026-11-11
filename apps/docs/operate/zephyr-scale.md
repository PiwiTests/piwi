---
title: Zephyr Scale Cloud
description: "Connect Zephyr Scale Cloud to the dashboard and bind a project to a Zephyr project: the region, the token, the catalog of test cases and how tests map onto it."
lang: en-US
---

# Zephyr Scale Cloud

Connect Zephyr Scale Cloud, the test management app for Jira, to the dashboard, and bind a project to a Zephyr
project. Piwi reads the project's test cases and, once the binding is live, writes a finished run's results back as
one test run ([Results in Zephyr Scale](/features/test-management)). The connection holds the token in one place,
managed by an administrator.

A connection is instance infrastructure, like an [issue tracker connection](./integrations): one row per external
system, shared by every project, with its token encrypted at rest with `PIWI_SECRET_KEY`. Zephyr Scale is never
offered as an issue tracker, so a project cannot be bound to it for links or for filing issues.

## Connecting Zephyr Scale Cloud

1. In Jira, open your profile picture, then **Zephyr API keys**, and create a token. Use a dedicated account, so the
   token does not end with a person's access.
2. **Settings → Integrations → Connect Zephyr Scale Cloud** (administrator only): pick the **Region** your Zephyr
   Scale Cloud runs in (US, EU, AU or DE), paste the token, and choose **Check**. Then **Save**.

**Check** signs in on the region's API and lists the projects the token sees, without saving anything. **Test
connection** on the saved connection signs in again and records the result on its card. Both give up after about
ten seconds, and a host that does not answer in that time is reported as unreachable: check that the server can
reach the region's host through any proxy, firewall or VPN.

## The region decides the host

Zephyr Scale Cloud runs one API per region, and Piwi calls the host the chosen region names. It never takes a host
from the form, so a typed address is ignored and an unknown region is refused. Changing the region of a saved
connection asks for the token again, because a token belongs to one region.

## Bind a project

A project is bound in **Project → Settings → Test management** (Project admin on the project). The section always shows;
with no Zephyr Scale connection it says "No test management connection yet" and links to **Settings → Integrations**
to add one. Pick the **Connection** and the **Project** key, then **Save**. The binding is
kept apart from the issue tracker binding, so saving one never changes the other.

- **Enabled** keeps the binding but pauses its use.
- **Dry run** is on for a new binding. A run's page then shows what would be sent and nothing reaches Zephyr Scale;
  turn it off to send. See [Results in Zephyr Scale](/features/test-management).
- **Where a test’s case key comes from** is its tags, its external ID, or both. A key is a tag or an ID that
  matches the project's test case key pattern, such as `SHOP-T123`, with no `@`.
- **Runs in scope** picks the branches and environments the binding covers, as the issue tracker binding does.
- **Result statuses** name the statuses Piwi uses for a pass, a fail, a flaky test and a test not executed, and
  how a flaky or skipped test is reported. The pickers list the statuses and folders of the chosen project; typing a
  name the tool does not list is allowed. A flaky status is needed to report flaky tests as `flaky`.
- **Add the first line of the error** to a failed result is off by default, because an error message can carry data
  from the application.

The pickers read Zephyr Scale through the connection, cache what they read for five minutes, and share one request
budget with the catalog. A token Zephyr refuses marks the connection **failed** on its card.

### The test run name

The **Name** of the test run is a template, `Automation · {branch} · {environment} · Piwi #{runId}` by default. It
must contain `{runId}`, so each Piwi run has its own name, and may use `{branch}`, `{environment}`, `{commit}`,
`{date}` and `{ciBuild}`. Any other variable, or a name over 200 characters, is refused.

## The test case catalog

Piwi keeps a copy of the project's test cases, so that a key a test carries can be checked and shown without asking
Zephyr each time. The catalog stores each case's key, name, status and folder, and when it was read. It never stores
the objective, the steps or the token.

A task reads the catalog of every bound project that was not read in the last day. **Refresh catalog**, under the
mapping summary, reads it now. A read takes every page before it replaces anything, so a failed read keeps the old
catalog; it answers 429 while the connection is rate limited and 502 when Zephyr fails or refuses the token.

## How tests map onto the catalog

Under the form, the **mapping summary** reads the last complete run and the stored catalog, and never calls Zephyr:

- how many tests carry a test case key and how many have none;
- the **keys the catalog does not hold**, up to 20, each with the tests that carry it. Until the catalog has been
  read no key is called unknown;
- a warning when tags were cut at 20 on some tests in the run, since those tests may be missing a key. The count is
  shown as "at least N" unless every affected test is listed.

A tag or external ID that is a test case key also shows a **hover card** in the project's test lists and on the test
pages: the case's name and status from the catalog, a note when the key is not a case in the project, and when the
catalog was read.

## Request rate

Zephyr Scale rate limits each token, so Piwi spaces out every call of a connection: the catalog read, the pickers and
**Refresh catalog**. The limit is 20 requests a minute per connection. Set `PIWI_TEST_MANAGEMENT_REQUESTS_PER_MINUTE`
(1 to 600) to change it. A 429 from Zephyr pauses the connection for the wait it asks for, or a minute.

## Environment-managed connection

Set `PIWI_ZEPHYR_API_TOKEN`, and optionally `PIWI_ZEPHYR_REGION` (`us` by default), to manage the connection from
the environment instead. It then shows a lock badge and is read-only in the dashboard: change it by editing the
environment and restarting. The token stays in the environment and never enters the database. A region the variable
does not name is logged and replaced by `us`. See
[Environment-managed vs dashboard-managed](./integrations#environment-managed-vs-dashboard-managed) for how the two
kinds of connection behave.

## Who can do what

With [authentication](./authentication) on, creating, checking, testing, editing and deleting a Zephyr Scale
connection is administrator-only. Saving a binding, the pickers, the mapping summary and **Refresh catalog** need
Project admin on the project; the hover cards need only read access to it.

## Related

- [Results in Zephyr Scale](/features/test-management): when a run is sent, what is sent and Sync again
- [Integrations](./integrations): the Jira Cloud connection and how connections are managed
- [Production checklist](./production-checklist): `PIWI_SECRET_KEY`, which encrypts the stored token
- [Configuration reference](/reference/configuration#integrations): the integration variables
