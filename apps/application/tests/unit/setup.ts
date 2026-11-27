import { vi } from 'vitest';

// The unit tests stub the global `fetch`, and the requests to an address set in Settings (a Jira site, an AI base
// URL) go through it here. The guard those requests pass in the server is tested on its own, in
// `connection-fetch.test.ts`, which imports the real module.
vi.mock('../../server/utils/connection-fetch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  connectionFetch: (input: string | URL, init?: RequestInit) => fetch(String(input), init),
}));
