import { test, expect, type Page } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { ProjectRole } from '#shared/permissions';
import type { CiDispatchView } from '#shared/ci-dispatches';
import { waitForHydration } from './utils';
import { createMember } from './utils/access';

/**
 * The waiting rows of a project's runs list: a CI dispatch shows as a row once sent, links its run while that run goes
 * on, and leaves once it ends; a run request shows to the person who sent it, and to nobody else. A dispatch the
 * provider took cannot be made on the test server (its CI actions reach no CI): the page's send and its browser reads
 * of the dispatches are answered here, so the row changes because the answer turns the dispatch `running`, then
 * `ended`, read again on each run event of the project. Matching a run to its dispatch is the server's, covered by its
 * unit tests.
 */

const failedRun = (projectName: string) => ({
  projectName,
  status: 'failed',
  startTime: new Date(Date.now() - 60_000).toISOString(),
  duration: 2000,
  totalTests: 2,
  passedTests: 1,
  failedTests: 1,
  skippedTests: 0,
  testCases: [
    {
      title: 'pays by card',
      status: 'failed',
      error: 'Error: boom',
      duration: 1000,
      location: 'tests/pay.spec.ts:12:5',
    },
    { title: 'pays by voucher', status: 'passed', duration: 1000, location: 'tests/pay.spec.ts:30:5' },
  ],
});

test.describe.serial('Waiting rows, a CI dispatch', () => {
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/test-runs/submit', { data: failedRun(PROJECT.WAITING_RUNS) });
    expect(res.ok(), `submit failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    ({ projectId } = (await res.json()) as { projectId: number });
    // A base URL that resolves to this machine: the action is offered, and nothing would ever be sent.
    const saved = await request.patch(`/api/projects/${projectId}`, {
      data: {
        ciRerun: {
          enabled: true,
          actions: [
            {
              id: 'nightly',
              name: 'Nightly',
              target: {
                type: 'ci-server',
                preset: 'jenkins',
                baseUrl: 'https://localhost:9/',
                fields: { job: 'nightly' },
              },
              inputs: [],
              accepts: ['suite'],
            },
          ],
          defaults: { suite: 'nightly' },
        },
      },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
  });

  /** Answer the page's reads of the project's dispatches with `answer()`, and a send with `sent`. */
  async function answerDispatches(page: Page, sent: CiDispatchView, answer: () => CiDispatchView[]) {
    await page.route(
      (url) => url.pathname === `/api/projects/${projectId}/ci-dispatches`,
      (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({ status: 201, json: sent })
          : route.fulfill({ json: { items: answer() } }),
    );
  }

  /** A whole suite on the Nightly action, as the server answers its send. */
  const dispatched = (over: Partial<CiDispatchView>): CiDispatchView => ({
    id: '00000000feedbeef',
    actionId: 'nightly',
    actionName: 'Nightly',
    kind: 'suite',
    origin: 'page',
    provider: 'ci-server',
    preset: 'jenkins',
    url: 'https://jenkins.example.com/job/nightly/',
    args: '',
    ref: 'main',
    tests: null,
    state: 'dispatched',
    detail: null,
    runId: null,
    run: null,
    at: Date.now(),
    byName: null,
    byUserId: null,
    ...over,
  });

  /** Send the project's whole suite from its run button, and close the dialog on the follow-up. */
  async function sendFromThePage(page: Page) {
    await page.getByRole('button', { name: 'Run on CI' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { name: /Nightly/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'Send' }).click();
    await expect(dialog.getByTestId('run-follow-up-state')).toContainText('waiting for the run to report');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }

  /** Report a finished run of the project, which the page hears as a run event of the project. */
  async function report(request: import('@playwright/test').APIRequestContext): Promise<number> {
    const res = await request.post('/api/test-runs/submit', {
      data: { ...failedRun(PROJECT.WAITING_RUNS), status: 'passed', passedTests: 2, failedTests: 0, testCases: [] },
    });
    const body = await res.text();
    expect(res.ok(), body).toBeTruthy();
    return (JSON.parse(body) as { runId: number }).runId;
  }

  test('a dispatch sent from the page waits as a row, links its run while it goes on, and leaves once it ended', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const sent = dispatched({});
    let open: CiDispatchView[] = [];
    await answerDispatches(page, sent, () => open);

    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);
    const runs = page.locator('[data-shot="runs-table"]');
    await expect(runs.getByRole('link', { name: /^Run #\d+$/ }).first()).toBeVisible();
    await expect(page.getByTestId('waiting-runs')).toHaveCount(0);
    // From the send on, a read of the dispatches finds it too: any run event of the project reads them.
    open = [sent];

    await sendFromThePage(page);
    const row = runs.getByTestId('waiting-dispatch');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Waiting for CI');
    await expect(row).toContainText('Nightly on main');
    await expect(row.getByRole('link', { name: 'Open in CI' })).toHaveAttribute('href', sent.url!);

    // A run reports, and the dispatch now reads as running with it: its row links that run.
    const runId = await report(request);
    const ran = (status: string) => ({ id: runId, status, totalTests: 2, passedTests: 2, failedTests: 0 });
    open = [dispatched({ state: 'running', runId, run: ran('running') })];
    await report(request);
    await expect(row).toContainText('Running', { timeout: 20_000 });
    await expect(row.getByRole('link', { name: `Open run #${runId}` })).toBeVisible();

    // Its run ends: the dispatch ends with it, and the row leaves; the run is in the list.
    open = [dispatched({ state: 'ended', runId, run: ran('passed') })];
    await report(request);
    await expect(row).toHaveCount(0, { timeout: 20_000 });
    await expect(runs.getByRole('link', { name: `Run #${runId}`, exact: true })).toBeVisible();
  });

  test('Kept runs only lists kept runs alone: a waiting row leaves with the rest, and comes back', async ({
    page,
    request,
  }) => {
    const runs = ((await (await request.get(`/api/projects/${projectId}`)).json()) as { testRuns: { id: number }[] })
      .testRuns;
    const kept = await request.patch(`/api/test-runs/${runs[0]!.id}`, { data: { keep: true } });
    expect(kept.ok(), await kept.text()).toBeTruthy();
    const waiting = dispatched({ id: '00000000feedcafe', url: null, byName: 'Ana' });
    await answerDispatches(page, waiting, () => [waiting]);
    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);
    await sendFromThePage(page);
    const row = page.getByTestId('waiting-dispatch');
    await expect(row).toContainText('dispatched');
    await expect(row).toContainText('by Ana');
    await expect(row.getByRole('link', { name: 'Open in CI' })).toHaveCount(0);
    const keptOnly = page.getByText('Kept runs only');
    await keptOnly.click();
    await expect(row).toHaveCount(0);
    // Shown again, the rows are read again.
    const read = page.waitForResponse(
      (res) => new URL(res.url()).pathname === `/api/projects/${projectId}/ci-dispatches`,
    );
    await keptOnly.click();
    await read;
    await expect(row).toContainText('by Ana');
  });
});

// ── A run request, on the auth-enabled server (CI only): its sender alone sees its row ──

const AUTH_BASE = 'http://localhost:3097';
const ADMIN = { username: 'admin', password: 'adminpassword123' };
const MEMBER = { username: 'waiting-rows-member', password: 'memberpassword123' };

async function authApi(method: string, path: string, body?: unknown, cookie?: string) {
  return fetch(`${AUTH_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** The session cookie of a sign-in, as `name=value`. */
async function signIn(credentials: { username: string; password: string }): Promise<string> {
  const res = await authApi('POST', '/api/auth/login', credentials);
  expect(res.ok, `sign-in of ${credentials.username} failed: ${res.status}`).toBeTruthy();
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

/** Open a project's page in a browser signed in with `cookie`, once it has read the viewer's own requests. */
async function openAs(page: Page, cookie: string, projectId: number) {
  const [name, value] = [cookie.slice(0, cookie.indexOf('=')), cookie.slice(cookie.indexOf('=') + 1)];
  await page.context().addCookies([{ name, value, url: AUTH_BASE }]);
  const requestsRead = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/run-requests' && res.ok(), {
    timeout: 60_000,
  });
  await page.goto(`${AUTH_BASE}/projects/${projectId}`);
  await waitForHydration(page);
  await requestsRead;
  await expect(
    page
      .locator('[data-shot="runs-table"]')
      .getByRole('link', { name: /^Run #\d+$/ })
      .first(),
  ).toBeVisible({ timeout: 60_000 });
}

test.describe.serial('Waiting rows, a run request', () => {
  test.skip(!process.env.CI, 'The auth-enabled server runs in CI only (see playwright.config.ts webServer)');

  test('a request waits as a row for the person who sent it, and for nobody else', async ({ browser }) => {
    test.setTimeout(120_000);
    await authApi('POST', '/api/auth/setup', { ...ADMIN, name: 'Admin' });
    const admin = await signIn(ADMIN);
    const turnedOn = await authApi('PATCH', '/api/capabilities', { decisions: { 'machine-runs': 'enabled' } }, admin);
    expect(turnedOn.ok, await turnedOn.text()).toBeTruthy();
    let requestId: string | null = null;
    const adminContext = await browser.newContext();
    const memberContext = await browser.newContext();
    try {
      const submitted = await authApi('POST', '/api/test-runs/submit', failedRun(PROJECT.WAITING_RUNS_AUTH), admin);
      const submittedBody = await submitted.text();
      expect(submitted.ok, submittedBody).toBeTruthy();
      const { projectId, runId } = JSON.parse(submittedBody) as { projectId: number; runId: number };
      await createMember(
        { baseUrl: AUTH_BASE, cookie: admin },
        { ...MEMBER, role: ProjectRole.CONTRIBUTOR, projectId },
      );
      const member = await signIn(MEMBER);

      const sent = await authApi('POST', '/api/run-requests', { source: { runId, tests: 'failed' } }, admin);
      const sentBody = await sent.text();
      expect(sent.ok, sentBody).toBeTruthy();
      requestId = (JSON.parse(sentBody) as { id: string }).id;

      const adminPage = await adminContext.newPage();
      await openAs(adminPage, admin, projectId);
      const row = adminPage.getByTestId('waiting-request');
      await expect(row).toContainText('Waiting for one of your apps to pick it up');
      await expect(row).toContainText('pays by card');
      await expect(row).toContainText('only you see it');

      const memberPage = await memberContext.newPage();
      await openAs(memberPage, member, projectId);
      const own = (await (
        await authApi('GET', `/api/run-requests?projectId=${projectId}`, undefined, member)
      ).json()) as {
        items: unknown[];
      };
      expect(own.items).toEqual([]);
      await expect(memberPage.getByTestId('waiting-request')).toHaveCount(0);
    } finally {
      await Promise.all([adminContext.close(), memberContext.close()]);
      if (requestId) await authApi('POST', `/api/run-requests/${requestId}/stop`, {}, admin);
      await authApi('PATCH', '/api/capabilities', { decisions: { 'machine-runs': null } }, admin);
    }
  });
});
