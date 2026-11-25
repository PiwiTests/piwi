import { expect, test } from 'vitest';
import { computeMetadataDiff, getBrowserList } from '#shared/utils/run-metadata';

const projects = [
  { name: 'setup', use: { browserName: 'chromium' } },
  { name: 'chromium', use: { browserName: 'chromium' } },
  { name: 'firefox', use: { browserName: 'firefox' } },
  { name: 'webkit', use: { browserName: 'webkit' } },
];
const run = (ranProjects?: unknown) => ({
  htmlReport: { projects, ...(ranProjects !== undefined && { ranProjects }) },
});

test('the Browsers row lists the browsers of the projects the run ran, which --project narrows', () => {
  expect(getBrowserList(run(['setup', 'firefox']))).toBe('chromium, firefox');
  expect(getBrowserList(run(['webkit']))).toBe('webkit');
});

test('a run whose reporter names no projects it ran lists every project its config lists', () => {
  for (const ranProjects of [undefined, [], 'firefox', [1, null]]) {
    expect(getBrowserList(run(ranProjects))).toBe('chromium, firefox, webkit');
  }
  expect(getBrowserList({ htmlReport: { projects: [] } })).toBe('');
  expect(getBrowserList(null)).toBe('');
});

test('two runs of one config that ran other projects differ in browsers', () => {
  const browsers = (prev: object, curr: object) =>
    computeMetadataDiff(prev, curr, null, null).find((d) => d.key === 'browsers');
  expect(browsers(run(['firefox']), run(['webkit']))).toMatchObject({ before: 'firefox', after: 'webkit' });
  expect(browsers(run(['setup', 'chromium', 'firefox', 'webkit']), run())).toBeUndefined();
});
