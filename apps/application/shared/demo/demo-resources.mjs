/**
 * What the demo's runs cost and left open, for the seed generator and the run
 * simulator: each execution's cost as a worker measures it at the end of the
 * test, and the run's report as the reporter sends it with its finish (the
 * findings, the machine, the pages open in each worker test after test).
 *
 * A leaky run is a suite whose login fixture opens a browser context per test
 * and never closes it: every test after the first finds the earlier tests'
 * pages still open in its worker, those pages keep using CPU and memory, and
 * the machine runs short of both. One of its tests also keeps a preview popup
 * open long after its last check. A clean run closes everything it opens.
 * Both keep a page per worker open from its first test to its last (the
 * `sharedPage` fixture). Deterministic (no randomness), so the seed stays
 * byte-stable. Pure plain JS, run under Node for the generator and in the
 * browser for the simulator.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A stable 0..1 value from an integer, for variation without randomness. */
function wobble(n) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * One execution's cost. `openAtStart` is how many pages earlier tests of the
 * same worker left open (each in its own leaked context); in a leaky run they
 * keep rendering in the background, so the renderers' CPU and memory grow
 * with them.
 */
export function demoExecutionResources({ seq, durationMs, openAtStart = 0, leaky = false }) {
  const w = wobble(seq);
  const background = leaky ? openAtStart : 0;
  const rendererCpu = Math.round(durationMs * (0.32 + 0.06 * w) + background * durationMs * 0.11);
  return {
    workerCpuMs: Math.round(260 + 180 * w),
    roles: {
      renderer: {
        cpuMs: rendererCpu,
        runWaitMs: Math.round(rendererCpu * (leaky ? 0.08 + background * 0.03 : 0.02)),
        peakRssMb: Math.round(150 + 30 * w + background * 46),
        processes: 1 + background,
      },
      browser: {
        cpuMs: Math.round(durationMs * 0.05),
        runWaitMs: null,
        peakRssMb: Math.round(210 + 20 * w),
        processes: 1,
      },
      gpu: { cpuMs: Math.round(durationMs * 0.03), runWaitMs: null, peakRssMb: Math.round(90 + 10 * w), processes: 1 },
    },
    loopUtilization: Math.round((0.16 + 0.08 * w + (leaky ? 0.03 * background : 0)) * 100) / 100,
    loopDelayP99Ms: Math.round(21 + 6 * w + (leaky ? 9 * background : 0)),
    involuntarySwitches: Math.round(120 + 90 * w + (leaky ? 260 * background : 0)),
    heapUsedMb: Math.round(58 + 9 * w + (leaky ? 3 * background : 0)),
    openAtStart: { contexts: background, pages: background },
    leftOpen: leaky ? 1 : 0,
    artifactBytes: { trace: Math.round((1.1 + 0.6 * w) * MB), screenshot: Math.round((60 + 40 * w) * 1024) },
  };
}

/** The open pages a worker counts at the end of each of its tests. */
export function demoOpenPages(testsInWorker, leaky) {
  return Array.from({ length: testsInWorker }, (_, i) => (leaky ? i + 2 : 1));
}

/** The CPU busy series of a run, in percent, one point per sample. */
function busySeries(points, leaky) {
  return Array.from({ length: points }, (_, i) => {
    const t = i / Math.max(1, points - 1);
    const base = leaky ? 52 + 44 * t : 58 + 6 * Math.sin(t * 9);
    return Math.round(Math.min(100, base + 5 * (wobble(i + 7) - 0.5)) * 10) / 10;
  });
}

/** How long before the first test the reporter's sampler starts, and how often the demo samples. */
const SAMPLER_LEAD_MS = 1500;
const CPU_STEP_MS = 1000;
const MEMORY_STEP_MS = 2500;

/**
 * The pages open in one worker over time, from its tests' spans: the shared
 * page from the first test's start to the last one's end, and each test's own
 * page during the test, which a leaky test never closes.
 */
function pagesOfWorker(spans, startedAt, leaky) {
  const changes = [];
  for (const [start, end] of spans) {
    changes.push([start + 40, 1]);
    if (!leaky) changes.push([Math.max(start + 41, end - 30), -1]);
  }
  const first = spans[0][0];
  const last = spans[spans.length - 1][1];
  changes.push([first + 20, 1]);
  changes.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const points = [];
  let open = 0;
  for (const [at, delta] of changes) {
    open += delta;
    points.push([Math.round(at - startedAt), open]);
  }
  points.push([Math.round(last + 200 - startedAt), 0]);
  return points;
}

/** A step series' level at `at`: the last point at or before it, zero before the first. */
function levelAt(points, at) {
  let level = 0;
  for (const [t, value] of points) {
    if (t > at) break;
    level = value;
  }
  return level;
}

/**
 * One worker's processes as the sampler reads them: the cores the worker and
 * its browser use, busy during a test and idle between two, more in a leaky
 * run for each page earlier tests left rendering; their memory, growing with
 * every page open in the worker. `pages` is the worker's open pages on the
 * same clock.
 */
function workerTree(worker, spans, origin, pages, leaky) {
  const from = spans[0][0] - origin;
  const to = spans[spans.length - 1][1] + 200 - origin;
  const inTest = (at) => spans.some(([start, end]) => start - origin <= at && at <= end - origin);
  const cpuCores = [];
  for (let at = from + CPU_STEP_MS, i = 0; at <= to; at += CPU_STEP_MS, i++) {
    const leftOpen = leaky ? Math.max(0, levelAt(pages, at) - 2) : 0;
    const busy = inTest(at) ? 0.55 + 0.2 * wobble(worker * 97 + i) + 0.08 * leftOpen : 0.06 + 0.04 * leftOpen;
    cpuCores.push([at, Math.round(busy * 100) / 100]);
  }
  const memoryBytes = [];
  for (let at = from, i = 0; at <= to; at += MEMORY_STEP_MS, i++) {
    const open = levelAt(pages, at);
    memoryBytes.push([at, Math.round((380 + 140 * open + 20 * wobble(worker * 31 + i)) * MB)]);
  }
  return { worker, cpuCores, memoryBytes };
}

/**
 * Where the leaky run's objects were opened and last used, for its findings and its timeline's spans: the login
 * fixture's context, and the preview popup of the spec in `previewFile`.
 */
function leakSites(fixtureFile, previewFile) {
  return {
    login: {
      where: `fixture "loggedInContext" at ${fixtureFile}:14`,
      site: `${fixtureFile}:14`,
      lastUse: `${fixtureFile}:18`,
    },
    preview: {
      where: `popup after locator.click at ${previewFile}:41`,
      site: `${previewFile}:41`,
      lastUse: `${previewFile}:43`,
    },
  };
}

/** How long the preview popup stays open after its last check, before its test ends. */
const PREVIEW_TAIL_MS = 1800;

/**
 * The test that keeps the preview popup open: the first test that passed past
 * the first of its worker (a failed test's objects are never judged), else
 * the first worker's second test. `cases` names each span's test when the
 * caller knows them.
 */
function previewHost(workers) {
  for (const w of workers) {
    const index = (w.cases ?? []).findIndex((c, i) => i > 0 && c && !c.failed);
    if (index > 0 && w.spans?.[index]) return { worker: w.worker, span: w.spans[index], test: w.cases[index] };
  }
  const first = workers[0];
  if (!first?.spans?.length) return null;
  return { worker: first.worker, span: first.spans[Math.min(1, first.spans.length - 1)], test: null };
}

/**
 * What a leaky run kept open for nothing, on the timeline's clock: each test's
 * login context from the test's end to its worker's end (a failed test's left
 * out, as the reporter leaves it), and the preview popup from its last use to
 * the end of its test.
 */
function leakySpans(workers, origin, sites, host) {
  const spans = [];
  for (const w of workers) {
    const workerEnd = w.spans[w.spans.length - 1][1] + 200 - origin;
    w.spans.forEach(([, end], i) => {
      const test = w.cases?.[i];
      if (test?.failed) return;
      spans.push({
        worker: w.worker,
        verdict: 'leaked',
        kind: 'context',
        ...sites.login,
        from: Math.round(end - origin),
        to: Math.round(workerEnd),
        untilWorkerEnd: true,
        scope: 'test',
        pages: 1,
        ...(test ? { test: { title: test.title, file: test.file } } : {}),
      });
    });
  }
  const tail = host ? Math.min(PREVIEW_TAIL_MS, Math.max(0, host.span[1] - host.span[0] - 200)) : 0;
  if (tail > 0) {
    spans.push({
      worker: host.worker,
      verdict: 'lingering',
      kind: 'page',
      ...sites.preview,
      from: Math.round(host.span[1] - 60 - tail - origin),
      to: Math.round(host.span[1] - 60 - origin),
      pages: 1,
      ...(host.test ? { test: { title: host.test.title, file: host.test.file } } : {}),
    });
  }
  return spans.sort((a, b) => a.from - b.from);
}

/**
 * The run's resources over the tests' span, sampled from a little before the
 * first one: the machine's CPU every second, the run's memory every two and a
 * half, peaking at `peakBytes` as far into the tests as `peakAtMs` is into
 * `wallMs`, each worker's open pages and processes, and in a leaky run what
 * it kept open for nothing. Null without the tests' spans.
 */
function demoTimeline({ wallMs, workers, leaky, peakBytes, peakAtMs, sites, host }) {
  if (workers.length === 0 || !workers.every((w) => Array.isArray(w.spans) && w.spans.length > 0)) return null;
  const firstTest = Math.min(...workers.map((w) => w.spans[0][0]));
  const lastTest = Math.max(...workers.map((w) => w.spans[w.spans.length - 1][1]));
  const origin = firstTest - SAMPLER_LEAD_MS;
  const span = lastTest + 1000 - origin;
  const cpuPct = [];
  for (let at = CPU_STEP_MS, i = 0; at <= span; at += CPU_STEP_MS, i++) {
    const t = at / span;
    const base = leaky ? 48 + 46 * t : 57 + 7 * Math.sin(t * 9);
    cpuPct.push([at, Math.round(Math.min(100, base + 8 * (wobble(i + 11) - 0.5)) * 10) / 10]);
  }
  const peakAt = SAMPLER_LEAD_MS + (lastTest - firstTest) * (wallMs > 0 ? peakAtMs / wallMs : 0.5);
  const memoryBytes = [];
  for (let at = 0, i = 0; at <= span; at += MEMORY_STEP_MS, i++) {
    // Leaky: memory climbs with the pages left open; clean: it rises and falls around one peak.
    const shape = leaky
      ? 0.25 + 0.75 * Math.min(1, at / peakAt) - (at > peakAt ? 0.05 : 0)
      : 0.55 + 0.45 * Math.exp(-(((at - peakAt) / (span * 0.3)) ** 2));
    memoryBytes.push([at, Math.round(peakBytes * shape * (0.97 + 0.02 * wobble(i + 3)))]);
  }
  // The peak as the profile states it, at the sample nearest its time.
  const nearest = memoryBytes.reduce(
    (best, point, i) => (Math.abs(point[0] - peakAt) < Math.abs(memoryBytes[best][0] - peakAt) ? i : best),
    0,
  );
  memoryBytes[nearest] = [memoryBytes[nearest][0], Math.round(peakBytes)];
  const pages = workers.map((w) => ({ worker: w.worker, points: pagesOfWorker(w.spans, origin, leaky) }));
  return {
    startedAt: origin,
    cpuPct,
    memoryBytes,
    pages,
    workers: workers.map((w, i) => workerTree(w.worker, w.spans, origin, pages[i].points, leaky)),
    ...(leaky ? { spans: leakySpans(workers, origin, sites, host) } : {}),
  };
}

/**
 * The findings of a leaky run. `fixtureFile` is where the suite's fixtures
 * live, `tests` how many tests used the leaking fixture.
 */
function leakyFindings({ fixtureFile, tests, wallMs, sites }) {
  return [
    {
      verdict: 'leaked',
      kind: 'context',
      ...sites.login,
      scope: 'test',
      tests,
      count: tests,
      heldMs: Math.round(wallMs * 0.82),
      untilWorkerEnd: true,
      pages: tests,
      afterTestCpuMs: Math.round(wallMs * 0.21),
    },
    {
      verdict: 'idle',
      kind: 'page',
      where: 'fixture "page"',
      tests: Math.max(1, Math.round(tests / 2)),
      count: Math.max(1, Math.round(tests / 2)),
      detail: 'set up with loggedInPage',
    },
    {
      verdict: 'piling',
      kind: 'page',
      where: `fixture "sharedPage" at ${fixtureFile}:31`,
      site: `${fixtureFile}:31`,
      tests: 3,
      count: 1,
      growth: { what: 'listeners', from: 2, to: 8, tests: 3 },
    },
    {
      verdict: 'lingering',
      kind: 'page',
      ...sites.preview,
      tests: 1,
      count: 1,
      heldMs: PREVIEW_TAIL_MS,
    },
  ];
}

/** The server `handleTest` leaves running in its worker, in a leaky run and in the runs before it. */
function handleFinding(handleTest) {
  return {
    verdict: 'handle',
    kind: 'handle',
    where: 'TCPServerWrap',
    tests: 1,
    count: 1,
    detail: `"${handleTest.title}" (${handleTest.file})`,
  };
}

/**
 * The run's report. `workers` lists each worker with how many tests it ran
 * and, for the report's timeline, `spans`: each test's `[start, end]` in epoch
 * ms, in order, with `cases` naming each one's `{ title, file, failed }` when
 * the caller knows them. `artifactBytes` is the sum of the executions'
 * artifacts. `handle` adds the server a test leaves running, which a leaky run
 * always has.
 */
export function demoResourceReport({
  leaky = false,
  handle = leaky,
  wallMs,
  workers,
  fixtureFile,
  handleTest,
  artifactBytes,
  shardIndex = null,
}) {
  const tests = workers.reduce((sum, w) => sum + w.tests, 0);
  const host = previewHost(workers);
  const sites = leakSites(fixtureFile, host?.test?.file ?? handleTest.file);
  // A failed test's objects are never judged: Playwright shuts its worker down.
  const judged = workers.reduce((sum, w) => sum + (w.cases ? w.cases.filter((c) => !c.failed).length : w.tests), 0);
  const findings = [
    ...(leaky ? leakyFindings({ fixtureFile, tests: judged, wallMs, sites }) : []),
    ...(handle ? [handleFinding(handleTest)] : []),
  ];
  const counts = { leaked: 0, lingering: 0, idle: 0, piling: 0, handle: 0, probable: 0 };
  for (const finding of findings) counts[finding.verdict] += finding.verdict === 'idle' ? finding.count : 1;
  const seconds = wallMs / 1000;
  const cores = 4;
  const peakBytes = leaky ? 9.6 * GB : 4.1 * GB;
  const peakAtMs = Math.round(wallMs * (leaky ? 0.94 : 0.41));
  return {
    v: 1,
    shardIndex,
    findings,
    counts,
    profile: {
      platform: 'linux',
      wallMs: Math.round(wallMs),
      machine: { cores, memoryBytes: 16 * GB, memoryLimitBytes: null, cpuQuotaCores: null },
      cpu: {
        busyPct: leaky ? 88 : 61,
        iowaitPct: 1.2,
        stealPct: 0,
        pressurePct: leaky ? 41 : 6,
        series: busySeries(Math.min(240, Math.max(12, Math.round(seconds))), leaky),
        byRole: {
          renderer: {
            cpuMs: Math.round(seconds * 1000 * (leaky ? 2.1 : 1.15)),
            runWaitMs: Math.round(seconds * 1000 * (leaky ? 0.62 : 0.04)),
            processes: leaky ? tests + workers.length : workers.length,
          },
          browser: {
            cpuMs: Math.round(seconds * 1000 * 0.22),
            runWaitMs: Math.round(seconds * 30),
            processes: workers.length,
          },
          worker: {
            cpuMs: Math.round(seconds * 1000 * 0.31),
            runWaitMs: Math.round(seconds * 20),
            processes: workers.length,
          },
          gpu: { cpuMs: Math.round(seconds * 1000 * 0.12), runWaitMs: null, processes: workers.length },
          webServer: { cpuMs: Math.round(seconds * 1000 * 0.18), runWaitMs: null, processes: 1 },
          runner: { cpuMs: Math.round(seconds * 1000 * 0.04), runWaitMs: null, processes: 1 },
        },
        throttledMs: null,
      },
      memory: {
        kind: 'pss',
        peakBytes,
        peakAtMs,
        largest: { role: 'renderer', bytes: leaky ? 620 * MB : 240 * MB },
        rssFallbacks: 0,
        pressurePct: leaky ? 2.4 : 0,
        lowestAvailableBytes: leaky ? 1.1 * GB : 9.8 * GB,
        containerPeakBytes: null,
        oomKills: 0,
      },
      disk: {
        peakInUseBytes: Math.round(artifactBytes * 1.4),
        peakInUseIsLowerBound: false,
        lowestFreeBytes: 18.2 * GB,
        leftoverBytes: leaky ? 640 * MB : 0,
      },
      notMeasured: [],
    },
    workers: workers.map((w) => ({ worker: w.worker, openPages: demoOpenPages(w.tests, leaky) })),
    artifactBytes: { trace: Math.round(artifactBytes * 0.94), screenshot: Math.round(artifactBytes * 0.06) },
    workerHealth: {
      tests,
      loopUtilization: leaky ? 0.41 : 0.21,
      loopDelayP99Ms: leaky ? 96 : 27,
      involuntarySwitchesPerTest: leaky ? 2400 : 180,
    },
    timeline: demoTimeline({ wallMs, workers, leaky, peakBytes, peakAtMs, sites, host }),
  };
}
