import { expect, test } from '@playwright/test';

test('runs in the spare worker with the environment Playwright gives its workers', () => {
  console.log(`worker pid ${process.pid}`);
  expect(process.env.CLI_PROJECT_FROM_CONFIG).toBe('set by the config');
  expect(process.env.TEST_WORKER_INDEX).toBe('0');
  expect(process.cwd()).toBe(__dirname);
  expect(Object.keys(process.env).filter((key) => key.startsWith('PIWI_TURBO_SPARE'))).toEqual([]);
  process.env.CLI_PROJECT_PRODUCED = 'set by the setup project';
});
