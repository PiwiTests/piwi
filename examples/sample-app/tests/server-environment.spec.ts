import { backend, unsupported } from '../backends';
import { test, expect } from './fixtures';

// The integration describes the server process at /__piwi/environment: its runtime, time zone, locale and start time.
test('the server environment describes the backend process', async ({ request }) => {
  test.skip(!backend.features.serverEnvironment, unsupported('serverEnvironment'));
  const response = await request.get('/__piwi/environment');
  expect(response.ok()).toBe(true);
  const environment = (await response.json()) as { v: number; runtime: string | null; instance: string | null };
  expect(environment.v).toBe(1);
  expect(environment.runtime).toBeTruthy();
  expect(environment.instance).toBeTruthy();
});
