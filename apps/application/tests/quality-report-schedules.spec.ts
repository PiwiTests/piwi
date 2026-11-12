/**
 * Report schedules and report snapshots:
 *   /api/reports/schedules    — create, validate, mute, run now, delete, preview
 *   /api/reports/snapshots    — list, read, download a snapshot
 *   /reports and /reports/:id — the Reports page, Run now, the snapshot page
 *   Schedule… on /analytics   — the schedule form, prefilled with the scope, and its preview
 *
 * The email itself is checked by email-notifications.spec.ts; here the
 * delivery row is queued and recorded on the snapshot.
 */
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import type {
  ReportSchedulePreview,
  ReportScheduleView,
  ReportSnapshotSummary,
  ReportSnapshotView,
} from '#shared/handlers/reports';

// One channel and one project for the whole file.
test.describe.configure({ mode: 'serial' });

let projectId: number;
let channelId: number;
const scheduleIds: number[] = [];

test.beforeAll(async ({ request }) => {
  const submit = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.QUALITY_REPORT_SCHEDULES,
      status: 'passed',
      startTime: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
      duration: 20_000,
      totalTests: 2,
      passedTests: 2,
      failedTests: 0,
      skippedTests: 0,
      testCases: [
        { title: 'schedules a report', status: 'passed', duration: 400, location: 'tests/report.spec.ts:1:1' },
        { title: 'sends a report', status: 'passed', duration: 300, location: 'tests/report.spec.ts:9:1' },
      ],
    },
  });
  expect(submit.ok()).toBeTruthy();
  projectId = (await submit.json()).projectId;
  const channel = await request.post('/api/channels', {
    data: { name: 'Quality report schedules test', type: 'email', config: { address: 'reports@example.test' } },
  });
  expect(channel.ok()).toBeTruthy();
  channelId = (await channel.json()).channel.id;
});

test.afterAll(async ({ request }) => {
  for (const id of scheduleIds) await request.delete(`/api/reports/schedules/${id}`);
  if (channelId) await request.delete(`/api/channels/${channelId}`);
});

async function createSchedule(request: import('@playwright/test').APIRequestContext, extra: object = {}) {
  const res = await request.post('/api/reports/schedules', {
    data: {
      name: 'Weekly checkout report',
      dashboard: 'executive',
      scope: { projects: String(projectId) },
      cadence: 'weekly',
      anchor: 1,
      at: '08:00',
      channelIds: [channelId],
      ...extra,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const schedule: ReportScheduleView = await res.json();
  scheduleIds.push(schedule.id);
  return schedule;
}

test.describe('Report schedule API', () => {
  test('a schedule fires next on its weekday at its time, over the page filters', async ({ request }) => {
    const schedule = await createSchedule(request);
    expect(schedule.dashboardName).toBe('Executive');
    expect(schedule.scope.projects).toBe(String(projectId));
    const next = new Date(schedule.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getUTCDay()).toBe(1);
    const list = await (await request.get('/api/reports/schedules')).json();
    expect(list.items.map((s: ReportScheduleView) => s.id)).toContain(schedule.id);
    expect(typeof list.timeZone).toBe('string');
  });

  test('refuses a team schedule without an owner, an unknown channel and a bad time', async ({ request }) => {
    const base = { name: 'x', cadence: 'daily', at: '08:00', channelIds: [channelId] };
    const team = await request.post('/api/reports/schedules', { data: { ...base, dashboard: 'team' } });
    expect(team.status()).toBe(400);
    const channel = await request.post('/api/reports/schedules', {
      data: { ...base, dashboard: 'executive', channelIds: [999_999] },
    });
    expect(channel.status()).toBe(404);
    const time = await request.post('/api/reports/schedules', {
      data: { ...base, dashboard: 'executive', at: '25:00' },
    });
    expect(time.status()).toBe(400);
  });

  test('run now keeps a snapshot, queues its delivery, and the snapshot downloads', async ({ request }) => {
    const schedule = await createSchedule(request);
    const run = await request.post(`/api/reports/schedules/${schedule.id}/run`);
    expect(run.ok()).toBeTruthy();
    const result = await run.json();
    expect(result).toMatchObject({ queued: 1, muted: false });

    const snapshot: ReportSnapshotView = await (
      await request.get(`/api/reports/snapshots/${result.snapshotId}`)
    ).json();
    expect(snapshot.scheduleId).toBe(schedule.id);
    expect(snapshot.bundle.dashboard.ref).toBe('executive');
    expect(snapshot.bundle.scopeText.projects).toBe(PROJECT.QUALITY_REPORT_SCHEDULES);
    expect(snapshot.title).toContain('Weekly checkout report');
    expect(snapshot.deliveries.map((d) => d.channelId)).toEqual([channelId]);

    const list = await (await request.get(`/api/reports/snapshots?scheduleId=${schedule.id}`)).json();
    expect(list.items.map((s: ReportSnapshotSummary) => s.id)).toEqual([result.snapshotId]);

    const pdf = await request.get(`/api/reports/snapshots/${result.snapshotId}/export?format=pdf`);
    expect(pdf.headers()['content-type']).toMatch(/^application\/pdf/);
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('a muted schedule keeps its snapshot and sends nothing', async ({ request }) => {
    const schedule = await createSchedule(request);
    const muted = await request.patch(`/api/reports/schedules/${schedule.id}`, {
      data: { mutedUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() },
    });
    expect(muted.ok()).toBeTruthy();
    const result = await (await request.post(`/api/reports/schedules/${schedule.id}/run`)).json();
    expect(result).toMatchObject({ queued: 0, muted: true });
    const snapshot: ReportSnapshotView = await (
      await request.get(`/api/reports/snapshots/${result.snapshotId}`)
    ).json();
    expect(snapshot.deliveries).toEqual([]);
  });

  test('the preview is the report Run now would send, and keeps nothing', async ({ request }) => {
    const before: { items: ReportSnapshotSummary[] } = await (await request.get('/api/reports/snapshots')).json();
    const res = await request.post('/api/reports/schedules/preview', {
      data: {
        name: 'Previewed report',
        dashboard: 'executive',
        scope: { projects: String(projectId) },
        cadence: 'daily',
        at: '08:00',
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const preview: ReportSchedulePreview = await res.json();
    expect(preview.bundle.title).toMatch(/^Previewed report: /);
    expect(preview.period.from).toBe(preview.period.to);
    expect(preview.bundle.scope.projectIds).toEqual([projectId]);
    const after: { items: ReportSnapshotSummary[] } = await (await request.get('/api/reports/snapshots')).json();
    expect(after.items.length).toBe(before.items.length);

    const team = await request.post('/api/reports/schedules/preview', {
      data: { dashboard: 'team', cadence: 'daily', at: '08:00' },
    });
    expect(team.status()).toBe(400);
  });

  test('a report is kept by hand from the same keys as the preview', async ({ request }) => {
    const res = await request.post('/api/reports/snapshots', {
      data: { dashboard: 'engineering', projects: String(projectId), period: 'last-7d' },
    });
    expect(res.status()).toBe(201);
    const { id } = await res.json();
    const snapshot: ReportSnapshotView = await (await request.get(`/api/reports/snapshots/${id}`)).json();
    expect(snapshot.scheduleId).toBeNull();
    expect(snapshot.bundle.dashboard.ref).toBe('engineering');
  });
});

test.describe('The Reports page', () => {
  test('lists the schedule, runs it, and opens the snapshot', async ({ page, request }) => {
    // A name of its own: a snapshot outlives its deleted schedule, so a rerun on the same server would find the last one.
    const name = `Report page schedule ${Date.now()}`;
    const schedule = await createSchedule(request, { name });
    await page.goto('/reports');
    const row = page.getByTestId(`schedule-${schedule.id}`);
    // The first visit compiles the page on a dev server.
    await expect(row).toContainText('Weekly on Monday at 08:00', { timeout: 60_000 });
    await expect(page.getByTestId(`schedule-recipients-${schedule.id}`)).toContainText(
      'Quality report schedules test: Email to reports@example.test',
    );
    // Hydration can lag the first paint; retry the click until the snapshot shows.
    const snapshotLink = page.getByTestId('snapshot-list').getByRole('link', { name: new RegExp(name) });
    await expect(async () => {
      if ((await snapshotLink.count()) === 0) await page.getByTestId(`schedule-run-${schedule.id}`).click();
      await expect(snapshotLink.first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 60_000 });

    await snapshotLink.first().click();
    await expect(page).toHaveURL(/\/reports\/\d+$/);
    const view = page.getByTestId('report-view');
    await expect(view).toBeVisible({ timeout: 30_000 });
    await expect(view.getByRole('heading', { name: new RegExp(name) })).toBeVisible();
    await expect(page.getByTestId('snapshot-delivery')).toContainText('Quality report schedules test');
  });

  test('Schedule… on the analytics page creates a schedule over the scope', async ({ page, request }) => {
    await page.goto(`/analytics?projects=${projectId}&period=last-7d`);
    const form = page.getByTestId('schedule-form');
    await expect(async () => {
      if (!(await form.isVisible()))
        await page.locator('button[title="Schedule a quality report of this scope"]').first().click();
      await expect(form).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByTestId('schedule-filters')).toContainText(PROJECT.QUALITY_REPORT_SCHEDULES);
    await page.getByTestId('schedule-name').fill('From the analytics page');
    await page.getByTestId('schedule-channels').click();
    const option = page.getByRole('option', { name: /Quality report schedules test/ });
    await expect(option).toContainText('Email to reports@example.test');
    await option.click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('schedule-recipients')).toContainText(
      'Quality report schedules test: Email to reports@example.test',
    );
    await page.getByTestId('schedule-save').click();
    await expect(form).toBeHidden({ timeout: 15_000 });

    const list = await (await request.get('/api/reports/schedules')).json();
    const created = list.items.find((s: ReportScheduleView) => s.name === 'From the analytics page');
    expect(created).toBeTruthy();
    scheduleIds.push(created.id);
    expect(created.scope.projects).toBe(String(projectId));
    expect(created.cadence).toBe('weekly');
  });

  test('Preview shows the email as sent and the full report, then back to the form', async ({ page }) => {
    await page.goto(`/analytics?projects=${projectId}&period=last-7d`);
    const form = page.getByTestId('schedule-form');
    await expect(async () => {
      if (!(await form.isVisible()))
        await page.locator('button[title="Schedule a quality report of this scope"]').first().click();
      await expect(form).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await page.getByTestId('schedule-name').fill('Previewed from the form');
    await page.getByTestId('schedule-channels').click();
    await page.getByRole('option', { name: /Quality report schedules test/ }).click();
    await page.keyboard.press('Escape');
    await page.getByTestId('schedule-preview-open').click();

    await expect(page.getByTestId('schedule-preview-period')).toContainText('As it would be sent now:');
    await expect(page.getByTestId('schedule-preview')).toContainText('Quality report schedules test: this email.');
    await expect(page.getByTestId('schedule-preview-subject')).toContainText(
      'Quality report: Previewed from the form: ',
    );
    const email = page.frameLocator('[data-testid="schedule-preview-email"]');
    await expect(email.getByRole('link', { name: 'Open in Piwi' })).toBeVisible({ timeout: 30_000 });
    await expect(email.getByRole('heading', { name: /^Previewed from the form: / })).toBeVisible();

    await page.getByTestId('schedule-preview-view').getByRole('tab', { name: 'Full report' }).click();
    await expect(page.getByTestId('report-view')).toBeVisible();
    await expect(page.getByTestId('report-view').getByRole('heading', { name: 'Fixes and triage' })).toBeVisible();

    await page.getByTestId('schedule-preview-back').click();
    await expect(page.getByTestId('schedule-name')).toHaveValue('Previewed from the form');
  });
});
