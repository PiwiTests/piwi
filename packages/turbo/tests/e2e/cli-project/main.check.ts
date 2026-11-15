import { expect, test } from '@playwright/test';

test('receives the variables the setup project set', () => {
  expect(process.env.CLI_PROJECT_PRODUCED).toBe('set by the setup project');
});
