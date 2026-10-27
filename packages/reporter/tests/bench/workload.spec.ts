import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { extendPiwiFixtures } from '../../dist/index.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

/**
 * One workload, run under several capture configurations by `run.mjs`. The
 * spec never decides what is measured — it only reads its shape from the
 * environment, so every variant executes byte-identical test bodies against an
 * identical page and the difference between runs is capture overhead alone.
 *
 * `PIWI_BENCH_FIXTURES=off` runs the plain Playwright `test`, with no Piwi
 * fixtures registered at all — the reference every other variant is measured
 * against. Each test notes its body's own time (`bench-body-ms`), so `run.mjs`
 * can tell the test's calls apart from the fixtures' setup and teardown.
 * Requires `npm run reporter:build`; the built package is what users install,
 * so that is what gets benchmarked.
 */
const withFixtures = process.env.PIWI_BENCH_FIXTURES !== 'off';
const test = withFixtures ? extendPiwiFixtures(base) : base;

const readInt = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const ROWS = readInt('PIWI_BENCH_ROWS', 200);
const TESTS = readInt('PIWI_BENCH_TESTS', 12);
const ACTIONS = readInt('PIWI_BENCH_ACTIONS', 10);
const ASSERTIONS = readInt('PIWI_BENCH_ASSERTIONS', 10);

/**
 * What the workload targets — the knob that isolates the ARIA snapshot from
 * the rest of locator capture. A capture takes an extra `ariaSnapshot()` round
 * trip only when the element resolves an ARIA role or is a form field, so
 * `role` (the row buttons) pays it and `roleless` (the row's plain `<span>`)
 * does not. Running both and subtracting attributes the cost.
 */
const TARGET = process.env.PIWI_BENCH_TARGET === 'roleless' ? 'roleless' : 'role';

// `exact` on both — the default substring match would let "order 1" also
// resolve "order 10" and friends, i.e. a strict-mode violation.
const targetFor = (page: Page, row: number): Locator =>
  TARGET === 'roleless'
    ? page.getByText(`Order ${row}`, { exact: true })
    : page.getByRole('button', { name: `Open order ${row}`, exact: true });

/**
 * How the workload spreads its operations over source lines. The fixtures probe
 * a target once per *call site* per test, so the two shapes bound the real
 * range a suite can sit in and neither one alone is a fair summary:
 *
 *  - `distinct` — every operation on its own line, as a test that spells each
 *    step out. Nothing is deduped, so this is the worst case for capture cost.
 *  - `shared` — every operation through one line, as a loop or a page-object
 *    method called repeatedly. One call site, so the dedupe does its most work.
 */
const SITES = process.env.PIWI_BENCH_SITES === 'shared' ? 'shared' : 'distinct';
const site = (i: number, count: number): number => (SITES === 'shared' ? 0 : i % count);

/** Action call sites, one per line — see `SITES`. */
const clickTarget: Array<(target: Locator) => Promise<void>> = [
  async (target) => await target.click(),
  async (target) => await target.click(),
  async (target) => await target.click(),
  async (target) => await target.click(),
  async (target) => await target.click(),
  async (target) => await target.click(),
  async (target) => await target.click(),
  async (target) => await target.click(),
  async (target) => await target.click(),
  async (target) => await target.click(),
];

/** Assertion call sites, one per line — see `SITES`. */
const assertVisible: Array<(target: Locator) => Promise<void>> = [
  async (target) => await expect(target).toBeVisible(),
  async (target) => await expect(target).toBeVisible(),
  async (target) => await expect(target).toBeVisible(),
  async (target) => await expect(target).toBeVisible(),
  async (target) => await expect(target).toBeVisible(),
  async (target) => await expect(target).toBeVisible(),
  async (target) => await expect(target).toBeVisible(),
  async (target) => await expect(target).toBeVisible(),
  async (target) => await expect(target).toBeVisible(),
  async (target) => await expect(target).toBeVisible(),
];

let server: FixtureServer;

test.beforeAll(async () => {
  server = await startFixtureServer(ROWS);
});

test.afterAll(async () => {
  await server.close();
});

/**
 * A mixed workload: a navigation, form fills, clicks that each trigger a fetch,
 * and web-first assertions. Actions and assertions are separate capture paths
 * in the fixtures, so both are exercised, and every target is a different row
 * so no probe is served from a warm selector cache. The two form fills sit on
 * their own lines under either `SITES` shape — a page's fixed entry steps do.
 */
for (let index = 0; index < TESTS; index++) {
  test(`workload ${index}`, async ({ page }) => {
    const bodyStarted = performance.now();
    await page.goto(server.url);

    await page.getByLabel('Email').fill('bench@example.com');
    await page.getByLabel('Search').fill(`order ${index}`);

    for (let i = 0; i < ACTIONS; i++) {
      await clickTarget[site(i, clickTarget.length)]!(targetFor(page, (index * ACTIONS + i) % ROWS));
    }

    for (let i = 0; i < ASSERTIONS; i++) {
      await assertVisible[site(i, assertVisible.length)]!(targetFor(page, (index * ASSERTIONS + i) % ROWS));
    }

    await expect(page.getByRole('status')).toContainText('opened');
    test.info().annotations.push({ type: 'bench-body-ms', description: String(performance.now() - bodyStarted) });
  });
}
