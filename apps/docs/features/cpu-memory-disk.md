---
title: CPU, memory & disk
description: "What a test run cost the machine: CPU by process, time spent waiting for a CPU, peak memory and disk, printed by the reporter at the end of every run and shown on the run's Resources tab."
lang: en-US
---

# CPU, memory & disk

<Needs reporter />

A suite that got slower may be doing more, or waiting: for a CPU shared with too many workers, for memory the
container is about to run out of, for a disk filling with traces. The reporter samples the run's processes and the
machine while the tests run and prints, at the end, what the run had and what it used of it. It needs no fixtures; on
GitHub Actions the panel joins the job summary, and the dashboard shows it on the run.

## The panel

```text
[Piwi Dashboard] Machine: 4 cores · 15.7 GB · container limit 13.4 GB · steal 1.5%
[Piwi Dashboard]   CPU      ▃▆█████▇▆▃▁ 92% busy · a task waited for a CPU 79% of the time · 1 min 33 s of CPU: renderers 41.0 s · browsers 22.0 s · workers 18.0 s · web server 11.0 s · renderers waited 39.0 s for a CPU
[Piwi Dashboard]   Memory   peak 1.6 GB (PSS) at 0:21 · 12% of the limit · largest process: worker 251 MB · no memory pressure
[Piwi Dashboard]   Disk     145 MB of artifacts (traces 140 MB · screenshots 5 MB) · 430 MB in use at the peak · 13.9 GB free at the low point
[Piwi Dashboard]   Workers  event loop busy 28% · p99 delay 181 ms at worst · 2,100 involuntary context switches per test
```

It follows the [resource leaks](./resource-leaks) summary when the run has any.

| Line | What it says |
|---|---|
| **Machine** | The cores and memory the run had. In a container, its memory limit and CPU quota, what the run really gets; on a cloud VM, the CPU time the hypervisor took (steal) when it reaches 1%. |
| **CPU** | How busy the machine was, sampled every second (the sparkline), and the share of the time some task was ready to run but **waited for a CPU**: the measure of too many workers for the cores. Then the CPU time of the run's processes by role, and the role that waited longest. |
| **Memory** | The peak of the run's processes together, counted as PSS (proportional set size: shared memory is split between its sharers, so the sum is honest), when it happened, against the container's limit or the machine's memory, and the largest process. A container that hit a new peak, a process it killed for memory, and time spent waiting for memory are named. |
| **Disk** | The files the tests attached (traces, videos, screenshots), the most disk the run's output folders and browser profiles took at once, and the lowest free space on their disks. Profiles and artifact folders earlier runs left in the temp folder are named from 10 MB. |
| **Workers** | With the [capture fixtures](/guide/capture-fixtures): how busy each worker's event loop was, the worst p99 delay, and how often the worker was switched out of a CPU it still needed. A worker that drives the browser late makes actions slow and timeouts flaky. |

The roles come from each process's command line: Playwright's **workers**, the **browsers** they launch with their
**renderers** (the processes pages run in), **GPU** process and **browser utilities**, **ffmpeg** when videos are recorded,
the **runner** (Playwright's main process, with the reporters), and the **web server**: whatever the runner starts that
is none of these, `webServer` and `globalSetup` servers alike.

## Reading it

- **Waiting for a CPU most of the time, renderers waiting longest**: more workers than the cores can serve. Lower
  `workers`, or look for pages that keep working after their test: the [resource leaks](./resource-leaks) summary
  gives the main-thread CPU each leaked page used after it.
- **Memory near the limit**: each worker holds a browser, and each open page a renderer. Fewer workers, or close what
  the tests leave open.
- **Most of the CPU in the GPU process or ffmpeg**: tracing screenshots and video frames are rendered in software on a
  machine without a GPU. `trace: 'on-first-retry'` and `video: 'on-first-retry'` record only what a retry needs.
- **Disk in use far above the artifacts**: traces are written and zipped in place; a green `retain-on-failure` run
  writes them all, then deletes them.
- **A large web server share**: a development server compiles on demand; serve a production build in CI.

## Platforms

| | Linux | macOS | Windows |
|---|---|---|---|
| Machine busy, the sparkline | ✅ | ✅ | ✅ |
| CPU of the run's processes by role | ✅ every second | ✅ every 5 seconds, through `ps` | ✅ every 15 seconds, through CIM |
| Waiting for a CPU, steal | ✅ | not measured | not measured |
| Peak memory | ✅ PSS | RSS, shared pages counted in each process | Working set, shared pages counted in each process |
| Container limits, peak, kills | ✅ cgroup v1 and v2 | — | — |
| Disk, workers | ✅ | ✅ | ✅ |

A line lists what could not be measured on the machine, rather than printing a zero. The workers' reads are taken at
each test's start and end; on Linux they add the CPU, the waiting and the peak memory of each browser process during
the test, kept with its census.

## In the dashboard

The reporter sends the panel with the run, which shows a **Resources** tab: the machine each shard ran on, the CPU
over the run, when memory peaked, the panel's lines, and the [resource
leaks](./resource-leaks#in-the-dashboard) found. Below them, the **costliest tests**: the tests whose worker and
browser processes used the most CPU.

The run's **Timeline** tab draws the same samples on the tests' time axis, above the worker rows: the machine's
**CPU** busy share, the **memory** the run's processes held, and, with the capture fixtures, the **pages** open in the
workers. Hover a track for its values and the tests running then; the **Resources** menu turns each track off, a
choice kept per browser. A sharded run draws one set of tracks per shard, each from its own machine.

While someone watches a running run, the tracks fill in **live** every five seconds; leak verdicts wait for its end.

The same menu draws one metric **under each worker** row, on one scale for all: its open pages, the CPU and
memory of the worker and its browsers, or the share of each test its browsers spent waiting for a CPU (Linux). The
sampler tells workers apart through the capture fixtures; otherwise, or from an older reporter, each test's own cost
is drawn across its bar.

With the capture fixtures, each execution's Performance tab shows what its test cost: the CPU of the worker and of
its browser processes, the largest of those, the worker's event loop, and the pages it found and left open. A
failed execution's **Timeline** tab draws, behind its **Resources** switch, the CPU, memory and open pages of the
test's worker under its lanes, with the failure line across them.

## Cost

The sampler runs on a timer in the reporter's process, which it never keeps alive: about 2 ms of CPU a second to
read the processes' CPU time, and on Linux about 30 ms every five seconds for their memory and the output
folders (up to 10,000 files), under 1% of one core. macOS reads the tree through `ps` every five seconds, Windows
through a PowerShell CIM query every fifteen (about half a second of CPU; a read still running delays the next). The
workers' reads take about 2 ms at the end of each test.

Turn it off, with the resource ledger, through `captureResources: false` (or `PIWI_CAPTURE_RESOURCES=false`).

## Limits

- The dashboard keeps 240 points of the CPU series, averaged from the samples of a longer run. The timeline's tracks keep
  600 points of CPU and of memory, 300 of each worker's, merged in time order on a longer run; memory is read every five
  seconds, so a short run's memory track has few points.
- **Sampled.** A process that lives less than a second, or the last second of one that exits, can be missed; a run of a
  few seconds has few samples, and on Windows the tree is read every fifteen seconds.
- **The machine is shared.** Busy, waiting and free memory count every process on the machine, other jobs included;
  only the CPU by role and the peak memory are the run's own.
- A browser the tests reach over the network (`connectOptions`, a grid) runs elsewhere and is not measured.
- A container's peak memory counts from the container's start, so it is named only when the run raised it.

## Try it in the demo

The [live demo](https://piwitests.dev/demo/) holds a leaky run whose machine runs short of CPU and memory.

<DemoExamples />

## Related

- [Resource leaks](./resource-leaks): what the tests leave open
- [Reporter options](/reference/reporter-options#what-gets-captured): `captureResources`
- [Slow tests & wasted time](./slow-tests): where the suite's time goes
