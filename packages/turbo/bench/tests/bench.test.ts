import { expect, test } from 'vitest';
import { compareRounds, median, relativeSpread, verdict } from '../src/stats.mjs';
import { schedule } from '../src/run.mjs';
import { accumulate, categorize } from '../src/profile-reporter.mjs';
import { summarize, formatMarkdown } from '../src/report.mjs';

test('median of odd and even samples', () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(Number.isNaN(median([]))).toBe(true);
});

test('relative spread is the MAD over the median', () => {
  expect(relativeSpread([10, 10, 10])).toBe(0);
  expect(relativeSpread([9, 10, 11])).toBe(0.1);
});

test('a consistent 20% drop reads as lower', () => {
  const pairs = [10, 11, 9.5, 10.5, 10.2].map((base) => [base, base * 0.8]);
  const result = compareRounds(pairs);
  expect(Math.abs(result.ratio - 0.8) < 1e-9).toBe(true);
  expect(result.better).toBe(5);
  expect(verdict(result)).toBe('lower');
});

test('changes that go both ways read as no clear difference', () => {
  const pairs = [
    [10, 9],
    [10, 11],
    [10, 9.6],
    [10, 10.5],
    [10, 10.1],
  ];
  expect(verdict(compareRounds(pairs))).toBe('no clear difference');
});

test('a tiny but consistent change stays below the minimum effect', () => {
  const pairs = [10, 11, 12, 13, 14].map((base) => [base, base * 0.99]);
  expect(verdict(compareRounds(pairs))).toBe('no clear difference');
  expect(verdict(compareRounds(pairs), 0.005)).toBe('lower');
});

test('two rounds are too few to call', () => {
  expect(
    verdict(
      compareRounds([
        [10, 5],
        [10, 5],
      ]),
    ),
  ).toBe('too few rounds');
});

test('the schedule rotates and alternates, so each variant takes each position', () => {
  const rounds = schedule(3, 6);
  expect(rounds[0]).toEqual([0, 1, 2]);
  expect(rounds[1]).toEqual([2, 1, 0].map((i) => [1, 2, 0][i]));
  for (const variant of [0, 1, 2]) {
    const positions = new Set(rounds.map((order) => order.indexOf(variant)));
    expect(positions.size).toBe(3);
  }
});

test('steps are categorized by what they spend time on', () => {
  expect(categorize({ category: 'pw:api', title: 'Navigate' })).toBe('navigation');
  expect(categorize({ category: 'pw:api', title: 'Click' })).toBe('actions');
  expect(categorize({ category: 'pw:api', title: 'POST' })).toBe('API requests');
  expect(categorize({ category: 'pw:api', title: 'Launch browser' })).toBe('browser & context');
  expect(categorize({ category: 'pw:api', title: 'Screenshot' })).toBe('screenshots');
  expect(categorize({ category: 'expect', title: 'Expect "toHaveScreenshot(dashboard.png)"' })).toBe('screenshots');
  expect(categorize({ category: 'expect', title: 'Expect "toBeVisible"' })).toBe('assertions');
  expect(categorize({ category: 'fixture', title: 'Fixture "page"' })).toBe('fixtures & hooks');
  expect(categorize({ category: 'test.step', title: 'Fill the form' })).toBe('test code');
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
  expect(covered).toBe(1050);
  expect(totals).toEqual({ 'fixtures & hooks': 100, navigation: 700, assertions: 200, actions: 50 });
});

test('the report pairs each variant with the baseline round by round', () => {
  const runs = [];
  for (let round = 0; round < 4; round++) {
    const drift = 1 + round * 0.1;
    runs.push({
      variant: 'stock',
      round,
      warmup: false,
      exitCode: 0,
      wallMs: 10000 * drift,
      cpuMs: 5000,
      counts: { unexpected: 0, flaky: 0 },
      retries: 0,
      categories: { navigation: 6000 },
      testTimeMs: 9000,
    });
    runs.push({
      variant: 'fast',
      round,
      warmup: false,
      exitCode: 0,
      wallMs: 7000 * drift,
      cpuMs: 5000,
      counts: { unexpected: 0, flaky: 0 },
      retries: 0,
      categories: { navigation: 3000 },
      testTimeMs: 6000,
    });
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
  expect(stock.metrics.wallMs.comparison).toBe(undefined);
  expect(Math.abs(fast.metrics.wallMs.comparison.ratio - 0.7) < 1e-9).toBe(true);
  expect(fast.metrics.wallMs.verdict).toBe('lower');
  expect(fast.metrics.cpuMs.verdict).toBe('no clear difference');
  const markdown = formatMarkdown(results);
  expect(markdown).toMatch(/\| fast \| 8\.\d+ s \| .* \| −30% \|/);
  expect(markdown).toMatch(/\| navigation \| 6\.0 \| 3\.0 \|/);
});
