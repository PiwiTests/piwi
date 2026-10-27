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

### Watch Mode

```bash
npx playwright test --watch
```

## Configuration

Tests are configured in `playwright.config.ts` at the project root. Key settings:

- **baseURL**: `http://localhost:7494` (`shared/dev-server-port.mjs`; the running desktop app's loopback URL in `PIWI_DESKTOP_E2E` mode)
- **webServer**: Automatically starts the dev server before tests (skipped in desktop mode — the app is already running)
- **retries**: 2 retries on CI, 0 locally
- **workers**: 1 (serial execution — the suite uses static project names shared across tests, requiring sequential cleanup)

## Prerequisites

1. Install dependencies:

   ```bash
   npm install
   ```

2. Install Playwright browsers (if not already installed):

   ```bash
   npx playwright install
   ```

3. The dev server will start automatically when running tests

## Writing New Tests

Follow these patterns when adding tests:

### API Tests

```typescript
test('should do something', async ({ request }) => {
  const response = await request.get('/api/endpoint');
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(data).toBeDefined();
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

Tests are designed to run in CI environments:

- Automatic dev server startup
- Retry failed tests
- HTML report generation
- Screenshot on failure
- Video recording on failure

## Best Practices

1. **Isolation**: Each test should be independent
2. **Cleanup**: Use beforeEach/afterEach for setup/teardown
3. **Assertions**: Use meaningful expect() assertions
4. **Selectors**: Prefer role-based selectors over CSS
5. **Waiting**: Use built-in auto-waiting, avoid manual waits
6. **Data**: Create test data dynamically, don't rely on existing data
7. **Fixtures**: Import `test` from `./fixtures` in all UI tests for automatic network and web vitals capture

## Troubleshooting

### Port Already in Use

If port 7494 is in use, the tests will fail to start. Stop any running dev servers:

```bash
# Find and kill process on port 7494
lsof -ti:7494 | xargs kill
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
