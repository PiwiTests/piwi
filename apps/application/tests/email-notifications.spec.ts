/**
 * Email and notification integration tests. The spec starts an auth-enabled
 * server of its own (port 3098, its own database and storage) that sends its
 * email to an in-process SMTP sink: the SMTP test send, forgot and reset
 * password, change password, the invite, notification dispatch and the
 * scheduled quality report.
 */

import { resolve } from 'node:path';
import { test, expect } from './fixtures';
import { ProjectRole } from '#shared/permissions';
import { createMember } from './utils/access';
import { PROJECT } from '#shared/test-project-names';
import { startSpawnedServer, type SpawnedServer } from './utils/spawned-server';
import { readMail, sentTo, startSmtpSink, type Mail, type SmtpSink } from './utils/smtp-sink';

// Every test reads the one sink, so the file runs serially.
test.describe.configure({ mode: 'serial' });

const PORT = 3098;
const EMAIL_SERVER = `http://127.0.0.1:${PORT}`;
const AUTH_SECRET = 'test-email-secret-key-for-email-tests';
const ADMIN_CREDS = { username: 'admin', password: 'adminpassword123' };
const RESET_LINK = /http[^\s"<>]+reset-password[^\s"<>]+/;

let server: SpawnedServer | null = null;
let smtp: SmtpSink;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The first email sent to `address`, read, waiting up to `timeoutMs` for it. */
async function mailTo(address: string, timeoutMs?: number): Promise<Mail> {
  return readMail(await smtp.waitFor(sentTo(address), timeoutMs));
}

/** The emails received so far that were sent to `address`. */
function mailsTo(address: string): Mail[] {
  return smtp.messages.filter(sentTo(address)).map(readMail);
}

async function apiPost(path: string, body: unknown, cookie?: string) {
  return fetch(`${EMAIL_SERVER}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/**
 * Create an email channel through a pre-save test, so it is saved verified and
 * receives notifications. The test message is cleared from the sink.
 */
async function createVerifiedEmailChannel(
  channel: { name: string; config: { address: string }; global?: boolean },
  cookie: string,
): Promise<number> {
  const tested = await apiPost('/api/channels/test', { type: 'email', config: channel.config }, cookie);
  expect(((await tested.json()) as { success: boolean }).success).toBe(true);
  const created = await apiPost('/api/channels', { ...channel, type: 'email' }, cookie);
  expect(created.ok).toBe(true);
  const { channel: saved } = (await created.json()) as { channel: { id: number; verified: boolean } };
  expect(saved.verified).toBe(true);
  smtp.clear();
  return saved.id;
}

async function adminLogin(): Promise<string> {
  const res = await apiPost('/api/auth/login', ADMIN_CREDS);
  const header = res.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}

test.beforeAll(async () => {
  test.setTimeout(6 * 60_000);
  smtp = await startSmtpSink();
  server = startSpawnedServer({
    port: PORT,
    tempDir: resolve('.test-temp', 'email-notifications'),
    env: {
      PIWI_AUTH_ENABLED: 'true',
      PIWI_AUTH_SECRET: AUTH_SECRET,
      NUXT_AUTH_ENABLED: 'true',
      NUXT_AUTH_SECRET: AUTH_SECRET,
      NUXT_PUBLIC_AUTH_ENABLED: 'true',
      PIWI_SETUP_TOKEN: '',
      PIWI_SITE_URL: EMAIL_SERVER,
      PIWI_SMTP_HOST: '127.0.0.1',
      PIWI_SMTP_PORT: String(smtp.port),
      PIWI_SMTP_SECURE: 'false',
      PIWI_SMTP_USER: '',
      PIWI_SMTP_PASS: '',
      PIWI_SMTP_FROM: 'noreply@piwi.test',
      PIWI_SMTP_FROM_NAME: 'Piwi Test',
    },
  });
  await server.ready(5 * 60_000);
  const setup = await apiPost('/api/auth/setup', { ...ADMIN_CREDS, name: 'Administrator' });
  expect(setup.ok, await setup.text()).toBe(true);
});

test.afterAll(async () => {
  await server?.stop();
  await smtp?.close();
});

// ── SMTP test endpoint ───────────────────────────────────────────────────────

test.describe.serial('SMTP test send', () => {
  test.beforeEach(() => smtp.clear());

  test('admin can send a test email', async () => {
    const cookie = await adminLogin();
    const res = await apiPost('/api/settings/smtp/test', { to: 'testrecipient@example.com' }, cookie);
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);

    const mail = await mailTo('testrecipient@example.com');
    expect(mail.subject).toContain('Test');
    expect(mail.from).toContain('noreply@piwi.test');
  });

  test('non-admin cannot access smtp test endpoint', async () => {
    const res = await apiPost('/api/settings/smtp/test', { to: 'x@example.com' });
    expect(res.status).toBe(401);
  });
});

// ── Forgot / reset password ──────────────────────────────────────────────────

test.describe.serial('Forgot & reset password', () => {
  const RESET_EMAIL = 'resetuser@example.com';
  let userId: number;

  test.beforeAll(async () => {
    const cookie = await adminLogin();

    // Create a user with email via admin
    ({ id: userId } = await createMember(
      { baseUrl: EMAIL_SERVER, cookie },
      { username: 'resettest', password: 'OldPassword1!', email: RESET_EMAIL, role: ProjectRole.VIEWER },
    ));
  });

  test.afterAll(async () => {
    if (!userId) return;
    const cookie = await adminLogin();
    await fetch(`${EMAIL_SERVER}/api/users/${userId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
  });

  test.beforeEach(() => smtp.clear());

  test('forgot-password does not reveal whether account exists', async () => {
    const [r1, r2] = await Promise.all([
      apiPost('/api/auth/forgot-password', { email: RESET_EMAIL }),
      apiPost('/api/auth/forgot-password', { email: 'nobody@example.com' }),
    ]);
    // Both return 200 success regardless
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const [d1, d2] = (await Promise.all([r1.json(), r2.json()])) as [{ success: boolean }, { success: boolean }];
    expect(d1.success).toBe(true);
    expect(d2.success).toBe(true);
    // The account's reset email is taken here, so it cannot reach the next test, whose newer request replaces its token.
    await mailTo(RESET_EMAIL);
  });

  test('reset token is delivered by email and can be used once', async () => {
    await apiPost('/api/auth/forgot-password', { email: RESET_EMAIL });

    const mail = await mailTo(RESET_EMAIL);

    // Extract reset link from email
    const linkMatch = (mail.html || mail.text).match(RESET_LINK);
    expect(linkMatch).not.toBeNull();
    const url = new URL(linkMatch![0]!);
    const token = url.searchParams.get('token');
    expect(token).toBeTruthy();

    // Use the token to reset password
    const resetRes = await apiPost('/api/auth/reset-password', {
      token,
      password: 'NewPassword1!',
    });
    expect(resetRes.ok).toBe(true);

    // Token should be single-use: second attempt must fail
    const secondRes = await apiPost('/api/auth/reset-password', {
      token,
      password: 'AnotherPassword1!',
    });
    expect(secondRes.ok).toBe(false);
    expect(secondRes.status).toBe(400);
  });

  test('can log in with new password after reset', async () => {
    await apiPost('/api/auth/forgot-password', { email: RESET_EMAIL });
    const mail = await mailTo(RESET_EMAIL);
    const linkMatch = (mail.html || mail.text).match(RESET_LINK);
    const url = new URL(linkMatch![0]!);
    const token = url.searchParams.get('token')!;

    await apiPost('/api/auth/reset-password', { token, password: 'FinalPassword1!' });

    const loginRes = await apiPost('/api/auth/login', {
      username: 'resettest',
      password: 'FinalPassword1!',
    });
    expect(loginRes.ok).toBe(true);
  });
});

// ── Change password ──────────────────────────────────────────────────────────

test.describe.serial('Change password', () => {
  const USERNAME = 'changepwtest';
  const INITIAL_PW = 'InitialPw1!';
  let userId: number;
  let cookie: string;

  test.beforeAll(async () => {
    const adminCookie = await adminLogin();
    ({ id: userId } = await createMember(
      { baseUrl: EMAIL_SERVER, cookie: adminCookie },
      { username: USERNAME, password: INITIAL_PW, role: ProjectRole.VIEWER },
    ));

    const loginRes = await apiPost('/api/auth/login', { username: USERNAME, password: INITIAL_PW });
    cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';
  });

  test.afterAll(async () => {
    if (!userId) return;
    const adminCookie = await adminLogin();
    await fetch(`${EMAIL_SERVER}/api/users/${userId}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
  });

  test('change password succeeds with correct current password', async () => {
    const res = await apiPost(
      '/api/auth/change-password',
      {
        currentPassword: INITIAL_PW,
        newPassword: 'Changed1!',
      },
      cookie,
    );
    expect(res.ok).toBe(true);

    // Verify old password no longer works
    const oldLoginRes = await apiPost('/api/auth/login', { username: USERNAME, password: INITIAL_PW });
    expect(oldLoginRes.ok).toBe(false);
  });

  test('change password fails with wrong current password', async () => {
    const loginRes = await apiPost('/api/auth/login', { username: USERNAME, password: 'Changed1!' });
    const freshCookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const res = await apiPost(
      '/api/auth/change-password',
      {
        currentPassword: 'WrongPassword!',
        newPassword: 'NewPw1!',
      },
      freshCookie,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });
});

// ── Invite flow ──────────────────────────────────────────────────────────────

test.describe.serial('User invite email', () => {
  const INVITE_EMAIL = 'invitee@example.com';
  let userId: number;

  test.beforeAll(async () => {
    const cookie = await adminLogin();
    ({ id: userId } = await createMember(
      { baseUrl: EMAIL_SERVER, cookie },
      { username: 'invitetest', password: 'TempPassword1!', email: INVITE_EMAIL, role: ProjectRole.VIEWER },
    ));
  });

  test.afterAll(async () => {
    if (!userId) return;
    const cookie = await adminLogin();
    await fetch(`${EMAIL_SERVER}/api/users/${userId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
  });

  test.beforeEach(() => smtp.clear());

  test('admin can send invite and invite link sets password', async () => {
    const cookie = await adminLogin();
    const inviteRes = await apiPost(`/api/users/${userId}/invite`, {}, cookie);
    expect(inviteRes.ok).toBe(true);

    const mail = await mailTo(INVITE_EMAIL);
    const linkMatch = (mail.html || mail.text).match(RESET_LINK);
    expect(linkMatch).not.toBeNull();

    const url = new URL(linkMatch![0]!);
    const token = url.searchParams.get('token');
    expect(token).toBeTruthy();

    // Invite token accepted by reset-password endpoint
    const resetRes = await apiPost('/api/auth/reset-password', {
      token,
      password: 'InviteePassword1!',
    });
    expect(resetRes.ok).toBe(true);
  });
});

// ── Notification dispatch ────────────────────────────────────────────────────

test.describe.serial('Notification dispatch', () => {
  const NOTIFY_EMAIL = 'notifyuser@example.com';
  /** A second channel on the project, whose email shows a run's deliveries were sent. */
  const SWEEP_EMAIL = 'sweep-witness@example.com';
  let cookie: string;
  let userId: number;
  let channelId: number;
  let subscriptionId: number;
  let sweepChannelId: number;
  let sweepSubscriptionId: number;
  let projectId: number;

  async function subscribe(channel: number): Promise<number> {
    const res = await apiPost(
      '/api/subscriptions',
      { channelId: channel, projectId, events: ['run.finished'], mode: 'realtime' },
      cookie,
    );
    expect(res.ok, await res.clone().text()).toBe(true);
    return ((await res.json()) as { subscription: { id: number } }).subscription.id;
  }

  async function mute(subscription: number, muted: boolean): Promise<void> {
    const res = await fetch(`${EMAIL_SERVER}/api/subscriptions/${subscription}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ mutedUntil: muted ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null }),
    });
    expect(res.ok).toBe(true);
  }

  async function submitPassedRun(title: string) {
    const res = await apiPost(
      '/api/test-runs/submit',
      {
        projectName: PROJECT.NOTIFY_EMAIL,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title, status: 'passed', duration: 500, suiteName: 'Suite' }],
      },
      cookie,
    );
    expect(res.ok).toBe(true);
  }

  test.beforeAll(async () => {
    cookie = await adminLogin();

    // Create a user with email
    ({ id: userId } = await createMember(
      { baseUrl: EMAIL_SERVER, cookie },
      { username: 'notifytest', password: 'NotifyPw1!', email: NOTIFY_EMAIL, role: ProjectRole.VIEWER },
    ));

    // Create a project by submitting a run
    const runRes = await apiPost(
      '/api/test-runs/submit',
      {
        projectName: PROJECT.NOTIFY_EMAIL,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
      cookie,
    );
    const runData = (await runRes.json()) as { projectId?: number };
    projectId = runData.projectId ?? 0;

    // Create an email channel, verified by a pre-save test
    channelId = await createVerifiedEmailChannel({ name: 'Test Email', config: { address: NOTIFY_EMAIL } }, cookie);

    subscriptionId = await subscribe(channelId);
    sweepChannelId = await createVerifiedEmailChannel(
      { name: 'Sweep witness', config: { address: SWEEP_EMAIL } },
      cookie,
    );
    sweepSubscriptionId = await subscribe(sweepChannelId);
  });

  test.afterAll(async () => {
    const del = (path: string) => fetch(`${EMAIL_SERVER}${path}`, { method: 'DELETE', headers: { Cookie: cookie } });
    if (sweepSubscriptionId) await del(`/api/subscriptions/${sweepSubscriptionId}`);
    if (sweepChannelId) await del(`/api/channels/${sweepChannelId}`);
    if (subscriptionId) await del(`/api/subscriptions/${subscriptionId}`);
    if (channelId) await del(`/api/channels/${channelId}`);
    if (userId) await del(`/api/users/${userId}`);
  });

  test.beforeEach(() => smtp.clear());

  test('run.finished event delivers email to subscriber', async () => {
    // Submit a failing run to trigger run.finished + run.failed
    const runRes = await apiPost(
      '/api/test-runs/submit',
      {
        projectName: PROJECT.NOTIFY_EMAIL,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 2000,
        totalTests: 3,
        passedTests: 1,
        failedTests: 2,
        skippedTests: 0,
        testCases: [
          { title: 'Test 1', status: 'passed', duration: 500, suiteName: 'Suite' },
          { title: 'Test 2', status: 'failed', duration: 800, suiteName: 'Suite', error: 'Expected x got y' },
          { title: 'Test 3', status: 'failed', duration: 700, suiteName: 'Suite', error: 'Timeout' },
        ],
      },
      cookie,
    );
    expect(runRes.ok).toBe(true);

    // The outbox is kicked right after the run is finalized; the sweep runs every minute besides.
    const mail = await mailTo(NOTIFY_EMAIL, 15_000);
    expect(mail.subject.toLowerCase()).toMatch(/run|test|notify/i);
  });

  test('deduplication: a later sweep does not send a delivered email again', async () => {
    // Each run sends one email, and its sweep passes over every due row, the ones already sent included. Sweeps run
    // one at a time, so the third email means the second run's sweep has finished: a delivery sent again by it is in.
    for (const [index, title] of ['Dedup 1', 'Dedup 2', 'Dedup 3'].entries()) {
      await submitPassedRun(title);
      await expect.poll(() => mailsTo(NOTIFY_EMAIL).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(index + 1);
    }
    expect(mailsTo(NOTIFY_EMAIL)).toHaveLength(3);
  });

  test('muted subscription does not deliver', async () => {
    await mute(subscriptionId, true);
    try {
      await submitPassedRun('Muted Test');
      // The witness channel's email shows the run's deliveries were sent.
      await expect.poll(() => mailsTo(SWEEP_EMAIL).length, { timeout: 15_000 }).toBe(1);
      expect(mailsTo(NOTIFY_EMAIL)).toHaveLength(0);
    } finally {
      await mute(subscriptionId, false);
    }
  });
});

// ── Scheduled quality report ─────────────────────────────────────────────────

test.describe.serial('Scheduled quality report email', () => {
  const REPORT_EMAIL = 'quality-reports@example.com';
  let channelId = 0;
  let scheduleId = 0;

  test.beforeAll(() => smtp.clear());

  test.afterAll(async () => {
    const cookie = await adminLogin();
    const del = (path: string) => fetch(`${EMAIL_SERVER}${path}`, { method: 'DELETE', headers: { Cookie: cookie } });
    if (scheduleId) await del(`/api/reports/schedules/${scheduleId}`);
    if (channelId) await del(`/api/channels/${channelId}`);
  });

  test('Run now sends the quality report by email, with the trend as an inline image', async () => {
    const cookie = await adminLogin();
    channelId = await createVerifiedEmailChannel(
      { name: 'Quality report mail', config: { address: REPORT_EMAIL }, global: true },
      cookie,
    );

    const schedule = await apiPost(
      '/api/reports/schedules',
      {
        name: 'Weekly quality report',
        dashboard: 'executive',
        cadence: 'weekly',
        anchor: 1,
        at: '08:00',
        channelIds: [channelId],
        global: true,
      },
      cookie,
    );
    expect(schedule.status).toBe(201);
    scheduleId = ((await schedule.json()) as { id: number }).id;

    const run = await apiPost(`/api/reports/schedules/${scheduleId}/run`, {}, cookie);
    expect(run.ok).toBe(true);
    const { snapshotId } = (await run.json()) as { snapshotId: number };

    const mail = await mailTo(REPORT_EMAIL, 30_000);
    expect(mail.subject).toMatch(/^Quality report: Weekly quality report: /);
    expect(mail.html).toContain('src="cid:trend"');
    expect(mail.html).toContain(`/reports/${snapshotId}`);
    expect(mail.parts.filter((p) => p.inline).map((p) => [p.filename, p.contentType])).toContainEqual([
      'trend.png',
      'image/png',
    ]);

    // The delivery is recorded on the snapshot as sent.
    await expect
      .poll(async () => {
        const res = await fetch(`${EMAIL_SERVER}/api/reports/snapshots/${snapshotId}`, { headers: { Cookie: cookie } });
        const snapshot = (await res.json()) as { deliveries: Array<{ status: string }> };
        return snapshot.deliveries.map((d) => d.status);
      })
      .toEqual(['sent']);
  });
});
