import { test, expect } from './fixtures';
import { spawn } from 'child_process';
import { join, resolve } from 'path';
import { existsSync, rmSync } from 'fs';
import type { APIRequestContext } from '@playwright/test';
import { PROJECT } from '#shared/test-project-names';
import { InstanceRole, ProjectRole } from '#shared/permissions';
import { waitForHydration } from './utils';
import { createMember } from './utils/access';

function safeRmSync(path: string, options?: Parameters<typeof rmSync>[1]) {
  try {
    if (existsSync(path)) rmSync(path, options);
  } catch {
    // File may be locked by another process (e.g. auth server's SQLite on Windows)
  }
}

const AUTH_PORT = 3099;
const AUTH_SERVER_URL = `http://localhost:${AUTH_PORT}`;
const STORAGE_PATH = join(process.cwd(), '.test-temp', 'auth-test-storage');

/**
 * Run a CommonJS reporter script in a dedicated Node.js subprocess.
 * The reporter package is CommonJS and cannot be imported directly from this
 * ESM test file, so we pipe the script as stdin to `node --input-type=commonjs`.
 */
function runReporterScript(cjsScript: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const proc = spawn('node', ['--input-type=commonjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => resolveP({ exitCode: code ?? 0, stdout, stderr }));
    proc.stdin!.write(cjsScript);
    proc.stdin!.end();
  });
}

test.describe.serial('Reporter with authentication enabled', () => {
  // The auth server (port 3099) is only started by the playwright webServer config
  // when running in CI. Skip all tests in this file when not in CI.
  test.skip(!process.env.CI, 'Auth server tests only run in CI (see playwright.config.ts webServer)');

  // The auth server opens its database file when it starts, so the file stays in
  // place: libSQL opens a new connection after each transaction, and one opened
  // on a deleted path starts an empty database.
  test.beforeAll(() => {
    safeRmSync(STORAGE_PATH, { recursive: true, force: true });
  });

  test.afterAll(() => {
    safeRmSync(STORAGE_PATH, { recursive: true, force: true });
  });

  async function loginAs(request: APIRequestContext, username: string, password: string) {
    const res = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, { data: { username, password } });
    expect(res.ok()).toBeTruthy();
  }

  // ---------------------------------------------------------------------------
  // Auth server sanity checks
  // ---------------------------------------------------------------------------

  test('/api/auth/me should indicate auth is enabled and no user is logged in', async ({ request }) => {
    const res = await request.get(`${AUTH_SERVER_URL}/api/auth/me`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    // When auth is enabled and no session exists, authenticated is false
    expect(data.authenticated).toBe(false);
    expect(data.user).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Initial setup — the login page swaps to a first-admin form while the users
  // table is empty, and creating the admin signs them straight in.
  // ---------------------------------------------------------------------------

  test('first-admin setup form creates the admin from the browser', async ({ page }) => {
    await page.goto(`${AUTH_SERVER_URL}/login`);
    await expect(page.getByRole('heading', { name: 'Create the first admin account' })).toBeVisible();

    await page.getByRole('textbox', { name: 'Username*' }).fill('admin');
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Administrator');
    await page.getByRole('textbox', { name: 'Password*', exact: true }).fill('adminpassword123');
    await page.getByRole('textbox', { name: 'Confirm password*' }).fill('adminpassword123');
    await page.getByRole('button', { name: 'Create admin account' }).click();

    // Setup logs the new admin in and lands on the dashboard.
    await expect(page.getByText('Admin account created', { exact: true })).toBeVisible();
    await page.waitForURL(`${AUTH_SERVER_URL}/`);
  });

  test('setup endpoint should reject a second call once users exist', async ({ request }) => {
    const res = await request.post(`${AUTH_SERVER_URL}/api/auth/setup`, {
      data: { username: 'admin2', password: 'password123' },
    });
    expect(res.status()).toBe(400);
  });

  test('login form rejects a wrong password, then signs in with the right one', async ({ page }) => {
    await page.goto(`${AUTH_SERVER_URL}/login`);
    // With the admin created, the page shows the login card, not the setup card.
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();

    await page.getByRole('textbox', { name: 'Username*' }).fill('admin');
    await page.getByRole('textbox', { name: 'Password*', exact: true }).fill('wrongpassword');
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page.getByText('Invalid username or password').first()).toBeVisible();

    await page.getByRole('textbox', { name: 'Password*', exact: true }).fill('adminpassword123');
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL(`${AUTH_SERVER_URL}/`);
  });

  test('password-recovery pages are reachable without a session', async ({ page }) => {
    await page.goto(`${AUTH_SERVER_URL}/forgot-password`);
    await expect(page.getByRole('heading', { name: 'Forgot password' })).toBeVisible();
    await expect(page).toHaveURL(`${AUTH_SERVER_URL}/forgot-password`);

    await page.goto(`${AUTH_SERVER_URL}/reset-password`);
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await expect(page).toHaveURL(`${AUTH_SERVER_URL}/reset-password`);
  });

  // ---------------------------------------------------------------------------
  // Login / logout
  // ---------------------------------------------------------------------------

  test('should log in with valid credentials', async ({ request }) => {
    const res = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'admin', password: 'adminpassword123' },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.user.username).toBe('admin');
  });

  test('should reject login with invalid credentials', async ({ request }) => {
    const res = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'admin', password: 'wrongpassword' },
    });
    expect(res.status()).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Protected endpoints are blocked without auth
  // ---------------------------------------------------------------------------

  test('submit endpoint should return 401 without authentication', async ({ request }) => {
    const res = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      data: {
        projectName: PROJECT.REPORTER_AUTH,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
    });
    expect(res.status()).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Create a dedicated CI account: a member holding Uploader on all projects,
  // which lets it create a project on its first submission.
  // ---------------------------------------------------------------------------

  test('admin can create a CI account holding the Uploader role on all projects', async ({ request }) => {
    await loginAs(request, 'admin', 'adminpassword123');

    const { id } = await createMember(
      { request, baseUrl: AUTH_SERVER_URL },
      { username: 'ci-reporter', password: 'reporterpassword123', name: 'CI Reporter', role: ProjectRole.UPLOADER },
    );

    const users = (await (await request.get(`${AUTH_SERVER_URL}/api/users`)).json()) as {
      items: Array<{ id: number; username: string; role: string; instanceRole: string }>;
    };
    expect(users.items.find((u) => u.id === id)).toMatchObject({
      username: 'ci-reporter',
      role: InstanceRole.MEMBER,
      instanceRole: InstanceRole.MEMBER,
    });
    const roles = await (await request.get(`${AUTH_SERVER_URL}/api/users/${id}/projects`)).json();
    expect(roles).toMatchObject({ allProjects: ProjectRole.UPLOADER, projects: [] });
  });

  // ---------------------------------------------------------------------------
  // Reporter submits results when authenticated
  // ---------------------------------------------------------------------------

  test('reporter can submit test results after login', async ({ request }) => {
    // Login as reporter user
    const loginRes = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'ci-reporter', password: 'reporterpassword123' },
    });
    expect(loginRes.ok()).toBeTruthy();

    // Submit test results in the same authenticated session
    const submitRes = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      data: {
        projectName: PROJECT.REPORTER_AUTH,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 5000,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'login page loads',
            status: 'passed',
            duration: 1200,
            location: 'tests/login.spec.ts:5:3',
            retries: 0,
          },
          {
            title: 'dashboard shows stats',
            status: 'passed',
            duration: 800,
            location: 'tests/dashboard.spec.ts:10:3',
            retries: 0,
          },
        ],
      },
    });
    expect(submitRes.ok()).toBeTruthy();
    const data = await submitRes.json();
    expect(data.success).toBe(true);
    expect(data.runId).toBeDefined();
    expect(data.projectId).toBeDefined();
  });

  // Permissions are enforced from each route's `x-required-permission` meta
  // (the single source of truth). An Uploader must be refused a route needing
  // an instance permission but allowed to read projects.
  test('an Uploader is refused an instance route but allowed a project read', async ({ request }) => {
    await loginAs(request, 'ci-reporter', 'reporterpassword123');

    // instance permissions (storage:manage, users:manage): administrators only
    const adminOnly = await request.get(`${AUTH_SERVER_URL}/api/admin/stats`);
    expect(adminOnly.status()).toBe(403);
    const createUser = await request.post(`${AUTH_SERVER_URL}/api/users`, {
      data: { username: 'nope-user', password: 'nopepassword123', role: InstanceRole.MEMBER },
    });
    expect(createUser.status()).toBe(403);

    // project:read, which the Uploader role grants
    const anyAuth = await request.get(`${AUTH_SERVER_URL}/api/projects`);
    expect(anyAuth.ok()).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Reporter module – login + submit flow (verified via direct HTTP calls)
  // The reporter's upload helpers are CommonJS and cannot be imported from an
  // ESM test file; we verify the same HTTP contract they rely on directly.
  // ---------------------------------------------------------------------------

  test('reporter lib: login endpoint returns a session cookie', async ({ request }) => {
    const res = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'ci-reporter', password: 'reporterpassword123' },
    });
    expect(res.ok()).toBeTruthy();
    // The server must set at least one session cookie
    const headers = res.headers();
    expect(headers['set-cookie']).toBeTruthy();
  });

  test('reporter lib: login endpoint rejects wrong credentials', async ({ request }) => {
    const res = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'ci-reporter', password: 'wrongpassword' },
    });
    expect(res.status()).toBe(401);
  });

  test('reporter lib: session cookie allows submit after login', async ({ request }) => {
    // Login first – the request fixture keeps the session cookie for this test
    const loginRes = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'ci-reporter', password: 'reporterpassword123' },
    });
    expect(loginRes.ok()).toBeTruthy();

    // Submit is accepted because the session cookie is sent automatically
    const submitRes = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      data: {
        projectName: PROJECT.REPORTER_AUTH_LIB,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 3000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'submit via session cookie',
            status: 'passed',
            duration: 500,
            location: 'tests/lib.spec.ts:1:1',
            retries: 0,
          },
        ],
      },
    });
    expect(submitRes.ok()).toBeTruthy();
    const data = await submitRes.json();
    expect(data.success).toBe(true);
    expect(data.runId).toBeDefined();
  });

  test('reporter lib: submit without session cookie returns 401', async ({ request }) => {
    // A fresh request context has no session cookie, so submit must be rejected
    const submitRes = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      data: {
        projectName: PROJECT.REPORTER_AUTH_LIB,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
    });
    expect(submitRes.status()).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Full PiwiDashboardReporter flow with username/password options
  // The reporter package is CommonJS, so we run it in a dedicated Node.js
  // subprocess using --input-type=commonjs to avoid ESM/CJS interop issues.
  // ---------------------------------------------------------------------------

  test('PiwiDashboardReporter submits results with username/password options', async ({ request }) => {
    const reporterPath = resolve(process.cwd(), '..', '..', 'packages', 'reporter', 'dist', 'index.js');
    const testFilePath = join(resolve(process.cwd()), 'tests', 'home.spec.ts');

    const { exitCode, stderr } = await runReporterScript(`
      const _mod = require(${JSON.stringify(reporterPath)}); const PiwiDashboardReporter = _mod.default ?? _mod;
      const reporter = new PiwiDashboardReporter({
        serverUrl: ${JSON.stringify(AUTH_SERVER_URL)},
        projectName: ${JSON.stringify(PROJECT.REPORTER_FULL_AUTH)},
        uploadReport: false,
        uploadTraces: false,
        collectScmInfo: false,
        collectCiInfo: false,
        collectPerformanceMetrics: false,
        username: 'ci-reporter',
        password: 'reporterpassword123',
        verbose: false
      });
      reporter.onBegin(
        { projects: [], workers: 1, timeout: 30000, fullyParallel: false },
        { allTests: () => [] }
      );
      reporter.onTestEnd(
        { title: 'homepage renders correctly', location: { file: ${JSON.stringify(testFilePath)}, line: 5, column: 3 } },
        { status: 'passed', duration: 900, error: null, retry: 0, attachments: [], steps: [] }
      );
      reporter.onEnd({ status: 'passed' }).then(() => {
        process.exit(0);
      }).catch(err => {
        console.error(err.message);
        process.exit(1);
      });
    `);

    expect(exitCode, `Reporter subprocess failed:\n${stderr}`).toBe(0);

    // Log in to authenticate for the verification call
    const loginRes = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'ci-reporter', password: 'reporterpassword123' },
    });
    expect(loginRes.ok()).toBeTruthy();

    // Verify the project was created
    const projectsRes = await request.get(`${AUTH_SERVER_URL}/api/projects`);
    expect(projectsRes.ok()).toBeTruthy();
    const projects = ((await projectsRes.json()) as { items: Array<{ name: string }> }).items;
    expect(projects.find((p) => p.name === PROJECT.REPORTER_FULL_AUTH)).toBeDefined();
  });

  test('PiwiDashboardReporter fails when auth is required but no credentials given', async () => {
    const reporterPath = resolve(process.cwd(), '..', '..', 'packages', 'reporter', 'dist', 'index.js');

    const { exitCode } = await runReporterScript(`
      const _mod = require(${JSON.stringify(reporterPath)}); const PiwiDashboardReporter = _mod.default ?? _mod;
      const reporter = new PiwiDashboardReporter({
        serverUrl: ${JSON.stringify(AUTH_SERVER_URL)},
        projectName: ${JSON.stringify(PROJECT.REPORTER_NO_AUTH)},
        uploadReport: false,
        uploadTraces: false,
        collectScmInfo: false,
        collectCiInfo: false,
        collectPerformanceMetrics: false,
        verbose: false
      });
      reporter.onBegin(
        { projects: [], workers: 1, timeout: 30000, fullyParallel: false },
        { allTests: () => [] }
      );
      reporter.onEnd({ status: 'passed' }).then(() => {
        process.exit(0);
      }).catch(() => {
        process.exit(1);
      });
    `);

    // Without credentials, the reporter must fail
    expect(exitCode).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // API key management
  // ---------------------------------------------------------------------------

  let reporterApiKey: string | null = null;

  test('admin can create an API key for the reporter user', async ({ request }) => {
    // Login as admin
    const loginRes = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'admin', password: 'adminpassword123' },
    });
    expect(loginRes.ok()).toBeTruthy();

    // Get reporter user id
    const usersRes = await request.get(`${AUTH_SERVER_URL}/api/users`);
    expect(usersRes.ok()).toBeTruthy();
    const usersData = await usersRes.json();
    const reporterUser = usersData.items.find((u: { username: string }) => u.username === 'ci-reporter');
    expect(reporterUser).toBeDefined();

    // Create API key
    const createRes = await request.post(`${AUTH_SERVER_URL}/api/users/${reporterUser.id}/api-keys`, {
      data: { name: 'CI Pipeline Key' },
    });
    expect(createRes.ok()).toBeTruthy();
    const keyData = await createRes.json();
    expect(keyData.key).toMatch(/^pd_[0-9a-f]{64}$/);
    expect(keyData.prefix).toHaveLength(8);
    expect(keyData.name).toBe('CI Pipeline Key');

    // Store the key for subsequent tests
    reporterApiKey = keyData.key;
  });

  test('GET api-keys lists the key with prefix but not the full value', async ({ request }) => {
    // Login as reporter
    const loginRes = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'ci-reporter', password: 'reporterpassword123' },
    });
    expect(loginRes.ok()).toBeTruthy();

    // The user list is admin-only (it exposes every account's email and role),
    // so a non-admin resolves its own id from the session instead.
    const usersRes = await request.get(`${AUTH_SERVER_URL}/api/users`);
    expect(usersRes.status()).toBe(403);
    const meRes = await request.get(`${AUTH_SERVER_URL}/api/auth/me`);
    const reporterUser = (await meRes.json()).user;
    expect(reporterUser.username).toBe('ci-reporter');

    const keysRes = await request.get(`${AUTH_SERVER_URL}/api/users/${reporterUser.id}/api-keys`);
    expect(keysRes.ok()).toBeTruthy();
    const keysData = await keysRes.json();
    expect(keysData.items).toHaveLength(1);
    const listedKey = keysData.items[0];
    expect(listedKey.name).toBe('CI Pipeline Key');
    // Only the prefix is returned – not the full key
    expect(listedKey.keyPrefix).toHaveLength(8);
    expect(listedKey).not.toHaveProperty('keyHash');
    expect(listedKey).not.toHaveProperty('key');
  });

  test('submit endpoint accepts a valid API key via Authorization header', async ({ request }) => {
    expect(reporterApiKey).not.toBeNull();

    const submitRes = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      headers: { Authorization: `Bearer ${reporterApiKey}` },
      data: {
        projectName: PROJECT.API_KEY_SUBMIT,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 2000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'loads homepage',
            status: 'passed',
            duration: 500,
            location: 'tests/home.spec.ts:1:1',
            retries: 0,
          },
        ],
      },
    });
    expect(submitRes.ok()).toBeTruthy();
    const data = await submitRes.json();
    expect(data.success).toBe(true);
  });

  test('submit endpoint accepts a valid API key via X-API-Key header', async ({ request }) => {
    expect(reporterApiKey).not.toBeNull();

    const submitRes = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      headers: { 'X-API-Key': reporterApiKey! },
      data: {
        projectName: PROJECT.API_KEY_SUBMIT,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
    });
    expect(submitRes.ok()).toBeTruthy();
    const data = await submitRes.json();
    expect(data.success).toBe(true);
  });

  test('submit endpoint rejects an invalid API key', async ({ request }) => {
    const res = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      headers: { Authorization: 'Bearer pd_0000000000000000000000000000000000000000000000000000000000000000' },
      data: {
        projectName: PROJECT.INVALID_KEY,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
    });
    expect(res.status()).toBe(401);
  });

  test('reporter lib postJSON with API key submits successfully', async ({ request }) => {
    expect(reporterApiKey).not.toBeNull();

    // Test the same HTTP contract the reporter's postJSON helper uses: a Bearer
    // token in the Authorization header must be accepted by the submit endpoint.
    const submitRes = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      headers: { Authorization: `Bearer ${reporterApiKey}` },
      data: {
        projectName: PROJECT.REPORTER_API_KEY_LIB,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'test via api key',
            status: 'passed',
            duration: 300,
            location: 'tests/api-key.spec.ts:1:1',
            retries: 0,
          },
        ],
      },
    });
    expect(submitRes.ok()).toBeTruthy();
    const result = await submitRes.json();
    expect(result.success).toBe(true);
    expect(result.runId).toBeDefined();
  });

  // The key carries its owner's access: Uploader reads the project and submits
  // runs, nothing else.
  test('an Uploader key submits a run but is refused a triage route', async ({ request }) => {
    expect(reporterApiKey).not.toBeNull();
    const headers = { Authorization: `Bearer ${reporterApiKey}` };

    const submitRes = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      headers,
      data: {
        projectName: PROJECT.API_KEY_SUBMIT,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'uploader triage check',
            status: 'failed',
            duration: 300,
            location: 'tests/uploader.spec.ts:1:1',
            error:
              "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('uploader-check')",
          },
        ],
      },
    });
    expect(submitRes.ok()).toBeTruthy();
    const { runId } = await submitRes.json();

    const run = (await (await request.get(`${AUTH_SERVER_URL}/api/test-runs/${runId}`, { headers })).json()) as {
      testCases: Array<{ status: string; failureClusterId?: number }>;
    };
    const clusterId = run.testCases.find((c) => c.status === 'failed')?.failureClusterId;
    expect(clusterId).toBeTruthy();

    const triage = await request.patch(`${AUTH_SERVER_URL}/api/failure-clusters/${clusterId}/status`, {
      headers,
      data: { status: 'resolved' },
    });
    expect(triage.status()).toBe(403);
    expect((await triage.json()).message).toBe('Insufficient permissions');
  });

  test('PiwiDashboardReporter submits results with apiKey option', async ({ request }) => {
    expect(reporterApiKey).not.toBeNull();

    const reporterPath = resolve(process.cwd(), '..', '..', 'packages', 'reporter', 'dist', 'index.js');
    const testFilePath = join(resolve(process.cwd()), 'tests', 'api-key.spec.ts');

    const { exitCode, stderr } = await runReporterScript(`
      const _mod = require(${JSON.stringify(reporterPath)}); const PiwiDashboardReporter = _mod.default ?? _mod;
      const reporter = new PiwiDashboardReporter({
        serverUrl: ${JSON.stringify(AUTH_SERVER_URL)},
        projectName: ${JSON.stringify(PROJECT.REPORTER_API_KEY_E2E)},
        uploadReport: false,
        uploadTraces: false,
        collectScmInfo: false,
        collectCiInfo: false,
        collectPerformanceMetrics: false,
        apiKey: ${JSON.stringify(reporterApiKey)},
        verbose: false
      });
      reporter.onBegin(
        { projects: [], workers: 1, timeout: 30000, fullyParallel: false },
        { allTests: () => [] }
      );
      reporter.onTestEnd(
        { title: 'api key auth works end to end', location: { file: ${JSON.stringify(testFilePath)}, line: 1, column: 1 } },
        { status: 'passed', duration: 400, error: null, retry: 0, attachments: [], steps: [] }
      );
      reporter.onEnd({ status: 'passed' }).then(() => {
        process.exit(0);
      }).catch(err => {
        console.error(err.message);
        process.exit(1);
      });
    `);

    expect(exitCode, `Reporter subprocess failed:\n${stderr}`).toBe(0);

    // Log in to authenticate for the verification call
    const loginRes = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'admin', password: 'adminpassword123' },
    });
    expect(loginRes.ok()).toBeTruthy();

    // Verify project was created
    const projectsRes = await request.get(`${AUTH_SERVER_URL}/api/projects`);
    expect(projectsRes.ok()).toBeTruthy();
    const projects = ((await projectsRes.json()) as { items: Array<{ name: string }> }).items;
    expect(projects.find((p) => p.name === PROJECT.REPORTER_API_KEY_E2E)).toBeDefined();
  });

  test('admin can revoke the API key', async ({ request }) => {
    // Login as admin
    const loginRes = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'admin', password: 'adminpassword123' },
    });
    expect(loginRes.ok()).toBeTruthy();

    // Get reporter user id
    const usersRes = await request.get(`${AUTH_SERVER_URL}/api/users`);
    const usersData = await usersRes.json();
    const reporterUser = usersData.items.find((u: { username: string }) => u.username === 'ci-reporter');

    // Get the key id
    const keysRes = await request.get(`${AUTH_SERVER_URL}/api/users/${reporterUser.id}/api-keys`);
    const keysData = await keysRes.json();
    expect(keysData.items).toHaveLength(1);
    const keyId = keysData.items[0].id;

    // Revoke the key
    const revokeRes = await request.delete(`${AUTH_SERVER_URL}/api/users/${reporterUser.id}/api-keys/${keyId}`);
    expect(revokeRes.ok()).toBeTruthy();
    const revokeData = await revokeRes.json();
    expect(revokeData.success).toBe(true);

    // Key list should now be empty
    const keysResAfter = await request.get(`${AUTH_SERVER_URL}/api/users/${reporterUser.id}/api-keys`);
    const keysDataAfter = await keysResAfter.json();
    expect(keysDataAfter.items).toHaveLength(0);
  });

  test('revoked API key is rejected', async ({ request }) => {
    expect(reporterApiKey).not.toBeNull();

    const res = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      headers: { Authorization: `Bearer ${reporterApiKey}` },
      data: {
        projectName: PROJECT.REVOKED_KEY,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 100,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
    });
    expect(res.status()).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Share links — the one anonymous read path on an auth-enabled server.
  // ---------------------------------------------------------------------------

  test('a share link renders anonymously while the API stays authenticated', async ({ request, playwright }) => {
    const loginRes = await request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'admin', password: 'adminpassword123' },
    });
    expect(loginRes.ok()).toBeTruthy();

    const submit = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      data: {
        projectName: PROJECT.REPORTER_AUTH,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 900,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'anonymously shared failure',
            status: 'failed',
            duration: 300,
            location: 'tests/shared.spec.ts:3:1',
            error: 'Error: expected banner to be visible',
          },
        ],
      },
    });
    expect(submit.ok()).toBeTruthy();
    const { runId } = await submit.json();
    const run = (await (await request.get(`${AUTH_SERVER_URL}/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ executionId: number; status: string }>;
    };
    const executionId = run.testCases.find((c) => c.status === 'failed')!.executionId;

    const minted = await (
      await request.post(`${AUTH_SERVER_URL}/api/test-run-cases/${executionId}/share-links`, { data: {} })
    ).json();
    expect(minted.token).toMatch(/^psl_/);

    // A context with no session: the share URL renders, the API refuses.
    const anon = await playwright.request.newContext();
    try {
      const shared = await anon.get(minted.url);
      expect(shared.status()).toBe(200);
      expect(await shared.text()).toContain('anonymously shared failure');

      const api = await anon.get(`${AUTH_SERVER_URL}/api/test-run-cases/${executionId}`);
      expect(api.status()).toBe(401);
      const mint = await anon.post(`${AUTH_SERVER_URL}/api/test-run-cases/${executionId}/share-links`, { data: {} });
      expect(mint.status()).toBe(401);
    } finally {
      await anon.dispose();
    }
  });

  // ---------------------------------------------------------------------------
  // Project members API — `project:members`, held by a Project admin
  //
  // These checks need a real authenticated member session (a member's request
  // must actually be rejected), which only exists on this auth-enabled server:
  // with auth disabled (the default dev/test server) `requireAuth` always
  // returns a virtual administrator and no 403 can ever be observed. See
  // `tests/user-management.spec.ts` for the GET/PUT shape and validation tests
  // that run against the auth-disabled server instead.
  // ---------------------------------------------------------------------------

  let membersProjectId: number;
  let membersRunId: number;
  let ciUserId: number;
  let ciReporterId: number;

  type MemberRow = { subject: { type: string; id: number }; username: string | null; role: string; source: string };

  test('create a member with no role binding for the authorization checks', async ({ request }) => {
    await loginAs(request, 'admin', 'adminpassword123');

    ({ id: ciUserId } = await createMember(
      { request, baseUrl: AUTH_SERVER_URL },
      { username: 'ci-user', password: 'userpassword123', name: 'CI User', role: null },
    ));

    const usersRes = await request.get(`${AUTH_SERVER_URL}/api/users`);
    const usersData = await usersRes.json();
    ciReporterId = usersData.items.find((u: { username: string }) => u.username === 'ci-reporter').id;
  });

  test('a member without a role binding sees no project and cannot upload', async ({ request }) => {
    await loginAs(request, 'ci-user', 'userpassword123');

    const projects = await request.get(`${AUTH_SERVER_URL}/api/projects`);
    expect(projects.ok()).toBeTruthy();
    expect(((await projects.json()) as { items: unknown[] }).items).toEqual([]);

    const submit = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      data: {
        projectName: PROJECT.AUTH_ROLE_CHECKS,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
    });
    expect(submit.status()).toBe(403);
  });

  test('admin creates a project for the members checks', async ({ request }) => {
    await loginAs(request, 'admin', 'adminpassword123');

    const res = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      data: {
        projectName: PROJECT.AUTH_ROLE_CHECKS,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    membersProjectId = data.projectId;
    membersRunId = data.runId;
  });

  test('a member with no role on a project gets a 403 page for it and its runs', async ({ page }) => {
    const login = await page.request.post(`${AUTH_SERVER_URL}/api/auth/login`, {
      data: { username: 'ci-user', password: 'userpassword123' },
    });
    expect(login.ok()).toBeTruthy();

    for (const { path, heading } of [
      { path: `/projects/${membersProjectId}`, heading: 'No access to this project' },
      { path: `/test-runs/${membersRunId}`, heading: 'No access to this test run' },
    ]) {
      const response = await page.goto(`${AUTH_SERVER_URL}${path}`);
      expect(response?.status()).toBe(403);
      await expect(
        page.locator('[data-shot="error-page"]').getByRole('heading', { level: 1, name: heading }),
      ).toBeVisible();
    }
    await expect(page.locator('[data-shot="error-page"]')).toContainText(
      'An administrator, or a Project admin of that project',
    );
  });

  test('GET /api/projects/:id/members is rejected without the Project admin role', async ({ request }) => {
    // ci-reporter reads every project (Uploader on all projects) but cannot manage members.
    await loginAs(request, 'ci-reporter', 'reporterpassword123');
    let res = await request.get(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/members`);
    expect(res.status()).toBe(403);

    // ci-user, with no role binding at all, is rejected too.
    await loginAs(request, 'ci-user', 'userpassword123');
    res = await request.get(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/members`);
    expect(res.status()).toBe(403);
  });

  test('PUT /api/projects/:id/members is rejected without the Project admin role', async ({ request }) => {
    await loginAs(request, 'ci-reporter', 'reporterpassword123');

    const res = await request.put(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/members`, {
      data: { entries: [{ subject: { type: 'user', id: ciReporterId }, role: ProjectRole.PROJECT_ADMIN }] },
    });
    expect(res.status()).toBe(403);
  });

  test('admin can GET then PUT project members, granting ci-user and ci-reporter a role there', async ({ request }) => {
    await loginAs(request, 'admin', 'adminpassword123');

    const before = await request.get(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/members`);
    expect(before.ok()).toBeTruthy();
    const beforeBody = (await before.json()) as { members: MemberRow[] };
    expect(beforeBody.members.some((m) => m.username === 'ci-user')).toBe(false);
    // ci-reporter holds a role here only through its binding on all projects.
    expect(beforeBody.members.filter((m) => m.username === 'ci-reporter')).toEqual([
      expect.objectContaining({ role: ProjectRole.UPLOADER, source: 'all-projects' }),
    ]);

    const put = await request.put(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/members`, {
      data: {
        entries: [
          { subject: { type: 'user', id: ciUserId }, role: ProjectRole.VIEWER },
          { subject: { type: 'user', id: ciReporterId }, role: ProjectRole.MAINTAINER },
        ],
      },
    });
    expect(put.ok()).toBeTruthy();
    expect((await put.json()).success).toBe(true);

    const after = await request.get(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/members`);
    const afterBody = (await after.json()) as { members: MemberRow[] };
    expect(afterBody.members.filter((m) => m.username === 'ci-user')).toEqual([
      expect.objectContaining({ subject: { type: 'user', id: ciUserId }, role: ProjectRole.VIEWER, source: 'direct' }),
    ]);
    expect(afterBody.members.filter((m) => m.username === 'ci-reporter')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: ProjectRole.MAINTAINER, source: 'direct' }),
        expect.objectContaining({ role: ProjectRole.UPLOADER, source: 'all-projects' }),
      ]),
    );
  });

  test('a Viewer of the project cannot manage its members', async ({ request }) => {
    await loginAs(request, 'ci-user', 'userpassword123');

    const res = await request.get(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/members`);
    expect(res.status()).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // Permission grid API — administrator-only, and a grant changes what the user sees
  // ---------------------------------------------------------------------------

  test('the permission grid API is rejected for members', async ({ request }) => {
    await loginAs(request, 'ci-reporter', 'reporterpassword123');

    expect((await request.get(`${AUTH_SERVER_URL}/api/project-access`)).status()).toBe(403);
    const put = await request.put(`${AUTH_SERVER_URL}/api/project-access`, {
      data: { subject: { type: 'user', id: ciReporterId }, projectId: null, role: ProjectRole.PROJECT_ADMIN },
    });
    expect(put.status()).toBe(403);
  });

  test('admin grants and revokes a role on all projects through the permission grid', async ({ request }) => {
    const projectIdsSeenBy = async (username: string, password: string) => {
      await loginAs(request, username, password);
      const res = await request.get(`${AUTH_SERVER_URL}/api/projects`);
      expect(res.ok()).toBeTruthy();
      return ((await res.json()) as { items: { id: number }[] }).items.map((p) => p.id);
    };
    const setAllProjectsRoleAsAdmin = async (role: ProjectRole | null) => {
      await loginAs(request, 'admin', 'adminpassword123');
      const res = await request.put(`${AUTH_SERVER_URL}/api/project-access`, {
        data: { subject: { type: 'user', id: ciUserId }, projectId: null, role },
      });
      expect(res.ok()).toBeTruthy();
      const { bindings } = (await res.json()) as { bindings: Array<{ projectId: number | null; role: string }> };
      return bindings.map((b) => ({ projectId: b.projectId, role: b.role }));
    };

    // ci-user is a Viewer of the members-check project only.
    expect(await projectIdsSeenBy('ci-user', 'userpassword123')).toEqual([membersProjectId]);

    const granted = await setAllProjectsRoleAsAdmin(ProjectRole.VIEWER);
    expect(granted).toHaveLength(2);
    expect(granted).toEqual(
      expect.arrayContaining([
        { projectId: null, role: ProjectRole.VIEWER },
        { projectId: membersProjectId, role: ProjectRole.VIEWER },
      ]),
    );
    const seenWithAll = await projectIdsSeenBy('ci-user', 'userpassword123');
    expect(seenWithAll).toContain(membersProjectId);
    expect(seenWithAll.length).toBeGreaterThan(1);

    // Removing the all-projects role leaves the role held on the one project.
    expect(await setAllProjectsRoleAsAdmin(null)).toEqual([{ projectId: membersProjectId, role: ProjectRole.VIEWER }]);
    expect(await projectIdsSeenBy('ci-user', 'userpassword123')).toEqual([membersProjectId]);
  });

  // ---------------------------------------------------------------------------
  // Capability endpoints — reads open to any signed-in user with access, writes
  // for administrators (instance) or Project admins (project), and a project
  // decision overriding the instance default.
  // ---------------------------------------------------------------------------

  test('GET /api/capabilities is readable by a member', async ({ request }) => {
    await loginAs(request, 'ci-user', 'userpassword123');
    const res = await request.get(`${AUTH_SERVER_URL}/api/capabilities`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { items: Array<{ id: string; module: string; state: string }> };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  test('PATCH /api/capabilities is rejected for a member', async ({ request }) => {
    await loginAs(request, 'ci-user', 'userpassword123');
    const res = await request.patch(`${AUTH_SERVER_URL}/api/capabilities`, {
      data: { decisions: { notifications: 'declined' } },
    });
    expect(res.status()).toBe(403);
  });

  test('GET /api/projects/:id/capabilities is readable by a Viewer of the project', async ({ request }) => {
    await loginAs(request, 'ci-user', 'userpassword123');
    const res = await request.get(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/capabilities`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.some((i) => i.id === 'fixtures')).toBe(true);
  });

  test('PATCH /api/projects/:id/capabilities is rejected for a Viewer', async ({ request }) => {
    await loginAs(request, 'ci-user', 'userpassword123');
    const res = await request.patch(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/capabilities`, {
      data: { decisions: { quarantine: 'declined' } },
    });
    expect(res.status()).toBe(403);
  });

  test('PATCH /api/capabilities applies several decisions in one request', async ({ request }) => {
    await loginAs(request, 'admin', 'adminpassword123');
    const stateOf = (items: Array<{ id: string; state: string }>, id: string) => items.find((i) => i.id === id)?.state;

    const res = await request.patch(`${AUTH_SERVER_URL}/api/capabilities`, {
      data: { decisions: { notifications: 'declined', tags: 'declined' } },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { items: Array<{ id: string; state: string }> };
    expect(stateOf(body.items, 'notifications')).toBe('declined');
    expect(stateOf(body.items, 'tags')).toBe('declined');

    // Restore a clean slate for later tests.
    await request.patch(`${AUTH_SERVER_URL}/api/capabilities`, {
      data: { decisions: { notifications: null, tags: null } },
    });
  });

  test('a project enable overrides an instance decline', async ({ request }) => {
    await loginAs(request, 'admin', 'adminpassword123');

    const stateOf = (items: Array<{ id: string; state: string }>, id: string) => items.find((i) => i.id === id)?.state;

    // Decline quarantine instance-wide; the project sees it declined.
    await request.patch(`${AUTH_SERVER_URL}/api/capabilities`, { data: { decisions: { quarantine: 'declined' } } });
    let res = await request.get(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/capabilities`);
    let body = (await res.json()) as { items: Array<{ id: string; state: string }> };
    expect(stateOf(body.items, 'quarantine')).toBe('declined');

    // Enable it for this project; the override lifts the decline.
    await request.patch(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/capabilities`, {
      data: { decisions: { quarantine: 'enabled' } },
    });
    res = await request.get(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/capabilities`);
    body = (await res.json()) as { items: Array<{ id: string; state: string }> };
    expect(stateOf(body.items, 'quarantine')).not.toBe('declined');

    // Restore a clean slate for later tests.
    await request.patch(`${AUTH_SERVER_URL}/api/capabilities`, { data: { decisions: { quarantine: null } } });
    await request.patch(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/capabilities`, {
      data: { decisions: { quarantine: null } },
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/failure-clusters/:id/diagnose/stream — permission enforcement.
  //
  // The route declares `x-required-permission: 'ai:run'` (Maintainer and up),
  // which `requireAuth` enforces from the route meta (the single source of
  // truth). So a Viewer of the project is rejected with 403 before the request
  // reaches the cluster-lookup / AI-config checks.
  // ---------------------------------------------------------------------------

  let roleChecksClusterId: number;

  test('a Viewer of the project is blocked from diagnose/stream', async ({ request }) => {
    // A failing run in the members-check project, so there is a cluster.
    await loginAs(request, 'admin', 'adminpassword123');

    const submitRes = await request.post(`${AUTH_SERVER_URL}/api/test-runs/submit`, {
      data: {
        projectName: PROJECT.AUTH_ROLE_CHECKS,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'role check test',
            status: 'failed',
            duration: 500,
            location: 'tests/role-check.spec.ts:1:1',
            error:
              "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('role-check')",
          },
        ],
      },
    });
    expect(submitRes.ok()).toBeTruthy();
    const { runId } = await submitRes.json();

    const run = (await (await request.get(`${AUTH_SERVER_URL}/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ status: string; failureClusterId?: number }>;
    };
    const clusterId = run.testCases.find((c) => c.status === 'failed')?.failureClusterId;
    expect(clusterId).toBeTruthy();
    roleChecksClusterId = clusterId!;

    // ci-user is a Viewer of PROJECT.AUTH_ROLE_CHECKS (granted above), so it
    // reads the cluster; only the permission is in question here.
    await loginAs(request, 'ci-user', 'userpassword123');

    const streamRes = await request.post(`${AUTH_SERVER_URL}/api/failure-clusters/${clusterId}/diagnose/stream`);
    // A Viewer holds `ai:run` on no project, so the request is rejected with
    // 403 before the AI-config check.
    expect(streamRes.status()).toBe(403);
    expect((await streamRes.json()).message).toBe('Insufficient permissions');
  });

  // A Contributor files issues but does not triage: the draft is served, the
  // cluster status change is refused.
  test('a Contributor drafts an issue but is refused a triage route', async ({ request }) => {
    await loginAs(request, 'admin', 'adminpassword123');
    await createMember(
      { request, baseUrl: AUTH_SERVER_URL },
      {
        username: 'ci-contributor',
        password: 'contributorpassword123',
        role: ProjectRole.CONTRIBUTOR,
        projectId: membersProjectId,
      },
    );
    // A draft needs a tracker connection with credentials; one that cannot be
    // reached only leaves the draft's duplicate search empty.
    const connection = await request.post(`${AUTH_SERVER_URL}/api/integrations/connections`, {
      data: {
        provider: 'jira',
        name: 'Role checks Jira',
        baseUrl: 'http://127.0.0.1:9',
        credentials: { email: 'ci@piwi.dev', apiToken: 'unused-token' },
      },
    });
    expect(connection.ok()).toBeTruthy();
    const connectionId = ((await connection.json()) as { connection: { id: number } }).connection.id;

    try {
      await loginAs(request, 'ci-contributor', 'contributorpassword123');
      const draft = await request.get(
        `${AUTH_SERVER_URL}/api/integrations/issue-draft?entityType=failure_cluster&entityId=${roleChecksClusterId}`,
      );
      expect(draft.status()).toBe(200);
      const body = (await draft.json()) as { clusterId: number; title: string; connectionId: number };
      expect(body).toMatchObject({ clusterId: roleChecksClusterId, connectionId });
      expect(body.title).toBeTruthy();

      const triage = await request.patch(`${AUTH_SERVER_URL}/api/failure-clusters/${roleChecksClusterId}/status`, {
        data: { status: 'resolved' },
      });
      expect(triage.status()).toBe(403);
      expect((await triage.json()).message).toBe('Insufficient permissions');
    } finally {
      await loginAs(request, 'admin', 'adminpassword123');
      await request.delete(`${AUTH_SERVER_URL}/api/integrations/connections/${connectionId}`);
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/users/:id — admins can change the instance role (the only way to
  // promote an OAuth-provisioned account, which signs up as a member), but the
  // last administrator can never be demoted into a lockout.
  // ---------------------------------------------------------------------------

  test('admin can change the instance role but cannot demote the last administrator', async ({ request }) => {
    await loginAs(request, 'admin', 'adminpassword123');

    const usersRes = await request.get(`${AUTH_SERVER_URL}/api/users`);
    const usersData = await usersRes.json();
    const adminUser = usersData.items.find((u: { username: string }) => u.username === 'admin');
    const targetUser = usersData.items.find((u: { username: string }) => u.username === 'ci-user');
    expect(adminUser).toBeDefined();
    expect(targetUser).toBeDefined();

    // Promote ci-user (a member) to administrator, then restore it.
    const promote = await request.patch(`${AUTH_SERVER_URL}/api/users/${targetUser.id}`, {
      data: { role: InstanceRole.ADMINISTRATOR },
    });
    expect(promote.ok()).toBeTruthy();
    expect((await promote.json()).user.instanceRole).toBe(InstanceRole.ADMINISTRATOR);

    const restore = await request.patch(`${AUTH_SERVER_URL}/api/users/${targetUser.id}`, {
      data: { role: InstanceRole.MEMBER },
    });
    expect(restore.ok()).toBeTruthy();
    expect((await restore.json()).user.instanceRole).toBe(InstanceRole.MEMBER);

    // `admin` is the only administrator, so demoting it is refused and the
    // account keeps its role.
    const demote = await request.patch(`${AUTH_SERVER_URL}/api/users/${adminUser.id}`, {
      data: { role: InstanceRole.MEMBER },
    });
    expect(demote.status()).toBe(400);
    expect((await demote.json()).message).toContain('last administrator');

    const afterRes = await request.get(`${AUTH_SERVER_URL}/api/users`);
    const afterData = await afterRes.json();
    expect(afterData.items.find((u: { username: string }) => u.username === 'admin').role).toBe(
      InstanceRole.ADMINISTRATOR,
    );
  });

  // ---------------------------------------------------------------------------
  // Capability roles in the browser: a Viewer sees the effect of an undecided capability (the
  // one naming line) but none of the decline controls, and cannot reach Setup.
  // Reuses ci-user, a Viewer of PROJECT.AUTH_ROLE_CHECKS, which holds a
  // fixtureless failing run from an earlier test in this serial suite.
  // ---------------------------------------------------------------------------

  test('a Viewer sees the evidence footer sentence with no decline controls, and Setup is unreachable', async ({
    page,
    request,
  }) => {
    await loginAs(request, 'admin', 'adminpassword123');
    // The capture fixtures are undecided for this project, so the footer names the
    // missing sources — clear any stored decision to be sure.
    await request.patch(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}/capabilities`, {
      data: { decisions: { fixtures: null } },
    });
    const detail = (await (await request.get(`${AUTH_SERVER_URL}/api/projects/${membersProjectId}`)).json()) as {
      testRuns: Array<{ id: number }>;
    };
    const run = (await (await request.get(`${AUTH_SERVER_URL}/api/test-runs/${detail.testRuns[0]!.id}`)).json()) as {
      testCases: Array<{ status: string; executionId: number }>;
    };
    const execId = run.testCases.find((c) => c.status === 'failed')!.executionId;

    // Sign in as the Viewer in the browser.
    await page.goto(`${AUTH_SERVER_URL}/login`);
    await page.getByRole('textbox', { name: 'Username*' }).fill('ci-user');
    await page.getByRole('textbox', { name: 'Password*', exact: true }).fill('userpassword123');
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForURL(`${AUTH_SERVER_URL}/`);

    // The footer names the missing sources but offers no decline controls.
    await page.goto(`${AUTH_SERVER_URL}/test-run-cases/${execId}`);
    await waitForHydration(page);
    const footer = page.locator('[data-shot="evidence-fixtures-footer"]');
    await expect(footer).toContainText('not captured for this project');
    await expect(footer.getByRole('button', { name: 'Not for this project' })).toHaveCount(0);
    await expect(footer.getByRole('button', { name: 'Not for this instance' })).toHaveCount(0);
    await expect(footer.getByRole('link', { name: 'Add fixtures' })).toHaveCount(0);

    // Setup is administrator-only: the Viewer is redirected away from it.
    await page.goto(`${AUTH_SERVER_URL}/setup`);
    await expect(page).not.toHaveURL(`${AUTH_SERVER_URL}/setup`);
  });
});
