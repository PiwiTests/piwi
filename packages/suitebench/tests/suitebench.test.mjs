import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareRounds, median, relativeSpread, verdict } from '../src/stats.mjs';
import { schedule } from '../src/run.mjs';
import { accumulate, categorize } from '../src/profile-reporter.mjs';
import { summarize, formatMarkdown } from '../src/report.mjs';

test('median of odd and even samples', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('relative spread is the MAD over the median', () => {
  assert.equal(relativeSpread([10, 10, 10]), 0);
  assert.equal(relativeSpread([9, 10, 11]), 0.1);
});

test('a consistent 20% drop reads as lower', () => {
  const pairs = [10, 11, 9.5, 10.5, 10.2].map((base) => [base, base * 0.8]);
  const result = compareRounds(pairs);
  assert.ok(Math.abs(result.ratio - 0.8) < 1e-9);
  assert.equal(result.better, 5);
  assert.equal(verdict(result), 'lower');
});

test('changes that go both ways read as no clear difference', () => {
  const pairs = [[10, 9], [10, 11], [10, 9.6], [10, 10.5], [10, 10.1]];
  assert.equal(verdict(compareRounds(pairs)), 'no clear difference');
});

test('a tiny but consistent change stays below the minimum effect', () => {
  const pairs = [10, 11, 12, 13, 14].map((base) => [base, base * 0.99]);
  assert.equal(verdict(compareRounds(pairs)), 'no clear difference');
  assert.equal(verdict(compareRounds(pairs), 0.005), 'lower');
});

test('two rounds are too few to call', () => {
  assert.equal(verdict(compareRounds([[10, 5], [10, 5]])), 'too few rounds');
});

test('the schedule rotates and alternates, so each variant takes each position', () => {
  const rounds = schedule(3, 6);
  assert.deepEqual(rounds[0], [0, 1, 2]);
  assert.deepEqual(rounds[1], [2, 1, 0].map((i) => [1, 2, 0][i]));
  for (const variant of [0, 1, 2]) {
    const positions = new Set(rounds.map((order) => order.indexOf(variant)));
    assert.equal(positions.size, 3);
  }
});

test('steps are categorized by what they spend time on', () => {
  assert.equal(categorize({ category: 'pw:api', title: 'Navigate' }), 'navigation');
  assert.equal(categorize({ category: 'pw:api', title: 'Click' }), 'actions');
  assert.equal(categorize({ category: 'pw:api', title: 'POST' }), 'API requests');
  assert.equal(categorize({ category: 'pw:api', title: 'Launch browser' }), 'browser & context');
  assert.equal(categorize({ category: 'pw:api', title: 'Screenshot' }), 'screenshots');
  assert.equal(categorize({ category: 'expect', title: 'Expect "toHaveScreenshot(dashboard.png)"' }), 'screenshots');
  assert.equal(categorize({ category: 'expect', title: 'Expect "toBeVisible"' }), 'assertions');
  assert.equal(categorize({ category: 'fixture', title: 'Fixture "page"' }), 'fixtures & hooks');
  assert.equal(categorize({ category: 'test.step', title: 'Fill the form' }), 'test code');
});

test("a step's own time excludes its children", () => {
  const totals = {};
  const covered = accumulate(
    [
      {
        category: 'hook',
        title: 'beforeEach hook',
        duration: 1000,
        steps: [
          { category: 'pw:api', title: 'Navigate', duration: 700, steps: [] },
          { category: 'expect', title: 'Expect "toBeVisible"', duration: 200, steps: [] },
        ],
      },
      { category: 'pw:api', title: 'Click', duration: 50, steps: [] },
    ],
    totals,
  );
  assert.equal(covered, 1050);
  assert.deepEqual(totals, { 'fixtures & hooks': 100, navigation: 700, assertions: 200, actions: 50 });
});

test('the report pairs each variant with the baseline round by round', () => {
  const runs = [];
  for (let round = 0; round < 4; round++) {
    const drift = 1 + round * 0.1;
    runs.push({ variant: 'stock', round, warmup: false, exitCode: 0, wallMs: 10000 * drift, cpuMs: 5000, counts: { unexpected: 0, flaky: 0 }, retries: 0, categories: { navigation: 6000 }, testTimeMs: 9000 });
    runs.push({ variant: 'fast', round, warmup: false, exitCode: 0, wallMs: 7000 * drift, cpuMs: 5000, counts: { unexpected: 0, flaky: 0 }, retries: 0, categories: { navigation: 3000 }, testTimeMs: 6000 });
  }
  runs.push({ variant: 'fast', round: -1, warmup: true, exitCode: 0, wallMs: 1 });
  const results = {
    machine: { platform: 'linux', arch: 'x64', cpus: 4, node: 'v22' },
    memoryMetric: 'PSS',
    config: { warmup: 1 },
    variants: [{ name: 'stock' }, { name: 'fast', description: 'Faster' }],
    runs,
  };
  const [stock, fast] = summarize(results);
  assert.equal(stock.metrics.wallMs.comparison, undefined);
  assert.ok(Math.abs(fast.metrics.wallMs.comparison.ratio - 0.7) < 1e-9);
  assert.equal(fast.metrics.wallMs.verdict, 'lower');
  assert.equal(fast.metrics.cpuMs.verdict, 'no clear difference');
  const markdown = formatMarkdown(results);
  assert.match(markdown, /\| fast \| 8\.\d+ s \| .* \| −30% \|/);
  assert.match(markdown, /\| navigation \| 6\.0 \| 3\.0 \|/);
});
