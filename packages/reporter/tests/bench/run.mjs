#!/usr/bin/env node
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Capture-overhead benchmark runner.
 *
 * Runs `workload.spec.ts` — one identical Playwright workload — under a ladder
 * of capture configurations and reports the wall-clock difference between them.
 * Each rung adds one layer, so the gap between two neighbors is the cost of
 * that layer alone:
 *
 *   baseline      plain @playwright/test, no Piwi fixtures registered
 *   fixtures      + console/network listeners, web vitals, the teardown flush
 *   page-state    + the end-of-test page/storage/cookie read
 *   full          + locator healing capture
 *   resources     + the resource ledger and the per-test worker reads (the shipped default)
 *   code-reach    + Chromium JavaScript coverage for code reach (opt-in)
 *
 * Every variant runs once per round, in the same order, and the rounds are
 * repeated: a machine that drifts (thermal throttling, a noisy neighbor)
 * then drifts across all variants rather than penalizing whichever ran last.
 * The first round is a warm-up and is discarded.
 *
 * `--target roleless` points the workload at elements that resolve no ARIA role,
 * which skips the extra `ariaSnapshot()` round trip each capture otherwise
 * takes — the difference between the two targets is what that snapshot costs.
 *
 * `--remote <ms>` runs every variant against a browser server
 * (`launchServer`) reached through `connectOptions`, behind a WebSocket proxy
 * that adds `<ms>` to each round trip (`latency-proxy.mjs`): a remote browser
 * on a grid at that distance. `--remote 0` is the proxy with no added delay.
 * The proxy also counts the protocol messages the client sends per test.
 *
 * Usage:
 *   npm run reporter:bench
 *   node tests/bench/run.mjs --only baseline,resources --remote 10
 *   node tests/bench/run.mjs --rounds 5 --rows 800 --actions 20
 *   node tests/bench/run.mjs --only baseline,full --target roleless
 *   node tests/bench/run.mjs --json bench-results.json
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '../..');
const CONFIG = path.relative(PACKAGE_ROOT, path.join(HERE, 'playwright.config.ts'));

const VARIANTS = [
  {
    key: 'baseline',
    label: 'baseline (no fixtures)',
    env: { PIWI_BENCH_FIXTURES: 'off' },
  },
  {
    key: 'fixtures',
    label: '+ fixtures, no locator capture',
    env: {
      PIWI_BENCH_FIXTURES: 'on',
      PIWI_CAPTURE_LOCATORS: 'false',
      PIWI_CAPTURE_PAGE_STATE: 'false',
      PIWI_CAPTURE_RESOURCES: 'false',
    },
  },
  {
    key: 'page-state',
    label: '+ page state',
    env: {
      PIWI_BENCH_FIXTURES: 'on',
      PIWI_CAPTURE_LOCATORS: 'false',
      PIWI_CAPTURE_PAGE_STATE: 'true',
      PIWI_CAPTURE_RESOURCES: 'false',
    },
  },
  {
    key: 'full',
    label: '+ locator healing',
    env: {
      PIWI_BENCH_FIXTURES: 'on',
      PIWI_CAPTURE_LOCATORS: 'true',
      PIWI_CAPTURE_PAGE_STATE: 'true',
      PIWI_CAPTURE_RESOURCES: 'false',
    },
  },
  {
    key: 'resources',
    label: '+ resource ledger (default)',
    env: { PIWI_BENCH_FIXTURES: 'on', PIWI_CAPTURE_LOCATORS: 'true', PIWI_CAPTURE_PAGE_STATE: 'true' },
  },
  {
    key: 'code-reach',
    label: '+ code reach (opt-in)',
    env: {
      PIWI_BENCH_FIXTURES: 'on',
      PIWI_CAPTURE_LOCATORS: 'true',
      PIWI_CAPTURE_PAGE_STATE: 'true',
      PIWI_CAPTURE_CODE_REACH: 'true',
    },
  },
];

function parseArgs(argv) {
  const options = {
    rounds: 3,
    rows: 200,
    tests: 12,
    actions: 10,
    assertions: 10,
    json: null,
    only: null,
    target: 'role',
    sites: 'distinct',
    remote: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (flag === undefined || value === undefined) continue;
    if (flag === 'json' || flag === 'only' || flag === 'target' || flag === 'sites') options[flag] = value;
    else if (flag === 'remote') {
      options.remote = Number(value);
      if (!Number.isInteger(options.remote / 2) || options.remote < 0) {
        throw new Error('--remote takes an even whole number of milliseconds: half of it is added each way');
      }
    } else if (flag in options) options[flag] = Number.parseInt(value, 10);
    else throw new Error(`unknown flag --${flag}`);
  }
  return options;
}

/** Per-test durations, flattened out of the JSON reporter's nested suites. */
function collectDurations(report) {
  const durations = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (result.status === 'passed') durations.push(result.duration);
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return durations;
}

/** The test bodies' own time, from the `bench-body-ms` annotation the workload writes. */
function collectBodyDurations(report) {
  const durations = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          const note = (result.annotations ?? []).find((a) => a.type === 'bench-body-ms');
          if (result.status === 'passed' && note) durations.push(Number(note.description));
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return durations;
}

/** Run Playwright without blocking this process, which serves the latency proxy. */
function runPlaywright(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['playwright', 'test', `--config=${CONFIG}`], {
      cwd: PACKAGE_ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
      env,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`playwright test exited with ${code ?? signal}`)),
    );
  });
}

async function runVariant(variant, options, outputFile, remote) {
  fs.rmSync(outputFile, { force: true });
  remote?.proxy.reset();
  const started = process.hrtime.bigint();
  await runPlaywright({
    ...process.env,
    ...variant.env,
    PIWI_BENCH_ROWS: String(options.rows),
    PIWI_BENCH_TESTS: String(options.tests),
    PIWI_BENCH_ACTIONS: String(options.actions),
    PIWI_BENCH_ASSERTIONS: String(options.assertions),
    PIWI_BENCH_TARGET: options.target,
    PIWI_BENCH_SITES: options.sites,
    PLAYWRIGHT_JSON_OUTPUT_NAME: outputFile,
    // The reporter package itself is never loaded here — only the capture
    // fixtures are — but keep any ambient dashboard config from making the
    // benchmark talk to a server.
    PIWI_DASHBOARD_URL: '',
    ...(remote ? { PW_TEST_CONNECT_WS_ENDPOINT: remote.proxy.wsEndpoint } : {}),
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const report = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
  const durations = collectDurations(report);
  if (durations.length === 0) throw new Error(`variant "${variant.key}" produced no passing tests`);
  const traffic = remote?.proxy.stats() ?? null;
  return { durations, bodyDurations: collectBodyDurations(report), wallMs, traffic };
}

/** A browser server and the delaying proxy in front of it, shared by every variant. */
async function startRemote(delayRoundTripMs) {
  const { startLatencyProxy } = await import('./latency-proxy.mjs');
  const require = createRequire(path.join(PACKAGE_ROOT, 'package.json'));
  const { chromium } = require('@playwright/test');
  const executablePath = process.env.PIWI_BENCH_CHROMIUM;
  const server = await chromium.launchServer({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const proxy = await startLatencyProxy(server.wsEndpoint(), delayRoundTripMs / 2).catch(async (error) => {
    await server.close();
    throw error;
  });
  return {
    proxy,
    async close() {
      await proxy.close();
      await server.close();
    },
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const fmt = (ms) => `${ms.toFixed(0)} ms`;
const pad = (text, width) => String(text).padEnd(width);
const padStart = (text, width) => String(text).padStart(width);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const variants = options.only ? VARIANTS.filter((v) => options.only.split(',').includes(v.key)) : VARIANTS;
  if (variants.length === 0) throw new Error(`--only matched no variant`);

  if (!fs.existsSync(path.join(PACKAGE_ROOT, 'dist/index.js'))) {
    throw new Error('dist/ is missing — run `npm run reporter:build` first');
  }
  // Same pinned-binary fallback as the integration project.
  if (!process.env.PIWI_BENCH_CHROMIUM && fs.existsSync('/opt/pw-browsers/chromium')) {
    process.env.PIWI_BENCH_CHROMIUM = '/opt/pw-browsers/chromium';
  }

  const outputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-bench-')), 'report.json');
  const perTest = options.actions + options.assertions;
  const rounds = options.rounds + 1;

  console.log(
    `\nPiwi capture benchmark — ${options.tests} tests × ` +
      `(${options.actions} actions + ${options.assertions} assertions) on a ${options.rows}-row page, ` +
      `targeting ${options.target === 'roleless' ? 'role-less spans' : 'buttons'}, ` +
      `${options.sites} call sites`,
  );
  if (options.remote !== null) {
    console.log(`Remote browser: a browser server behind a proxy adding ${options.remote} ms to each round trip`);
  }
  console.log(`${options.rounds} measured round(s) + 1 warm-up, ${variants.length} variants per round\n`);

  const samples = new Map(
    variants.map((v) => [v.key, { durations: [], bodyDurations: [], wallMs: [], messages: [], byMethod: {} }]),
  );
  const remote = options.remote !== null ? await startRemote(options.remote) : null;

  try {
    for (let round = 0; round < rounds; round++) {
      const warmup = round === 0;
      for (const variant of variants) {
        process.stdout.write(`  round ${round}/${rounds - 1}${warmup ? ' (warm-up)' : ''} — ${pad(variant.key, 12)}`);
        const { durations, bodyDurations, wallMs, traffic } = await runVariant(variant, options, outputFile, remote);
        process.stdout.write(` median ${fmt(median(durations))}, wall ${fmt(wallMs)}\n`);
        if (warmup) continue;
        const bucket = samples.get(variant.key);
        bucket.durations.push(...durations);
        bucket.bodyDurations.push(...bodyDurations);
        bucket.wallMs.push(wallMs);
        if (traffic) {
          bucket.messages.push(traffic.messages / durations.length);
          for (const [method, count] of Object.entries(traffic.byMethod)) {
            bucket.byMethod[method] = (bucket.byMethod[method] ?? 0) + count / durations.length;
          }
        }
      }
    }
  } finally {
    await remote?.close();
  }

  const rows = variants.map((variant) => {
    const { durations, bodyDurations, wallMs, messages, byMethod } = samples.get(variant.key);
    const measuredRounds = Math.max(1, messages.length);
    return {
      key: variant.key,
      label: variant.label,
      samples: durations.length,
      medianMs: median(durations),
      meanMs: mean(durations),
      p95Ms: percentile(durations, 0.95),
      wallMs: median(wallMs),
      bodyMs: bodyDurations.length > 0 ? median(bodyDurations) : null,
      messagesPerTest: messages.length > 0 ? mean(messages) : null,
      byMethodPerTest: Object.fromEntries(
        Object.entries(byMethod)
          .map(([method, total]) => [method, total / measuredRounds])
          .sort((a, b) => b[1] - a[1]),
      ),
    };
  });

  const base = rows[0];
  console.log(
    `\n  ${pad('variant', 32)}${padStart('median/test', 13)}${padStart('p95', 11)}` +
      `${padStart('vs baseline', 20)}${padStart('per op', 12)}${padStart('wall', 12)}`,
  );
  console.log(`  ${'-'.repeat(100)}`);
  for (const row of rows) {
    const delta = row.medianMs - base.medianMs;
    const pct = base.medianMs > 0 ? (delta / base.medianMs) * 100 : 0;
    const vsBase = row.key === base.key ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(0)} ms (${pct.toFixed(1)}%)`;
    const perOp = row.key === base.key ? '—' : `${(delta / perTest).toFixed(2)} ms`;
    console.log(
      `  ${pad(row.label, 32)}${padStart(fmt(row.medianMs), 13)}${padStart(fmt(row.p95Ms), 11)}` +
        `${padStart(vsBase, 20)}${padStart(perOp, 12)}${padStart(fmt(row.wallMs), 12)}`,
    );
  }

  console.log(`\n  Layer cost (each row is the delta over the row above):`);
  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].medianMs - rows[i - 1].medianMs;
    console.log(`    ${pad(rows[i].label, 32)}${padStart(`${delta >= 0 ? '+' : ''}${delta.toFixed(1)} ms/test`, 16)}`);
  }

  console.log(`\n  Where a test's time goes (median): its body, and the fixtures' setup and teardown around it:`);
  for (const row of rows) {
    if (row.bodyMs === null) continue;
    console.log(
      `    ${pad(row.label, 32)}${padStart(`body ${fmt(row.bodyMs)}`, 14)}` +
        `${padStart(`around it ${fmt(row.medianMs - row.bodyMs)}`, 20)}`,
    );
  }

  if (remote) {
    console.log(`\n  Protocol messages the client sent per test (mean), and the most frequent:`);
    for (const row of rows) {
      const top = Object.entries(row.byMethodPerTest)
        .slice(0, 6)
        .map(([method, n]) => `${method} ${n.toFixed(1)}`)
        .join(', ');
      const messages = row.messagesPerTest === null ? '—' : row.messagesPerTest.toFixed(1);
      console.log(`    ${pad(row.label, 32)}${padStart(messages, 8)}   ${top}`);
    }
  }
  console.log('');

  if (options.json) {
    fs.writeFileSync(options.json, JSON.stringify({ options, rows }, null, 2));
    console.log(`  results written to ${options.json}\n`);
  }
}

await main();
