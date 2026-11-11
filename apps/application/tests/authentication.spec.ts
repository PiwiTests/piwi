import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { waitForHydration } from './utils';

test.describe('Authentication Tests', () => {
  test('should work without authentication when disabled', async ({ request }) => {
    // Test that API works without auth when PIWI_AUTH_ENABLED is false
    const response = await request.get('/api/auth/me');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.authenticated).toBe(false);
    expect(data.user).toBeNull();
  });

  test('should allow project edit without auth when disabled', async ({ request }) => {
    // First create a project
    const createResponse = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.AUTH_TEST,
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
    expect(createResponse.ok()).toBeTruthy();

    const createData = await createResponse.json();
    const projectId = createData.projectId;

    // Try to update the project (should work when auth is disabled)
    const updateResponse = await request.patch(`/api/projects/${projectId}`, {
      data: {
        label: 'Updated Label',
        description: 'Updated Description',
      },
    });
    expect(updateResponse.ok()).toBeTruthy();

    const { project: updateData } = await updateResponse.json();
    expect(updateData.label).toBe('Updated Label');
    expect(updateData.description).toBe('Updated Description');
  });

  test('should return error when trying to login with auth disabled', async ({ request }) => {
    const response = await request.post('/api/auth/login', {
      data: {
        username: 'admin',
        password: 'password',
      },
    });

    expect(response.status()).toBe(400);
    const data = await response.json();
    expect(data.message).toContain('Authentication is not enabled');
  });
});

// ── Authentication on (CI only) ─────────────────────────────────────────────

const AUTH_BASE = 'http://localhost:3097';
const ADMIN = { username: 'admin', password: 'adminpassword123' };
const EMAIL_MEMBER = {
  username: 'email-sign-in-member',
  email: 'email-sign-in@example.com',
  password: 'EmailSignIn123!',
  role: 'member',
};

test.describe.serial('Sign-in, authentication on', () => {
  test.skip(!process.env.CI, 'The auth-enabled server runs in CI only (see playwright.config.ts webServer)');

  // The setup is refused once the instance has a user, which is the case after the first run.
  test.beforeAll(async () => {
    await fetch(`${AUTH_BASE}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ADMIN, name: 'Admin' }),
    });
  });

  test('a member signs in through the form with their email in another letter case', async ({ page, playwright }) => {
    const api = await playwright.request.newContext({ baseURL: AUTH_BASE });
    expect((await api.post('/api/auth/login', { data: ADMIN })).ok()).toBeTruthy();
    const { items } = (await (await api.get('/api/users')).json()) as { items: { id: number; username: string }[] };
    for (const user of items) if (user.username === EMAIL_MEMBER.username) await api.delete(`/api/users/${user.id}`);
    const created = await api.post('/api/users', { data: EMAIL_MEMBER });
    expect(created.ok(), await created.text()).toBeTruthy();
    await api.dispose();

    await page.goto(`${AUTH_BASE}/login`);
    await waitForHydration(page);
    await page.getByLabel('Username or email').fill('Email-Sign-In@Example.COM');
    await page.getByLabel('Password').fill(EMAIL_MEMBER.password);
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).not.toHaveURL(/\/login/);

    const me = (await (await page.request.get(`${AUTH_BASE}/api/auth/me`)).json()) as {
      user: { username: string } | null;
    };
    expect(me.user?.username).toBe(EMAIL_MEMBER.username);
  });
});
