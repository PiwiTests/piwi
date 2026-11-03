# Functional Tests

This directory contains functional tests for the Piwi Dashboard using Playwright Test.

## Running Tests

### All Tests

```bash
npm test
```

### Specific Test File

```bash
npx playwright test api-server.spec.ts
```

### With UI Mode

```bash
npm run app:test:ui
```

### View Test Report

```bash
npm run app:test:report
```

### Against the running desktop app

Run the whole suite against the locally installed Piwi **desktop app** instead of
a Playwright-managed server:

```bash
# 1. Launch the Piwi desktop app and leave it running.
# 2. From apps/application/:
npm run app:test:desktop
```

`PIWI_DESKTOP_E2E=1` (what the script sets) makes the suite adopt the desktop
app's loopback URL and access token from `~/.piwi/desktop.json` — the
same discovery file the reporter reads — points `baseURL`, the reporter stream
and the setup/teardown cleanup at it, injects the token on every request, and
starts no server of its own. Override the discovery path with
`PIWI_DESKTOP_CONFIG`; see [`desktop-target.ts`](./desktop-target.ts).

Notes and limits, since the desktop bundles the **production** server with its
own config (we adopt a running app, we do not configure it):

- **Cleanup is best-effort.** `DELETE /api/tests/cleanup` refuses a production
  build unless the app was launched with `PIWI_TEST_CLEANUP_ENABLED=true`; setup
  and teardown just warn otherwise, so test projects accumulate in your desktop
  data folder.
- **Feature-flag-gated specs may skip or fail** (share links, auth, email, or
  the Postgres/multi-server specs) — those depend on servers Playwright starts
  itself or on env the desktop was not launched with. Launch the desktop with
  the matching env (e.g. `PIWI_SHARE_LINKS_ENABLED=true`) for a fully green run.

## Configuration

Tests are configured in `playwright.config.ts` at the project root. Key settings:

- **baseURL**: `http://localhost:7494` (`shared/dev-server-port.mjs`; the running desktop app's loopback URL in `PIWI_DESKTOP_E2E` mode)
- **webServer**: starts the dev server locally (or reuses one already on port 7494), the production build (`.output`)
  in CI, and the servers some specs need: authentication on and notifications in CI only, PostgreSQL when
  `PIWI_POSTGRES_TEST_URL` is set, email when `PIWI_MAILPIT_URL` is set. A spec whose server is not started skips.
  No server starts in desktop mode: the app is already running.
- **retries**: 2 retries on CI, 0 locally
- **workers**: `fullyParallel`, 2 workers on CI and 3 locally; CI also shards the suite (5 shards per storage and
  database backend). Each spec creates its projects under static names from `#shared/test-project-names`, which the
  global setup and teardown delete.

## Prerequisites

1. Install dependencies:

   ```bash
   npm install
   ```

2. Install Chromium for Playwright (if not already installed), the one browser the suite runs:

   ```bash
   npx playwright install chromium
   ```

3. The dev server starts automatically when running tests

## Writing New Tests

Follow these patterns when adding tests:

### API Tests

```typescript
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

test('lists the project a run created', async ({ request }) => {
  // A project name is registered in shared/test-project-names.ts, so the cleanup deletes it.
  const submitted = await request.post('/api/test-runs/submit', {
    data: { projectName: PROJECT.YOUR_KEY, status: 'passed', startTime: new Date().toISOString(), testCases: [] },
  });
  expect(submitted.ok()).toBeTruthy();

  const { items } = await (await request.get('/api/projects')).json();
  expect(items.map((p: { name: string }) => p.name)).toContain(PROJECT.YOUR_KEY);
});
```

### UI Tests (with dashboard fixture)

```typescript
// Import from fixtures.ts so network requests and web vitals are captured
import { test, expect } from './fixtures';

test('should display element', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Element')).toBeVisible();
  // network requests & web vitals are automatically attached to the test report
});
```

### Setup/Teardown

```typescript
test.beforeEach(async ({ request }) => {
  // Setup test data
  await request.post('/api/test-runs/submit', { data: {...} });
});
```

## Debugging Tests

### Debug Mode

```bash
npx playwright test --debug
```

### Generate Code

```bash
npx playwright codegen http://localhost:7494
```

### View Trace

```bash
npx playwright show-trace trace.zip
```

## CI/CD Integration

The `e2e` job of `.github/workflows/ci.yml` runs the suite on the production build, in shards, once per storage and
database backend:

- 2 retries per failing test, and the run stops after 12 failed attempts
- a trace (with DOM, ARIA and screenshot snapshots) and a screenshot for each failure
- a blob report per shard, which `npx playwright merge-reports` turns into one HTML report

## Best Practices

1. **Isolation**: Each test should be independent
2. **Cleanup**: Use beforeEach/afterEach for setup/teardown
3. **Assertions**: Use meaningful expect() assertions
4. **Selectors**: Prefer role-based selectors over CSS
5. **Waiting**: Use built-in auto-waiting, avoid manual waits
6. **Data**: Create the data a test reads, under a project name from `#shared/test-project-names`; never rely on data
   another spec or a seed left
7. **Fixtures**: Import `test` from `./fixtures` in all UI tests for automatic network and web vitals capture

## Troubleshooting

### Port Already in Use

If port 7494 is in use, the tests will fail to start. Stop any running dev servers:

```bash
# Find and kill the process on port 7494
lsof -ti:7494 | xargs kill
```

```powershell
# Find and kill the process on port 7494
Stop-Process -Id (Get-NetTCPConnection -LocalPort 7494).OwningProcess
```

### Tests Timing Out

Increase timeout in playwright.config.ts or specific tests:

```typescript
test('slow test', async ({ page }) => {
  test.setTimeout(60000); // 60 seconds
  // ... test code
});
```

### Database Issues

Tests use the same database as dev. If tests fail due to data conflicts, delete the database (and all data) before running tests:

```bash
# Linux / macOS
rm -rf .data
```

```powershell
# Windows (PowerShell)
Remove-Item -Recurse -Force .data
```
