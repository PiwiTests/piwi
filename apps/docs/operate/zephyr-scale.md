---
title: Zephyr Scale Cloud
description: "Connect Zephyr Scale Cloud to the dashboard: the region, the API token, the sign-in check and the environment variables."
lang: en-US
---

# Zephyr Scale Cloud

Connect Zephyr Scale Cloud, the test management app for Jira, to the dashboard. Piwi sends nothing to Zephyr Scale
yet: the connection can be created, checked and tested, and it holds the token in one place, managed by an
administrator.

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

## Environment-managed connection

Set `PIWI_ZEPHYR_API_TOKEN`, and optionally `PIWI_ZEPHYR_REGION` (`us` by default), to manage the connection from
the environment instead. It then shows a lock badge and is read-only in the dashboard: change it by editing the
environment and restarting. The token stays in the environment and never enters the database. A region the variable
does not name is logged and replaced by `us`. See
[Environment-managed vs dashboard-managed](./integrations#environment-managed-vs-dashboard-managed) for how the two
kinds of connection behave.

## Who can do what

With [authentication](./authentication) on, creating, checking, testing, editing and deleting a Zephyr Scale
connection is administrator-only.

## Related

- [Integrations](./integrations): the Jira Cloud connection and how connections are managed
- [Production checklist](./production-checklist): `PIWI_SECRET_KEY`, which encrypts the stored token
- [Configuration reference](/reference/configuration#integrations): the integration variables
