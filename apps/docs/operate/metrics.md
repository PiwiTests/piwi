---
title: Metrics and rollup export
description: "Serve the metric catalog as OpenMetrics for Prometheus and Grafana, and export the daily rollups as JSON or CSV for BI tools."
lang: en-US
---

# Metrics and rollup export

Piwi keeps one row of numbers per project and day (the [daily rollups](/features/analytics#where-the-numbers-come-from)), and those
rows survive [data retention](./storage#data-retention). Two endpoints hand them to tools you already run. Both
are pulls: **your Grafana pulls from your Piwi**, and Piwi sends nothing anywhere, so neither changes the "zero
telemetry" promise.

## OpenMetrics for Prometheus and Grafana

`GET /api/metrics` serves the metric catalog's current values per project in the OpenMetrics text format. It is
**off by default**: set `PIWI_METRICS_ENABLED=true` to serve it; otherwise it answers 404.

- One gauge family per metric, named after it and its unit: `piwi_test_pass_rate_percent`,
  `piwi_run_success_rate_percent`, `piwi_runs`, `piwi_wasted_ci_minutes_minutes`, `piwi_open_failure_causes`,
  `piwi_median_time_to_fix_days`, … Each family's `HELP` line carries the metric's definition.
- One sample per project, labeled `project` and `project_id`. A metric with nothing to count in the period
  (no run) has no sample, rather than a zero.
- The values cover the last 7 days on each project's default branch; `?period=last-30d` or `?allBranches=true`
  change that, with the scope keys of the analytics page.
- Answers are cached for 60 seconds, so a scrape interval under a minute reads the same numbers.

With [authentication](./authentication) on, the scraper sends an [API key](./api-keys), and the
samples cover the projects that key's user can open; a browser session is refused. Create a key for a Member
with the Viewer role on the projects you want to chart. A Prometheus scrape job:

```yaml
scrape_configs:
  - job_name: piwi
    metrics_path: /api/metrics
    scheme: https   # the key travels in a header: never over plain HTTP
    scrape_interval: 5m
    authorization:
      credentials: pd_your_api_key
    static_configs:
      - targets: ['piwi.example.com']
```

## Rollup export for BI tools

The rollups endpoint (in the example below) streams the daily rollup rows of the projects you can open: one row per project,
UTC day, environment, branch and run kind, with the history retention deleted still counted. It needs no flag.

- `?format=csv` downloads a CSV for a spreadsheet, Power BI or Metabase; the default `json` answers
  `{ "items": [...] }`.
- The scope keys of the analytics page narrow it: `period` (30 days by default; `all` for everything kept),
  `projects`, `projectTags`, `environments`, `branches`, `allBranches`, `fullRunsOnly`.
- For an average, divide `durationMs` by `durationRuns` (the runs with a duration) and the two
  `*TestDurationSumMs` columns by `testDurationRuns`. `maxTotalTests` is the largest suite one run reported.
- A cell that could run as a spreadsheet formula (a branch named `=…`) is prefixed with `'`.

```bash
curl -H "Authorization: Bearer pd_your_api_key" "https://piwi.example.com/api/rollups?format=csv&period=this-year" -o rollups.csv
```

The column list and every parameter are in the API reference (`/docs` on your instance).

## Related
- [Analytics](/features/analytics): the metrics, the scope and the periods
- [Quality reports](/features/quality-reports): the same numbers as a document for a reader
- [Configuration reference](/reference/configuration#general): `PIWI_METRICS_ENABLED`
