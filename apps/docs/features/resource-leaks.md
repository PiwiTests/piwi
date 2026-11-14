---
title: Resource leaks
description: "The browsers, contexts, pages and API request contexts your tests leave open or open for nothing, listed at the end of each run and on its Resources tab, with the line that opened them."
lang: en-US
---

# Resource leaks

<Needs reporter fixtures />

A browser context a test never closes keeps its renderer processes, memory and CPU until the worker shuts down, and
every later test on that worker runs next to it. Playwright closes what its own fixtures open; what a test opens by
hand is the test's to close. The [capture fixtures](/guide/capture-fixtures) keep a ledger of what each test opens,
and at the end of the run the reporter lists what stayed open past the scope that opened it, with its line.

## The summary

The reporter prints it after the last test, before the upload, and adds it to the job summary on GitHub Actions:

```text
[Piwi Dashboard] Resources: 3 leaks · 6 idle pages · 1 piling up · 1 handle left in workers · 1 lingering
[Piwi Dashboard]   leaked    context     tests/cart.spec.ts:12 · 4 contexts · with 4 pages · 4 tests · open until the worker shut down (41.2 s past its test) · 18.3 s of page CPU after its test · last used at tests/cart.spec.ts:15
[Piwi Dashboard]   leaked    page        popup after locator.click at tests/checkout.spec.ts:30 · 2 pages · 2 tests · open 3.1 s past its test · last used at tests/checkout.spec.ts:31
[Piwi Dashboard]   leaked    context     tests/admin.spec.ts:8 · beforeAll of "admin" · 1 test · open until the worker shut down (12.0 s past its describe block) · last used at tests/admin.spec.ts:19
[Piwi Dashboard]   piling    listeners   fixture "adminPage" at tests/fixtures.ts:21 · 11 → 31 listeners over 20 tests
[Piwi Dashboard]   handle    server      tests/pay.spec.ts:14 · left running in the worker by "mocks the payment API" (tests/pay.spec.ts)
[Piwi Dashboard]   idle      page        fixture "page" · 6 pages · 6 tests · set up with consoleCollector (tests/fixtures.ts:40)
[Piwi Dashboard]   lingering page        popup after locator.click at tests/export.spec.ts:22 · 1 test · open 6.4 s after its last use · last used at tests/export.spec.ts:23
[Piwi Dashboard] Set leakCheck: 'fail' (PIWI_LEAK_CHECK=fail) to fail the tests that leave what they open, or 'close' to close it.
```

Findings of one line are grouped: the first above is one line leaking in four tests. Each leak names the line that
last used it, where its `close()` belongs. A leaked context
or browser carries the pages open in it, and a page `browser.newPage()` opened carries the context made for it. At most
ten findings are listed; the rest are counted. In Chromium, the fixtures read each page that outlives its test over the
DevTools protocol, so a leak also says how much CPU its pages' main threads used after their test, from half a second.
The [CPU, memory & disk](./cpu-memory-disk) panel follows, with what the whole run cost the machine.

## What it reports

| Finding | What it means | The usual fix |
|---|---|---|
| **leaked**, past its test | Opened by the test body or its `beforeEach`/`afterEach`, and still open when the test ended. Nothing in the same file closed it later. | `close()` or `dispose()` before the test ends, or `await using` |
| **leaked**, past its describe block | Opened in a `beforeAll` (or an `afterAll`) and still open once the tests of its describe block ran. | Close it in `afterAll` |
| **piling up** | A page or context living across tests whose open pages, listeners, route handlers or DOM elements kept growing; or a worker whose open file descriptors, or heap after V8's own full garbage collections, did | Remove what each test adds or opens; in a worker, what a module variable, cache or pool keeps |
| **handle** | A server, child process or file watcher a test started and left running in the worker; a server or process at its line | Close or kill it in the test or an `afterEach` |
| **idle** | A page opened and never used: no navigation, and no call of the test's on it. The detail names the fixtures of yours that set it up. | Drop the `page` argument, or the fixture that asks for it |
| **lingering** | A browser, context or page the test body opened and closed within the test, but long after its last use: at least 2 s, and a third of the test or more. A popup checked once, then left to the `page` fixture. What a hook or a fixture opens, and an API request context, never is. | Close it right after its last use |
| **probable** | Without the fixtures, from a test's steps: a browser, context or `browser.newPage()` page nothing in its file closed | Use the fixtures for exact findings |

What is never reported:

- what a **worker-scoped fixture** holds, servers and processes included: it lives as long as the worker;
- a context Playwright **reuses** on purpose (UI mode, `--reuse-context`);
- an object **handed on** to a later test, or a `beforeAll` object an `afterAll` closes, within the same file;
- what a **failed test** left open: Playwright shuts its worker down right after it.

## Fail or close leaks

`leakCheck` (or `PIWI_LEAK_CHECK`) decides what the fixtures do with an object a test opened itself and left open:

- `'report'`, the default, only lists it;
- `'fail'` also fails the test, naming each object and its line;
- `'close'` closes it when the test ends, and lists it as *closed by Piwi*.

```typescript
wrapConfig(config, { projectName: 'my-project', leakCheck: 'fail' })
```

```text
Error: Piwi: this test left one object open:
  - a context opened at tests/cart.spec.ts:12, with 1 page, last used at tests/cart.spec.ts:15
Close each after its last use (await using, close() or dispose()), or set PIWI_LEAK_CHECK=report to only list them.
```

A `beforeAll` object, and what a fixture opens, are only ever reported. Each test is judged when it ends, so a test that
hands what it opened to the next one fails under `'fail'` and loses it under `'close'`: open such objects in
`beforeAll` and close them in `afterAll`.

The ledger is on whenever the fixtures are. Turn it off with `captureResources: false` (or
`PIWI_CAPTURE_RESOURCES=false`). Like every fixture option, set both through
[`wrapConfig`](/guide/reporter#installing-via-wrapconfig) or their variable: the test workers never see a plain
reporter entry's options.

## In the dashboard

The findings are listed on the run's **Resources** tab, beside what the run cost the machine
([the tab](./cpu-memory-disk#in-the-dashboard)). Its switch draws each worker's open pages on the run's Timeline: a
leak climbs test after test, a clean worker stays flat.

On the run's **Timeline** tab, a red tail under a worker's row runs from the test that left an object open to its
close or the worker's end, and an amber one from an object's last use to its close. Hover one for its lines; click it
to open its test. The open pages graphs draw the pages left open in red, and **Show leaks** turns all of it off.

<figure>
  <img src="/screenshots/run-timeline-leaks.png" alt="A run's Timeline tab: under each worker's row, red tails from each test's end to the worker's end, one amber tail inside a test, and the tooltip of the amber one naming where the popup was opened, its test, how long it stayed open after its last use and the line that last used it">
  <figcaption>Leaks under each worker on the Timeline tab.</figcaption>
</figure>

The execution page's Performance tab shows what that one test cost and what it left open. A project that declines the
**Resources** capability in **Settings → Capabilities** hides both, and the reporter's summary stays as it is.

<figure>
  <img src="/screenshots/run-resources.png" alt="A run's Resources tab: counts of leaked, never-used, piling-up and left-running resources, the four findings, each with the fixture, file or test behind it, the machine's CPU, memory and disk, and the costliest tests">
  <figcaption>A run's Resources tab.</figcaption>
</figure>

## In CI

Each finding keeps a history across runs: whether it is new to a pull request's base branch, and once fixed, the run
that fixed it. `piwi gate`, the pull-request comment and MCP read it: [Leak history in CI](./leak-history).

## Cost

The ledger listens to the calls Playwright already reports and does its bookkeeping at the end of each test, adding
nothing to the steps or the trace. In Chromium, a page still open at the end of a test is read over the DevTools
protocol: about 20 ms the first time, to open a session, then a couple of milliseconds per test while it stays open.
Servers and child processes are placed by wrapping Node's `listen` and `spawn` in each worker.

## Limits

- The dashboard keeps the first 100 findings of each run, most severe first.
- **Playwright internals.** The ledger reads Playwright's instrumentation hooks, the calls on the worker's connection to
  its browsers, the runner's current test and fixture, and a few private fields (`_routes`, `_ownerPage`, `_opener`).
  Each is checked before use: without the hooks the ledger stays off, and without the connection a page counts as used
  only when it navigates, loads, runs a script or builds a locator, and no finding names a last use.
- An object kept in a module variable on purpose and closed by another spec file reads as leaked.
- A fixture with a `timeout` of its own runs with the slot a worker fixture has: what it leaves open is reported once
  its test's teardown steps show it torn down with the test, or once it opened something in two tests of the same
  worker. A boxed one (`box: true`) leaves no step, so only the second applies.
- **Probable leaks** come from step titles, which name no object, and the lines they point at. A close goes to the open
  assigned its name (`ctx` in `ctx.close()`); `page.context().close()`, on no name, may take another object of its
  test. A page counts as `browser.newPage()` when the name before `.newPage` is a browser's. A browser's `close()`
  closes what was opened on its name. A fixture's objects and API request contexts, whose `dispose()` leaves no step,
  are never counted.
- Sockets and timers are not reported: they move on every test, Playwright's own included. DOM elements are counted
  in Chromium only, and a small heap leak shows only over a long run.

## Try it in the demo

The [live demo](https://piwitests.dev/demo/) holds a leaky run, and its run simulator replays one: pick **Leaky run**.

<DemoExamples />

## Related

- [Capture fixtures](/guide/capture-fixtures): what else the fixtures record
- [Reporter options](/reference/reporter-options#what-gets-captured): `captureResources` and `leakCheck`
- [Leak history in CI](./leak-history): new leaks, fixed ones, and the gate
- [CPU, memory & disk](./cpu-memory-disk): what the whole run cost the machine
- [Slow tests & wasted time](./slow-tests): where the suite's time goes
