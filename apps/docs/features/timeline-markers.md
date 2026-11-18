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
- **Environment** _(optional)_ — one of the project's [environments](./environments), picked from its list. Leave it
  empty to apply to all environments. Through the API, `environment` names one by its key, an alias or a run's label,
  resolved as a run's label is.
- **Commit** _(optional, `deploy` markers)_ — the application's commit the deploy put in place, 7 to 40 hexadecimal
  characters. A run of a [deployed environment](./environments) that started after the marker ran against that commit,
  unless its server reported its own.
- **Description** _(optional)_ — free-text detail.
- **Run** _(optional, API only)_ — the id of one of the project's runs the event belongs to.

## Where markers show up

<figure>
  <img src="/screenshots/run-trend-marker-tooltip.png" alt="A project's Run trend with markers drawn as dashed vertical lines, one hovered: a Release marker named v2.3.0 with its date, environments and description">
  <figcaption>Markers on the Run trend; hovering one shows its details.</figcaption>
</figure>

- **Project charts** — the **Run trend** and **Performance trend** charts render each marker as a dashed vertical line with a colored flag handle. Hover the line or its flag for the marker's details (category, label, date, environment, a deploy's short commit, linked run, description); click it to open the marker in the **Markers** panel, in its edit form when you can edit markers.
- **Markers panel** — a **Markers** button beside the **Run trend** chart (on the project's Runs tab) opens a panel listing the project's markers, newest first. **Add marker** and each marker's edit button open the form in the panel itself; **Delete** is on each marker and in the edit form.
- **Test-case history** — a single test's duration history chart shows the same markers, so you can tell whether an event affected that specific test. Clicking one opens it in the project's **Markers** panel.
- **Analytics charts** — the trend charts of the [analytics page](./analytics) draw the markers too, with the same details on hover: every marker with one project in scope; across projects only `release`, `infra` and `incident` markers, each labeled with its project. The **Timeline markers** widget lists a period's markers, and the analytics periods *Since a marker* and *Release cycle* start from them.
- **Run detail** — a run shows an **"After: …"** chip for the nearest preceding marker of its environment, or of all environments, so a single run tells you which event it followed.

## Environment scoping

Markers tie into the project's existing **environment filter**. When you filter the project view to one or more environments, the charts show only markers of the selected environment(s) plus any global (no-environment) markers. This keeps a staging-only event from cluttering your production view. A marker belongs to an environment as a run does: a marker written for `stg`, an alias of Staging, shows under Staging, and so does the analytics period's count of markers.

A marker keeps the label it was written with and the environment that label resolved to. Deleting the environment leaves the marker its label, matched as text.

## Who can edit markers

Reading markers is available to anyone who can read the project. Creating, editing, and deleting them requires the **Contributor** role or above on the project, or an administrator ([roles](/operate/project-access#what-each-role-can-do)). (When authentication is disabled, everyone can edit.)

## Automatic markers

Piwi can create markers for you when a run's tooling changes. On each finished run it compares the run against the previous run **in the same environment** (the environment its label resolved to, so `stg` and `staging` runs of Staging are one lineage) and, when the **Playwright version** or **reporter version** changed, adds an `auto` marker (category `config`) at that run's time — for example _Playwright 1.49.0 → 1.50.0_. Auto markers are labeled with a small sparkle icon and can be edited or deleted like any other.

When a run's [environment](./run-environment) differs from the previous run on the same branch and in the same
environment, it gets one `auto` marker per kind of change, labeled with the fields that changed: its runner or a
browser (category `infra`), or a server under test (category `config`). A kind either run did not record counts as no
change. A project that declines the Timeline markers [capability](/operate/capabilities) gets none of these.

A run flagged as an [environment incident](./environment-incidents) gets an `auto` marker in the `incident`
category, linked to the run.

This is enabled by default. Set `PIWI_AUTO_MARKERS=false` to turn all three off. See the [configuration reference](/reference/configuration).

## Release markers keep their run

A `release` marker linked to a run keeps that run forever: [data retention](/operate/storage#keeping-runs-forever) never deletes it, and the marker's label becomes the reason shown on the run. Deleting the marker, or changing its category to anything but `release`, releases the run again — unless someone kept it by hand or the reporter kept it at ingest, in which case the keep stays.

From CI, create the marker after the test step with the run id the reporter writes to its outputs (`piwi_run_id` on GitHub Actions, see [CI → Getting the run URL back out](/guide/ci#getting-the-run-url-back-out-of-ci)):

```bash
curl -X POST "$PIWI_DASHBOARD_URL/api/projects/<projectId>/markers" -H "Authorization: Bearer $PIWI_API_KEY" -H "Content-Type: application/json" -d '{"label":"v2.3.1","category":"release","occurredAt":"2026-09-24T12:00:00Z","runId":1234}'
```

## Recording deploys from CI

A deploy pipeline records each deploy as a `deploy` marker that names the environment by its key and the commit it
deployed. A run of that [deployed environment](./environments) that starts after
it reads its application at that commit, unless its server reports its own through an
[instrumentation package](/guide/backend-logs#server-environment). Instrumentation is off in production by default, so
production relies on these markers. The step runs after the deploy, with the project's id and an API key whose owner
can add markers on the project (Contributor and above, `marker:write`), kept as a CI secret.

On GitHub Actions, after the deploy step:

```yaml
- name: Record the deploy in Piwi
  env:
    PIWI_DASHBOARD_URL: ${{ vars.PIWI_DASHBOARD_URL }}
    PIWI_API_KEY: ${{ secrets.PIWI_API_KEY }}
  shell: bash
  run: >-
    curl --fail --show-error -X POST "$PIWI_DASHBOARD_URL/api/projects/12/markers"
    -H "Authorization: Bearer $PIWI_API_KEY" -H "Content-Type: application/json"
    -d "{\"label\":\"Deploy to staging\",\"category\":\"deploy\",\"environment\":\"staging\",\"commit\":\"$GITHUB_SHA\",\"occurredAt\":\"$(date -u +%FT%TZ)\"}"
```

On GitLab CI, in the deploy job, with `PIWI_DASHBOARD_URL` and `PIWI_API_KEY` as masked CI/CD variables:

```yaml
deploy-staging:
  stage: deploy
  script:
    - ./deploy.sh staging
    - >-
      curl --fail --show-error -X POST "$PIWI_DASHBOARD_URL/api/projects/12/markers"
      -H "Authorization: Bearer $PIWI_API_KEY" -H "Content-Type: application/json"
      -d "{\"label\":\"Deploy to staging\",\"category\":\"deploy\",\"environment\":\"staging\",\"commit\":\"$CI_COMMIT_SHA\",\"occurredAt\":\"$(date -u +%FT%TZ)\"}"
```

The commit is the pipeline's own, since the application lives in the tests' repository. A commit that is not 7 to 40
hexadecimal characters is refused. [Pass reuse](./reuse-forecast#skipping-reusable-tests) reads these markers too: a
deployed environment's passes stand in only for runs against the commit deployed now.

## API

Markers can also be managed through the REST API. See the interactive [API docs](https://piwitests.dev/demo/settings/api) for request and response shapes.

## Related

- [Regression or flake?](/recipes/regression-or-flaky): correlating a failure with a deploy
- [Analytics](./analytics): the trend charts the markers annotate
