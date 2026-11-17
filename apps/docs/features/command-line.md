---
title: Command line
description: "The piwi command the Playwright reporter package installs, by the moment you reach for it: set up, gate CI, pick the tests, chase a flake, write a test."
lang: en-US
---

# Command line

<Needs reporter />

The `@piwitests/reporter` package installs a command, `piwi`, for what happens around a test run. Run it through the
package name, `npx @piwitests/reporter <command>`, or as `npx piwi <command>` once the reporter is a dependency of the
project. This page says which command serves which moment; every flag, and how a command finds the dashboard and its
API key, is on the [Piwi CLI reference](/reference/cli).

## Setting up

- **[`init`](/reference/cli#init)** wires a Playwright project up to a dashboard: the reporter, the
  [capture fixtures](/guide/capture-fixtures), a `.env` and the [agent skills](./agent-skills).
- **[`skills`](/reference/cli#skills)** installs or updates the agent skills in a project `init` did not set up.
- **[`mcp`](/reference/cli#mcp)** serves the runs of this machine's editors and desktop app to a coding agent
  ([Run control for agents](./agent-run-control)).

## In CI

- **[`gate`](/reference/cli#gate)** fails a job on the dashboard's analysis of the run: the
  [CI merge gate](./merge-gate).
- **[`rerun`](/reference/cli#rerun)** runs the tests a [re-run in CI](./ci-rerun) asked for, in a GitLab, Bitbucket
  or Jenkins job.
- **[`report`](/reference/cli#report)** prints a [quality report](./quality-reports), for a scheduler to post.
- **[`coverage`](/reference/cli#coverage)** uploads another tool's coverage of a commit, for
  [combined coverage](./combined-coverage).

## Choosing the tests

- **[`select` and `run`](/reference/cli#select-run)** resolve a saved [test selection](./test-selection), or the
  tests a diff reaches ([Impact from a diff](./change-impact)), and print or run them.
- **[`plan`](/reference/cli#plan)** plans a run that reuses the passes whose code has not changed
  ([Reuse forecast](./reuse-forecast)), an experimental capability.
- **[`probe`](/reference/cli#probe)** runs the dashboard's [probe plan](./probes).

## Chasing a flaky test

- **[`flake`](/reference/cli#flake)** makes a flaky test fail on demand under its suspects' conditions, then verifies
  the fix ([Flake Lab](./flake-lab)).

## Writing and fixing a test

- **[`codegen`](/reference/cli#codegen)** turns a Piwi Picker recording into a spec ([Record a test](./record-actions)).
- **[`bug`](/reference/cli#bug)** writes a [bug report](./bug-reports)'s failing test into the project and runs it.
- **[`preflight`](/reference/cli#preflight)** lists the test locators your change breaks, and fixes them
  ([Locator preflight](./preflight)).
- **[`ai`](/reference/cli#ai)** manages the committed artifacts of [AI steps](./ai-steps).

## Related

- [Piwi CLI](/reference/cli): every command and flag
- [Write, run and fix a test](./write-run-fix): the loop the editor, Piwi Picker and the desktop app share
- [Reporter](/guide/reporter): the package the command ships in
