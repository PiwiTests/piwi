---
title: Bun
description: "Run a Playwright suite under Bun with bunx --bun playwright test: what the Piwi reporter and capture fixtures record there, and the limits that come with Bun."
lang: en-US
---

# Bun

Playwright 1.65 and later run under [Bun](https://bun.sh) with `bunx --bun playwright test`, and so do the Piwi
reporter and the [capture fixtures](./capture-fixtures): set up as under Node, they send the same results and
attachments, with the limits below.

## Run the suite under Bun

```bash
bunx --bun playwright test
```

`--bun` runs Playwright's command line on Bun, and the workers it starts run on the same Bun. Without it, `bunx`
follows the script's `node` line and the suite runs on Node. Any `playwright test` option goes after it, as with
`npx`.

The setup is the [reporter](./reporter)'s: `wrapConfig` in `playwright.config.ts` and the fixtures in your tests. In a
project Bun installs (a `bun.lock`), `npx @piwitests/reporter init` adds the reporter with `bun add -d`. The Piwi
server is not part of this: it runs on Node, wherever you [deploy](/operate/deployment) it.

## What Piwi records

The reporter sends the run as it does under Node: each test's results, retries, errors and attachments, the traces
and screenshots Playwright records, and the capture fixtures' evidence, streamed as the tests finish.

The [machine panel](/features/cpu-memory-disk#the-panel) measures the runner, its workers and their browsers by role,
as under Node: Piwi tells a worker by the script Playwright runs in it, whichever runtime runs that script.

## Limits

- **The trace has no console.** The trace Playwright records under Bun holds no console messages. The capture
  fixtures still record them; in a project without the fixtures, the console card cannot be recovered from the trace.
- **Call stacks lose their async frames.** Bun's stacks leave out most of the `async` frames Node keeps. Where Piwi
  places something by its stack, such as an error Playwright gives no location or the line that opened a page left
  open, a call made after an `await` in a helper or a package can name no line of your tests.
- **A test's column can be off by one.** Under Bun 1.4.4 and later, Playwright can report a test's column one off
  ([microsoft/playwright#43934](https://github.com/microsoft/playwright/issues/43934)), and Piwi keeps the location
  it reports. The file and the line are right, and a test's history does not depend on the column.
- **The worker's event loop busy time is not measured.** Bun's `performance.eventLoopUtilization()` reads no idle
  and no active time, so the panel's **Workers** line leaves it out and its **Not measured** line names it, and each
  execution's Performance tab shows no busy share. The loop's delay and the context switches are measured.
- **No heap after garbage collection.** Bun reports no garbage collections to the performance observer Piwi reads, so
  a worker's heap is never judged [piling up](/features/resource-leaks#what-it-reports), and the panel's **Not
  measured** line names it. Its open file descriptors are still judged.

## Related

- [Reporter](./reporter): the setup, the same under Bun
- [Capture fixtures](./capture-fixtures): what they record
- [CPU, memory & disk](/features/cpu-memory-disk): the machine panel
