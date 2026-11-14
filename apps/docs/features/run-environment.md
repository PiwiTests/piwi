---
title: Run environment
description: "Where each run executed (the runner, each browser, each server under test) and what changed between two runs, two shards, or a failure and its last pass."
lang: en-US
---

# Run environment

<Needs reporter />

Piwi records where each run executed, so "it fails on CI but not on my machine" and "it broke when the runner image
changed" become facts the dashboard shows. The reporter records three kinds of snapshot, each a closed list of fields:
no environment variable is copied whole.

| Snapshot | One per | Fields |
|---|---|---|
| **Runner** | shard | time zone, `TZ`, locale, `LANG` / `LC_ALL` / `LC_TIME`, OS and distribution, architecture, Node.js and ICU versions, CI runner image, container; host name, CPU and memory |
| **Browser** | shard and project | browser version, time zone, locale, languages, how it formats a number and a date, color scheme and reduced motion, headless; screen and user agent |
| **Server** | instrumented origin | runtime, OS, time zone, culture, globalization mode, environment name, app version; host name, process, start time, clock offset from the runner |

The browser snapshot needs the [capture fixtures](/guide/capture-fixtures): it is read from the test's page before the
test navigates. The server snapshot needs an [instrumentation package](/guide/backend-logs#server-environment). The
last fields of each row (after the semicolon) change by nature between runs and are never shown as a possible cause.
`collectEnvironmentInfo: false` in the reporter options, or `PIWI_COLLECT_ENVIRONMENT_INFO=false`, turns it all off.

## Where it shows

- **Run page**: the **Environment** line under the versions opens every snapshot, shard by shard. It warns when the
  shards disagree (two runner images, two time zones), when a server restarted during the run, and when a server's
  clock is more than 2 s off the runner's, enough to break token expiry and "created just now" checks.
- **Changes tab**: the runner, browser and server fields that changed against the baseline run, grouped, with every
  value of a field the shards disagree on.
- **Execution page**: the environment diff of the **State** tab, against the test's last pass. A browser time zone or
  locale the page did not report is _inferred_ from the declared value, else the runner's, and labeled so.
- **Trend charts**: an automatic marker on the run where the runner, a browser or a server changed, against the
  previous run on the same branch and environment label.
- **Flakiness tab**: the runner's time zone and locale become [flake suspects](/features/flaky-tests#suspects) when the failures
  share one and the passes another; the [Flake Lab](/features/flake-lab) runs the browser in it to confirm. The runner
  image and the browser version are listed as context.
- **MCP**: `get_run` returns the run's `environments`.

A run from an older reporter, or with collection off, shows nothing: it was never recorded, and is never read as a
change. Host names are left out of exports and share links.

## Fails on CI, passes locally

A CI runner usually runs in `UTC` with `en-US`, a laptop in its own time zone and language, and a browser takes both
from the machine unless the config sets `use.timezoneId` and `use.locale`. To reproduce a CI failure locally, run with
CI's values:

::: code-group

```bash [bash]
TZ=UTC LANG=en_US.UTF-8 npx playwright test
```

```powershell [PowerShell]
$env:TZ='UTC'; $env:LANG='en_US.UTF-8'; npx playwright test
```

:::

Browsers on Windows may not follow `TZ`: set `use.timezoneId` in the Playwright config instead.

## Related

- [Failure evidence](./evidence): the State tab and the rest of a failure's evidence.
- [Backend logs](/guide/backend-logs#server-environment): what a server under test answers.
- [Flake Lab](./flake-lab): confirm a time zone or locale suspect by experiment.
- [CI & sharding](/guide/ci): the run metadata the reporter collects.
