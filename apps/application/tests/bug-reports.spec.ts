import { test, expect, type APIRequestContext } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { couponBugReport, TINY_JPEG, TINY_PNG } from './utils/bug-report-sample';

// A bug report sent the way Piwi Picker sends it, its pages, its spec, and the
// lifecycle the runs of its committed test drive.
test.describe.serial('Bug reports', () => {
  let projectId = 0;
  let reportId = 0;

  async function submitRun(request: APIRequestContext, cases: object[]) {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.BUG_REPORTS,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: cases.length,
        passedTests: cases.length,
        failedTests: 0,
        skippedTests: 0,
        testCases: cases,
      },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as { runId: number; projectId: number };
  }

  // The lifecycle runs after the run is stored, beside the other finish-time effects: poll it.
  async function reportStatus(request: APIRequestContext): Promise<string> {
    return ((await (await request.get(`/api/bug-reports/${reportId}`)).json()) as { status: string }).status;
  }

  test('a report sent as multipart is stored with its screenshot', async ({ request }) => {
    ({ projectId } = await submitRun(request, [
      { title: 'home loads', status: 'passed', duration: 10, location: 'tests/home.spec.ts:3:5' },
    ]));
    const response = await request.post(`/api/projects/${projectId}/bug-reports`, {
      multipart: {
        report: JSON.stringify(couponBugReport()),
        language: 'fr',
        screenshot: { name: '1-marked.png', mimeType: 'image/png', buffer: TINY_PNG },
      },
    });
    expect(response.status()).toBe(201);
    ({ id: reportId } = (await response.json()) as { id: number });

    const report = await (await request.get(`/api/bug-reports/${reportId}`)).json();
    expect(report.title).toBe('Coupon not applied to the total');
    expect(report.status).toBe('open');
    expect(report.language).toBe('fr');
    expect(report.evidence.screenshots).toHaveLength(1);
    const shot = await request.get(`/api/bug-reports/${reportId}/screenshots/0`);
    expect(shot.headers()['content-type']).toBe('image/png');
    expect(Buffer.from(await shot.body()).equals(TINY_PNG)).toBe(true);

    const list = await (await request.get(`/api/projects/${projectId}/bug-reports?status=open`)).json();
    expect(list.items.map((i: { id: number }) => i.id)).toContain(reportId);
  });

  test('keeps the screenshot of each step that came, and serves it', async ({ request }) => {
    const base = couponBugReport('Step screenshots kept');
    const shot = (step: number) => ({
      step,
      file: `steps/${String(step + 1).padStart(3, '0')}.jpg`,
      box: { x: 10, y: 20, width: 30, height: 40 },
      viewport: { width: 1280, height: 720 },
      takenAt: 1,
    });
    const report = { ...base, evidence: { ...base.evidence, stepShots: [shot(1), shot(2)] } };
    const form = new FormData();
    form.append('report', JSON.stringify(report));
    form.append('stepShot', new Blob([TINY_JPEG], { type: 'image/jpeg' }), '002.jpg');
    const response = await request.post(`/api/projects/${projectId}/bug-reports`, { multipart: form });
    expect(response.status()).toBe(201);
    const { id } = (await response.json()) as { id: number };

    // Only the step whose screenshot came keeps one.
    const stored = await (await request.get(`/api/bug-reports/${id}`)).json();
    expect(stored.evidence.stepShots).toEqual([shot(1)]);
    const image = await request.get(`/api/bug-reports/${id}/step-shots/1`);
    expect(image.headers()['content-type']).toBe('image/jpeg');
    expect(Buffer.from(await image.body()).equals(TINY_JPEG)).toBe(true);
    expect((await request.get(`/api/bug-reports/${id}/step-shots/2`)).status()).toBe(404);

    const notJpeg = new FormData();
    notJpeg.append('report', JSON.stringify(report));
    notJpeg.append('stepShot', new Blob([TINY_PNG], { type: 'image/jpeg' }), '002.jpg');
    expect((await request.post(`/api/projects/${projectId}/bug-reports`, { multipart: notJpeg })).status()).toBe(400);

    // The extension sends step screenshots only to an instance that says it takes them.
    const intake = await (await request.get(`/api/projects/${projectId}/bug-reports/intake`)).json();
    expect(intake.stepShots).toBe(100);
  });

  test('a body that is not a bug report, or a screenshot that is not a PNG, is refused', async ({ request }) => {
    const notSteps = await request.post(`/api/projects/${projectId}/bug-reports`, {
      data: { report: { ...couponBugReport(), steps: { v: 1, steps: 'nope' } } },
    });
    expect(notSteps.status()).toBe(400);
    const notPng = await request.post(`/api/projects/${projectId}/bug-reports`, {
      multipart: {
        report: JSON.stringify(couponBugReport()),
        screenshot: { name: '1-marked.png', mimeType: 'image/png', buffer: Buffer.from('<svg/>') },
      },
    });
    expect(notPng.status()).toBe(400);
  });

  test('renders the spec to commit and the spec to run', async ({ request }) => {
    const commit = await (await request.get(`/api/bug-reports/${reportId}/spec`)).json();
    expect(commit.path).toBe('tests/bugs/coupon-not-applied-to-the-total.spec.ts');
    expect(commit.code).toContain('test.fail()');
    expect(commit.code).toContain(`{ type: 'piwi:bug', description: '${reportId}' }`);
    expect(commit.code).toContain("await page.goto('/cart');");
    expect(commit.code).toContain("toHaveText('Total: 42')");

    const run = await (await request.get(`/api/bug-reports/${reportId}/spec?mode=run`)).json();
    expect(run.code).not.toContain('test.fail()');
  });

  test('says why the suite missed it', async ({ request }) => {
    const missed = await (await request.get(`/api/bug-reports/${reportId}/missed-by`)).json();
    expect(missed.page).toBe('/cart');
    // The submitted runs carry no page data: the visits are unknown, not zero.
    expect(missed.pagesKnown).toBe(false);
    expect(missed.summary).toBe('No run recorded the pages its tests visit, so the tests on /cart are unknown.');
  });

  test('records a reproduction', async ({ request }) => {
    const response = await request.post(`/api/bug-reports/${reportId}/reproductions`, {
      data: { verdict: 'reproduced', origin: 'http://localhost:3000', userAgent: 'Chrome' },
    });
    expect(response.status()).toBe(201);
    const bad = await request.post(`/api/bug-reports/${reportId}/reproductions`, { data: { verdict: 'maybe' } });
    expect(bad.status()).toBe(400);
  });

  test('follows the runs of the test that names it', async ({ request }) => {
    const bugTest = {
      title: 'bug: coupon not applied to the total',
      location: 'tests/bugs/coupon.spec.ts:3:5',
      duration: 50,
    };
    const annotations = (extra: object[] = []) => [{ type: 'piwi:bug', description: String(reportId) }, ...extra];

    // Committed with test.fail(), the bug still there: an expected failure that failed.
    await submitRun(request, [
      { ...bugTest, status: 'passed', expectedStatus: 'failed', testAnnotations: annotations([{ type: 'fail' }]) },
    ]);
    await expect.poll(() => reportStatus(request)).toBe('test-committed');

    // Fixed, still marked test.fail(): looks fixed.
    await submitRun(request, [
      {
        ...bugTest,
        status: 'failed',
        expectedStatus: 'failed',
        error: 'Expected to fail, but passed.',
        testAnnotations: annotations([{ type: 'fail' }]),
      },
    ]);
    await expect.poll(() => reportStatus(request)).toBe('looks-fixed');

    // test.fail() removed, passing: closed.
    await submitRun(request, [
      { ...bugTest, status: 'passed', expectedStatus: 'passed', testAnnotations: annotations() },
    ]);
    await expect.poll(() => reportStatus(request)).toBe('closed');
    const closed = await (await request.get(`/api/bug-reports/${reportId}`)).json();
    expect(closed.test.title).toBe(bugTest.title);

    // Failing again: reopened.
    await submitRun(request, [
      {
        ...bugTest,
        status: 'failed',
        expectedStatus: 'passed',
        error: 'Error: expect(locator).toHaveText(expected)',
        testAnnotations: annotations(),
      },
    ]);
    await expect.poll(() => reportStatus(request)).toBe('test-committed');
  });

  test('shows the report, its evidence and its spec', async ({ page }) => {
    await page.goto(`/projects/${projectId}/bug-reports`);
    await page.getByRole('link', { name: 'Coupon not applied to the total' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Coupon not applied to the total' })).toBeVisible();
    await expect(page.locator('[data-shot="bug-report-claim"]')).toContainText('the page showed "Total: 40"');
    await expect(page.getByText('Expected:')).toBeVisible();
    // A step's address and the value typed stand apart from its words.
    await expect(
      page
        .getByRole('code')
        .filter({ hasText: /\/cart$/ })
        .first(),
    ).toBeVisible();
    await expect(page.getByText('"SPRING10"', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Evidence' }).click();
    await expect(page.getByText('POST /api/cart/coupon')).toBeVisible();
    await expect(page.getByRole('img', { name: 'Screenshot 1' })).toBeVisible();
    // Enlarged, a screenshot names the step it was taken after.
    await page.getByRole('button', { name: 'Enlarge Screenshot 1' }).click();
    const viewer = page.getByRole('dialog', { name: 'Screenshot 1: When a step was marked' });
    await expect(viewer.getByRole('complementary', { name: 'Screenshot details' })).toContainText('After step 4');
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();

    await page.getByRole('button', { name: 'Spec' }).click();
    await expect(page.getByText('tests/bugs/coupon-not-applied-to-the-total.spec.ts')).toBeVisible();
    await expect(page.getByText('piwi:bug').first()).toBeVisible();
  });
});
