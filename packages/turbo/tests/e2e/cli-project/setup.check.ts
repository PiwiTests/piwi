import { test } from '@playwright/test';

test('sets a variable for the projects that depend on this one', () => {
  process.env.CLI_PROJECT_PRODUCED = 'set by the setup project';
});
