---
title: Timeline markers
description: "Deploys and infrastructure changes drawn on the trend charts, so a step change in pass rate or duration has a visible cause."
lang: en-US
---

# Timeline markers

<Needs reporter />

Timeline markers let you record **dated events** against a project — a deploy, a config change, an infrastructure migration, a dependency bump, an incident — and see them overlaid as vertical lines on the analytics trend charts. When a pass-rate drop or a performance regression lines up with a marker, you have your prime suspect: "the slowdown started the day we switched CI runners".

## What a marker is

Each marker belongs to one project and carries:

- **Label** — a short title (e.g. _Migrated CI to ARM runners_).
- **Date & time** — when the event happened; this is where the line is drawn.
- **Category** — one of `deploy`, `config`, `infra`, `incident`, `release`, or a generic `event`. The category sets the marker's icon and color.
- **Environment** _(optional)_ — scope the marker to a single environment (e.g. `staging`). Leave it empty to apply to all environments.
- **Description** _(optional)_ — free-text detail.
- **Run** _(optional, API only)_ — the id of one of the project's runs the event belongs to.

## Where markers show up

- **Project charts** — the **Run trend** and **Performance trend** charts render each marker as a dashed vertical line with a colored flag handle. Hover the line or its flag for the marker's details (category, label, date, environment, linked run, description); click it to open the marker in the **Markers** panel, in its edit form when you can edit markers.
- **Markers panel** — a **Markers** button beside the **Run trend** chart (on the project's Runs tab) opens a panel listing the project's markers, newest first. **Add marker** and each marker's edit button open the form in the panel itself; **Delete** is on each marker and in the edit form.
- **Test-case history** — a single test's duration history chart shows the same markers, so you can tell whether an event affected that specific test. Clicking one opens it in the project's **Markers** panel.
- **Analytics charts** — the trend charts of the analytics page draw the markers too, with the same details on hover.
- **Run detail** — a run shows an **"After: …"** chip for the nearest preceding marker, so a single run tells you which event it followed.

## Environment scoping

Markers tie into the project's existing **environment filter**. When you filter the project view to one or more environments, the charts show only markers that match the selected environment(s) plus any global (no-environment) markers. This keeps a staging-only event from cluttering your production view.

The environment field is free text, with suggestions drawn from the environments already seen in the project's runs (set via the reporter's `environment` option / `PIWI_ENVIRONMENT`).

## Who can edit markers

Reading markers is available to anyone who can read the project. Creating, editing, and deleting them requires the **Contributor** role or above on the project, or an administrator ([roles](/operate/project-access#what-each-role-can-do)). (When authentication is disabled, everyone can edit.)

## Automatic markers

Piwi can create markers for you when a run's tooling changes. On each finished run it compares the run against the previous run **in the same environment** and, when the **Playwright version** or **reporter version** changed, adds an `auto` marker (category `config`) at that run's time — for example _Playwright 1.49.0 → 1.50.0_. Auto markers are labeled with a small sparkle icon and can be edited or deleted like any other.

A run flagged as an [environment incident](./environment-incidents) gets an `auto` marker in the `incident`
category, linked to the run.

This is enabled by default. Set `PIWI_AUTO_MARKERS=false` to turn both off. See the [configuration reference](/reference/configuration).

## Release markers keep their run

A `release` marker linked to a run keeps that run forever: [data retention](/operate/storage#keeping-runs-forever) never deletes it, and the marker's label becomes the reason shown on the run. Deleting the marker, or changing its category to anything but `release`, releases the run again — unless someone kept it by hand or the reporter kept it at ingest, in which case the keep stays.

From CI, create the marker after the test step with the run id the reporter writes to its outputs (`piwi_run_id` on GitHub Actions, see [CI → Getting the run URL back out](/guide/ci#getting-the-run-url-back-out-of-ci)):

```bash
curl -X POST "$PIWI_DASHBOARD_URL/api/projects/<projectId>/markers" -H "Authorization: Bearer $PIWI_API_KEY" -H "Content-Type: application/json" -d '{"label":"v2.3.1","category":"release","occurredAt":"2026-09-24T12:00:00Z","runId":1234}'
```

## API

Markers can also be managed through the REST API. See the interactive [API docs](https://piwitests.dev/demo/docs) for request and response shapes.

## Related

- [Regression or flake?](/recipes/regression-or-flaky): correlating a failure with a deploy
- [Analytics](./analytics): the trend charts the markers annotate
