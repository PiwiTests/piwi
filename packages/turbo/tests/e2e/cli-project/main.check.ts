import { expect, test } from '@playwright/test';

test('sees the environment Playwright gives its workers', () => {
  expect(process.env.CLI_PROJECT_FROM_CONFIG).toBe('set by the config');
  expect(process.env.CLI_PROJECT_PRODUCED).toBe('set by the setup project');
  expect(process.env.TEST_WORKER_INDEX).toBeDefined();
  expect(Object.keys(process.env).filter((key) => key.startsWith('PIWI_TURBO_SPARE'))).toEqual([]);
});
