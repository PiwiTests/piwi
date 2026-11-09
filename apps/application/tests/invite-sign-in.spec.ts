/**
 * An invited user signs in for the first time. The spec starts an
 * auth-enabled server of its own (port 3105, its own database and storage)
 * that sends its email to an in-process SMTP sink. An administrator invites a
 * user who has no password; the invite email names the username, the link
 * sets a password, and the sign-in form it lands on holds that username.
 */
import { test, expect } from './fixtures';
import { resolve } from 'node:path';
import { startSpawnedServer, type SpawnedServer } from './utils/spawned-server';
import { waitForHydration } from './utils';
import { plainTextPart, startSmtpSink, type SmtpSink } from './utils/smtp-sink';

const PORT = 3105;
const AUTH_SECRET = 'test-auth-secret-key-for-invite-tests';
const ADMIN = { username: 'admin', password: 'adminpassword123' };
const INVITEE = { username: 'invitee', email: 'invitee@example.com', password: 'InviteePassword1!' };

test.describe.configure({ mode: 'serial' });

let server: SpawnedServer | null = null;
let smtp: SmtpSink | null = null;

test.describe('Invite and first sign-in', () => {
  test.beforeAll(async () => {
    test.setTimeout(6 * 60_000);
    smtp = await startSmtpSink();
    server = startSpawnedServer({
      port: PORT,
      tempDir: resolve('.test-temp', 'invite-sign-in'),
      env: {
        PIWI_AUTH_ENABLED: 'true',
        PIWI_AUTH_SECRET: AUTH_SECRET,
        NUXT_AUTH_ENABLED: 'true',
        NUXT_AUTH_SECRET: AUTH_SECRET,
        NUXT_PUBLIC_AUTH_ENABLED: 'true',
        PIWI_SETUP_TOKEN: '',
        PIWI_SITE_URL: `http://127.0.0.1:${PORT}`,
        PIWI_SMTP_HOST: '127.0.0.1',
        PIWI_SMTP_PORT: String(smtp.port),
        PIWI_SMTP_SECURE: 'false',
        PIWI_SMTP_USER: '',
        PIWI_SMTP_PASS: '',
        PIWI_SMTP_FROM: 'noreply@piwi.test',
      },
    });
    await server.ready(5 * 60_000);
  });

  test.afterAll(async () => {
    await server?.stop();
    await smtp?.close();
  });

  test('the invite names the username and the sign-in form is filled in with it', async ({ page, playwright }) => {
    test.setTimeout(3 * 60_000);
    const api = await playwright.request.newContext({ baseURL: server!.baseUrl });
    const setup = await api.post('/api/auth/setup', { data: { ...ADMIN, name: 'Administrator' } });
    expect(setup.ok(), await setup.text()).toBeTruthy();
    const login = await api.post('/api/auth/login', { data: ADMIN });
    expect(login.ok(), await login.text()).toBeTruthy();

    const created = await api.post('/api/users', {
      data: { username: INVITEE.username, email: INVITEE.email, role: 'member' },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { user } = (await created.json()) as { user: { id: number } };
    const invited = await api.post(`/api/users/${user.id}/invite`);
    expect(invited.ok(), await invited.text()).toBeTruthy();
    await api.dispose();

    const raw = await smtp!.waitFor((m) => m.includes(`To: ${INVITEE.email}`));
    const text = plainTextPart(raw);
    expect(text).toContain(`Your username is ${INVITEE.username}.`);
    const link = /http\S+\/reset-password\?\S+/.exec(text)?.[0];
    expect(link).toBeTruthy();

    await page.goto(link!);
    await waitForHydration(page);
    await page.getByLabel('New password').fill(INVITEE.password);
    await page.getByLabel('Confirm password').fill(INVITEE.password);
    await page.getByRole('button', { name: 'Activate account' }).click();

    await expect(page).toHaveURL(/\/login$/);
    await waitForHydration(page);
    await expect(page.getByLabel('Username')).toHaveValue(INVITEE.username);
    await page.getByLabel('Password').fill(INVITEE.password);
    await page.getByRole('button', { name: 'Login' }).click();
    await expect(page).not.toHaveURL(/\/login/);

    const me = (await (await page.request.get(`${server!.baseUrl}/api/auth/me`)).json()) as {
      user: { username: string } | null;
    };
    expect(me.user?.username).toBe(INVITEE.username);
  });
});
