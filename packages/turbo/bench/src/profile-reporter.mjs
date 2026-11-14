// A Playwright reporter that splits test time by what it was spent on (navigation, actions, assertions,
// screenshots, API requests, browser start-up, fixtures and test code) and records every test's outcome.
//
// With SUITEBENCH_PROFILE set, it writes the profile there as JSON; without it, it prints the breakdown.
import { writeFileSync } from 'node:fs';

/** The category a step's own time counts toward. */
export function categorize(step) {
  const title = step.title ?? '';
  if (step.category === 'expect') {
    return /toHaveScreenshot|toMatchSnapshot|toMatchAriaSnapshot/.test(title) ? 'screenshots' : 'assertions';
  }
  if (step.category === 'pw:api') {
    if (/^(Launch browser|Create context|Create page|Close context|Close browser|Close page)\b/.test(title)) return 'browser & context';
    if (/^(Navigate|Reload|Go back|Go forward|Wait for (navigation|load|URL|event "load"))/i.test(title)) return 'navigation';
    if (/^(Screenshot|Take screenshot)/i.test(title)) return 'screenshots';
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|FETCH)\b/.test(title)) return 'API requests';
    if (/^(Wait for timeout)/i.test(title)) return 'fixed waits';
    return 'actions';
  }
  if (step.category === 'fixture' || step.category === 'hook') return 'fixtures & hooks';
  return 'test code';
}

/** Adds each step's own time (its duration minus its children's) to `totals`. */
export function accumulate(steps, totals) {
  let covered = 0;
  for (const step of steps) {
    const duration = Math.max(0, step.duration);
    covered += duration;
    const children = accumulate(step.steps ?? [], totals);
    const own = Math.max(0, duration - children);
    const category = categorize(step);
    totals[category] = (totals[category] ?? 0) + own;
  }
  return covered;
}

export default class SuitebenchProfileReporter {
  constructor(options = {}) {
    this.output = options.outputFile ?? process.env.SUITEBENCH_PROFILE;
    this.tests = new Map();
    this.categories = {};
    this.startedAt = 0;
  }

  printsToStdio() {
    return !this.output;
  }

  onBegin(config) {
    this.startedAt = Date.now();
    this.workers = config.workers;
  }

  onTestEnd(test, result) {
    const key = test.id;
    const entry = this.tests.get(key) ?? {
      title: test.titlePath().slice(1).join(' › '),
      file: test.location.file,
      attempts: [],
    };
    entry.attempts.push({ status: result.status, duration: result.duration, retry: result.retry });
    entry.outcome = test.outcome();
    this.tests.set(key, entry);
    const covered = accumulate(result.steps, this.categories);
    if (result.duration > covered) {
      this.categories['test code'] = (this.categories['test code'] ?? 0) + (result.duration - covered);
    }
  }

  onEnd(result) {
    const tests = [...this.tests.values()];
    const counts = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    for (const test of tests) counts[test.outcome] = (counts[test.outcome] ?? 0) + 1;
    const profile = {
      status: result.status,
      wallMs: Date.now() - this.startedAt,
      workers: this.workers,
      testTimeMs: tests.reduce((sum, test) => sum + test.attempts.reduce((total, attempt) => total + attempt.duration, 0), 0),
      retries: tests.reduce((sum, test) => sum + test.attempts.length - 1, 0),
      counts,
      categories: this.categories,
      tests,
    };
    if (this.output) {
      writeFileSync(this.output, JSON.stringify(profile));
      return;
    }
    console.log(formatProfile(profile));
  }
}

/** The breakdown as a text table, largest share first. */
export function formatProfile(profile) {
  const total = Object.values(profile.categories).reduce((sum, value) => sum + value, 0) || 1;
  const lines = Object.entries(profile.categories)
    .toSorted((a, b) => b[1] - a[1])
    .map(([name, ms]) => `  ${name.padEnd(18)} ${(ms / 1000).toFixed(1).padStart(7)}s  ${((ms / total) * 100).toFixed(0).padStart(3)}%`);
  const slowest = profile.tests
    .map((test) => ({ title: test.title, ms: test.attempts.reduce((sum, attempt) => sum + attempt.duration, 0) }))
    .toSorted((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map((test) => `  ${(test.ms / 1000).toFixed(1).padStart(6)}s  ${test.title}`);
  return [
    `Test time by category (${(total / 1000).toFixed(1)}s across ${profile.workers} workers, ${(profile.wallMs / 1000).toFixed(1)}s wall):`,
    ...lines,
    '',
    'Slowest tests:',
    ...slowest,
    '',
    `${profile.counts.expected} passed, ${profile.counts.unexpected} failed, ${profile.counts.flaky} flaky, ${profile.counts.skipped} skipped, ${profile.retries} retries`,
  ].join('\n');
}
