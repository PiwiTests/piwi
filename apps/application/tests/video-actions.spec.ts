import { test, expect } from './fixtures';
import { retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

const SECRET_EMAIL = 'ada@example.com';
const SECRET_URL_PART = 'token=hunter2';

test.describe('Video actions API', () => {
  test.describe.configure({ mode: 'serial' });
  const t0 = Date.now() - 60_000;
  let withSteps = 0;
  let withoutSteps = 0;

  test.beforeAll(async ({ request }) => {
    const response = await retryPost(request, '/api/test-runs/submit', {
      data: {
        projectName: PROJECT.VIDEO_ACTIONS,
        status: 'passed',
        startTime: new Date(t0).toISOString(),
        duration: 6000,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        testCases: [
          {
            title: 'fills the form',
            status: 'passed',
            duration: 3000,
            location: 'tests/form.spec.ts:5:3',
            workerIndex: 0,
            startedAt: t0,
            steps: [
              {
                title: `Navigate to https://shop.example.com/checkout?${SECRET_URL_PART}#top`,
                category: 'pw:api',
                startTime: t0 + 200,
                duration: 300,
                params: { url: `https://shop.example.com/checkout?${SECRET_URL_PART}#top` },
              },
              {
                title: `Fill "${SECRET_EMAIL}" getByLabel('Email')`,
                category: 'pw:api',
                startTime: t0 + 900,
                duration: 100,
                params: { locator: "getByLabel('Email')", value: SECRET_EMAIL },
              },
              {
                title: "Click getByRole('button', { name: 'Save' })",
                category: 'pw:api',
                startTime: t0 + 1500,
                duration: 100,
                params: { locator: "getByRole('button', { name: 'Save' })" },
              },
            ],
          },
          {
            title: 'records nothing',
            status: 'passed',
            duration: 2000,
            location: 'tests/form.spec.ts:15:3',
            workerIndex: 0,
            startedAt: t0 + 3500,
          },
        ],
      },
    });
    expect(response.ok()).toBeTruthy();
    const { runId } = await response.json();
    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    const byTitle = (title: string) =>
      run.testCases.find((tc: { title: string }) => tc.title === title).executionId as number;
    withSteps = byTitle('fills the form');
    withoutSteps = byTitle('records nothing');
  });

  test('answers a test with steps from its step list, masked', async ({ request }) => {
    const response = await request.get(`/api/test-run-cases/${withSteps}/video-actions`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.source).toBe('steps');
    expect(body.actions.map((a: { kind: string }) => a.kind)).toEqual(['goto', 'fill', 'click']);
    expect(body.actions.map((a: { label: string }) => a.label)).toEqual([
      'Navigate to https://shop.example.com/checkout',
      "Fill getByLabel('Email'): typed 15 chars",
      "Click getByRole('button', { name: 'Save' })",
    ]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SECRET_EMAIL);
    expect(raw).not.toContain(SECRET_URL_PART);
  });

  test('answers a test with no steps and no trace as empty', async ({ request }) => {
    const response = await request.get(`/api/test-run-cases/${withoutSteps}/video-actions`);
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toEqual({ source: 'none', timing: null, actions: [], total: 0, capped: false });
  });

  test('refuses an id that is not a number and an execution that does not exist', async ({ request }) => {
    expect((await request.get('/api/test-run-cases/abc/video-actions')).status()).toBe(400);
    expect((await request.get('/api/test-run-cases/2000000000/video-actions')).status()).toBe(404);
  });
});
