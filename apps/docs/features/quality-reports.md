---
title: Quality reports
description: "The Analytics page as a document for readers who never open the dashboard: exports, report schedules, snapshots and the cost of a CI minute."
lang: en-US
---

# Quality reports

<Needs reporter />

A **quality report** is a document about the state of one or several projects over a period, written
for a reader who may never open the dashboard: a manager, a release owner, a client. It is not the
Playwright HTML report a run carries (the **run report**); it is the [Analytics](./analytics) page turned
into something you can send.

## What a report contains

A report renders a **dashboard**, an arrangement of analytics widgets in bands, over a **scope**: the
projects, branches, environments, test filter and period of the analytics **Filters** block. Any
[saved dashboard](./dashboards) can be exported and scheduled; two built-in dashboards exist for
reports:

- **Executive**, for stakeholders, in plain words with no locators and no stack traces: a verdict,
  six headline numbers, the pass rate over time with the comparison period and your
  [timeline markers](./timeline-markers), what changed, what is being done (causes fixed, assigned or
  ticketed, tests released from quarantine) and the risks (metrics moving the wrong way, projects
  failing run after run, the oldest open causes).
- **Engineering**, for the team that owns the suite: the executive report, then the flakiest tests,
  the failure clusters, wasted CI time, regressions, CI time, the [combined coverage](./combined-coverage) trend
  (left out when no project in scope has coverage), the browser matrix and slow endpoints.

- **Team**, the engineering report for the tests one owner holds (`piwi:owner` or CODEOWNERS), offered
  when a test in scope has an owner.
- **Gaps digest**, the [Test Map](./scenario-gaps)'s weekly digest: the top five new gaps of each
  project, then open gaps by class and feature. A project that declined the Test Map is left out.

The engineering report ends with the same gap counts. **Overview**, the analytics page itself, can be
exported too.

Every report ends with a footer stating the scope, the branch policy, the period and its comparison,
each metric's definition, and its limits: lists of tests reach back only as far as
[retention](/operate/storage#data-retention) keeps runs, and days are UTC.

### The verdict is built by rules

The opening sentence ("The pass rate on main fell 2.1 points to 95.8%, and 3 failure causes were
fixed.") comes from fixed rules over the numbers, never from a model. Its tone is **good** at a pass rate
of 90% or more that did not drop by more than a point, **bad** under 50% or after a drop of 5 points or
more, **mixed** otherwise.

## Exporting a report

Click **Export** on the Analytics page (the current scope) or on a project page (that project, last 30
days). The dialog previews the report; pick another dashboard or the language, then **Download**:

| Format | What you get |
|---|---|
| PDF | Vector text and charts, one band per page so pages drop into a slide deck |
| HTML | One self-contained file: inline charts, no script, no remote resource |
| Markdown | Tables, and a text sparkline (`▁▂▃▅▇`) under each series; pastes into Confluence, Jira or a pull request |
| Excel | An .xlsx workbook, a sheet per table named after its widget; numbers and dates are real cells, text never runs as a formula. Each section's **Excel** button downloads just that section |
| JSON | The report bundle itself, for scripts and BI tools |

Scripts can ask the API for `format=csv`, formula-guarded with a leading `'`.

A report grants no access: it covers only the projects its reader can open.

## Report schedules

A **report schedule** sends a quality report on its own. **Schedule…** on the Analytics page or in a
project page's menu opens the form with the filters on screen; **New schedule** on the **Quality
reports** page starts an empty one. A Contributor or above on the project, or an administrator, creates schedules.

![The Quality reports page: report snapshots and schedules](/screenshots/report-schedules.png)

- **When**: daily, weekly, every other week or monthly, at a time in the instance time zone (UTC when
  that setting follows each browser).
- **Which period**: the whole days since the previous report, so a weekly Monday schedule reports on
  Monday to Sunday; the first one covers the days since you created it. A period with no run is still
  sent, because a stopped pipeline is news.
- **Where**: [notification channels](./notifications). Email carries the verdict, the numbers and the
  trend as an image; Slack and Microsoft Teams the same as a message; a webhook the whole bundle as signed JSON; a browser
  channel a notification. With **Share link** on, each report carries a
  [share link](./share-links#report-share-links) that opens it without an account.
  **AI narrative** adds the [narrative](/reference/analytics-widgets#where-things-stand) the AI model writes.
- **Who receives it**: **Send to** lists each channel with its recipient (an address, the Slack or Teams
  channel its webhook posts to, a webhook's host, dashboard tabs) and whose it is: yours, global, or
  another person's. The schedules on the **Quality reports** page show the same, with each schedule's owner.

**Run now** sends the last complete period straight away; **Preview**, in the form, shows that report
before you save, as its email and as the full report, and sends nothing. **Mute** keeps the snapshots
and sends nothing; **Pause** stops the schedule. Each firing uses its owner's current roles. A **global**
schedule covers every project, goes to global channels and needs an administrator.

The server checks schedules every five minutes; a firing missed while it was down happens at the next
check, for its own period. The [desktop app](./desktop) fires them while it runs; the demo
has no scheduler.

### Report snapshots

Every report sent is kept as a **report snapshot** with its numbers as they were: a report received in
March reads the same in June, whatever [retention](/operate/storage#data-retention) deleted since. The
**Quality reports** page lists them with how each was delivered, to read, download or
[share](./share-links#report-share-links). You see a snapshot
when you can open every project it covers. Snapshots go after `PIWI_RETENTION_REPORT_DAYS` days (365; 0
keeps them).

## Language

Reports come in English and French: by default the project's
[ticket language](./issue-tracking#language) over one project, else the instance locale. Test titles
and error messages stay as recorded.

## Cost of a CI minute

An administrator can give a CI minute a price in **Settings → Performance**: an amount and an ISO 4217
currency, such as 0.008 USD. `PIWI_CI_MINUTE_COST` (`"0.008 USD"`) pins it and makes the setting
read-only. Once set, every wasted-time number is followed by its cost, on the analytics page and in the
quality report; unset, only minutes show. The cost is one instance-wide value.

## From CI, an agent or a script

- The [`piwi report`](/reference/cli#report) command prints a report with an API key, so a scheduled CI
  job can post the Markdown every Monday:
  `npx @piwitests/reporter report --project checkout --period 7d --format md`.
  `--fail-on bad` makes it exit 1 on a bad verdict.
- The [MCP server](./mcp) offers `get_quality_report` (the bundle), `get_metric_trend` (one metric over
  time) and `compare_periods` (the headline numbers over two periods).
- The REST API renders a report for a dashboard, format, language and analytics scope, manages schedules and
  reads snapshots. See the [API docs](https://piwitests.dev/demo/docs), or `/docs` on your instance.

## Turning reports off

Quality reports are an optional [capability](/operate/capabilities#declining-a-capability). Declining it in Setup hides
the *Export* and *Schedule…* actions and the *Quality reports* page, and drops `get_quality_report` from
the MCP tools; the analytics page and the metric tools stay, since analytics is core. A schedule or a
snapshot counts as use, so the capability stays on while one exists: delete them first.
