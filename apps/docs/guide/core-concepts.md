---
title: Core concepts
description: "The words a first Playwright run in Piwi meets: project, test run, test case, execution, baseline, failure cluster, and where each lives in the dashboard."
lang: en-US
---

# Core concepts

Piwi reuses Playwright's vocabulary where it can, but a dashboard that keeps history needs a few distinctions
Playwright doesn't have to make, most importantly between *a test* and *one run of that test*. This page names the
dozen words a first run meets; the [Glossary](./concepts) defines every word the docs and the dashboard use, each
under the anchor other pages link.

## The object model

<figure>
  <img src="/diagrams/data-model-grid.svg" alt="A project as a grid: test runs are columns, test cases are rows, and each cell holds that test case's executions in that run; one failure cluster spans failed executions of two test cases across two runs">
  <figcaption>A project holds one suite's results. A failure cluster groups executions, not test cases: it can span several of each.</figcaption>
</figure>

Read it in two directions:

- **Down**: "what happened in this run?" A run holds executions; each execution points at the test it is an attempt
  of.
- **Across**: "how has this test behaved?" A test case holds every execution of itself, in every run, over time.
  That's the axis flakiness, pass rate and duration trends are computed on.

## The words a first run meets

- **[Project](./concepts#project)**: one suite's results, created the first time results arrive under a new
  `projectName`.
- **[Test run](./concepts#test-run)**: everything one `npx playwright test` invocation produced; one CI pipeline's
  shards make one run.
- **[Test case](./concepts#test-case)**: a test's identity across time (file, `describe` path and title), the same on
  every browser. "This test is flaky" is about a test case.
- **[Execution](./concepts#execution)**: one attempt of one test case, in one run, on one browser. A retry is an
  execution of its own.
- **[Pass rate](./concepts#pass-rate)** and **[flaky rate](./concepts#flaky-rate)**: the share of a test's results
  that passed, and that passed only on a retry.
- **[Baseline](./concepts#baseline-last-green-run)**: the earlier run a run is compared with to answer "what
  changed?", by default the last passing one.
- **[New regression, newly flaky](./concepts#new-regression-newly-flaky)**: what a test did differently from the
  baseline.
- **[Environment](./concepts#environment)**: a free-text label on a run (`staging`, `production`) that analysis can be
  narrowed to.
- **[Failure cluster](./concepts#error-fingerprint-failure-cluster)**: the failed executions that share an error
  fingerprint, triaged once.
- **[Cluster state](./concepts#cluster-state)**: where a cluster stands, in one sentence (*still failing*, *stopped
  failing*, *regressed*).
- **[Flakiness score](./concepts#flakiness-score)**: how flaky a test is over its history, which ranks the flaky
  tests.
- **[Tags & ownership](./concepts#tags-ownership)**: the tags and the owner a test declares, which filter the views
  and route its failures.

## Where each concept lives in the UI

| Concept | URL | Docs |
|---|---|---|
| Project | `/projects/:id` | [UI overview](/features/ui-overview#project-detail) |
| Test run | `/test-runs/:id` | [UI overview](/features/ui-overview#test-run-detail) |
| Test case | `/test-cases/:id` | [Failure evidence](/features/evidence#the-test-case-page) |
| Execution | `/test-run-cases/:id` | [Failure evidence](/features/evidence#one-execution-diagnosis-first) |
| Failure cluster | `/failure-clusters/:id` | [Failure clusters](/features/failure-clusters) |
| Cross-project view | `/analytics` | [Analytics](/features/analytics) |
| Quality report | *Export* on `/analytics` and `/projects/:id` | [Quality reports](/features/quality-reports) |
| Report schedule, report snapshot | `/reports`, `/reports/:id` | [Quality reports](/features/quality-reports#report-schedules) |

## Related

- [Glossary](./concepts): every word, with the page that holds its rule
- [Getting started](./getting-started): get results flowing in
- [Your first failure, explained](./first-failure): the words above on one failing test
- [UI overview](/features/ui-overview): a map of every page
