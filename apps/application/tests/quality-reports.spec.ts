/**
 * Quality reports:
 *   GET /api/reports/preview — the report bundle as JSON, and every download format
 *   Quality report on /analytics — the preview dialog, the dashboard and language pickers, a download
 *   Settings → Performance    — the cost of a CI minute, shown with the wasted minutes
 *   MCP get_quality_report    — the bundle over the same scope
 */
import readXlsxFile from 'read-excel-file/node';
import { strFromU8, unzipSync } from 'fflate';
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import type { ReportBundle } from '#shared/reports/types';

let projectId: number;

test.beforeAll(async ({ request }) => {
  // `=1+1` fails in the second run and passes on a retry in the third: a flaky test whose title looks like a formula.
  const submit = (status: string, passed: number, failed: number, secondsAgo: number, retries = 0) =>
    request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.QUALITY_REPORT,
        status,
        startTime: new Date(Date.now() - secondsAgo * 1000).toISOString(),
        duration: 30_000,
        totalTests: passed + failed,
        passedTests: passed,
        failedTests: failed,
        skippedTests: 0,
        testCases: [
          { title: 'checkout pays', status: 'passed', duration: 500, location: 'tests/pay.spec.ts:1:1' },
          {
            title: '=1+1',
            status: failed > 0 ? 'failed' : 'passed',
            duration: 900,
            location: 'tests/formula.spec.ts:3:1',
            retries,
            ...(failed > 0 ? { error: 'Error: =1+1 should equal 3' } : {}),
          },
        ],
      },
    });
  const first = await submit('passed', 2, 0, 180);
  expect(first.ok()).toBeTruthy();
  projectId = (await first.json()).projectId;
  expect((await submit('failed', 1, 1, 120)).ok()).toBeTruthy();
  expect((await submit('passed', 2, 0, 60, 1)).ok()).toBeTruthy();
});

/**
 * The page is server-rendered, and on a dev server hydration can lag the first
 * paint, so a click fired at once is lost before its handler is attached.
 * Retry it until the dialog shows.
 */
async function openReport(page: import('@playwright/test').Page) {
  const preview = page.getByTestId('report-view');
  await expect(async () => {
    if (!(await preview.isVisible()))
      await page.getByRole('button', { name: 'Quality report', exact: true }).first().click();
    await expect(preview).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  return preview;
}

const scope = () => `projects=${projectId}&period=last-7d`;

test.describe('Quality report API', () => {
  test('the preview is the bundle: a verdict, the tiles, the trend and a footer', async ({ request }) => {
    const res = await request.get(`/api/reports/preview?${scope()}`);
    expect(res.ok()).toBeTruthy();
    const bundle: ReportBundle = await res.json();
    expect(bundle.dashboard.ref).toBe('executive');
    expect(bundle.title).toBe(`${PROJECT.QUALITY_REPORT}, Last 7 days`);
    expect(bundle.scopeText.projects).toBe(PROJECT.QUALITY_REPORT);
    const stats = await (
      await request.get(`/api/widgets/stats?${scope()}&options=${encodeURIComponent('{"metrics":["test-pass-rate"]}')}`)
    ).json();
    expect(stats.tiles[0].value).toBeLessThan(100);
    expect(bundle.verdict.sentence).toContain(`${stats.tiles[0].value}%`);
    const types = bundle.bands.flatMap((b) => b.widgets.map((w) => w.type));
    expect(types).toEqual(['verdict', 'stats', 'metric', 'insights', 'progress', 'risks']);
    expect(bundle.definitions.map((d) => d.id)).toContain('test-pass-rate');
  });

  test('every format downloads with its content type and file name', async ({ request }) => {
    const expected: Record<string, RegExp> = {
      html: /^text\/html/,
      pdf: /^application\/pdf/,
      md: /^text\/markdown/,
      csv: /^text\/csv/,
      xlsx: /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/,
    };
    for (const [format, type] of Object.entries(expected)) {
      const res = await request.get(`/api/reports/preview?${scope()}&dashboard=engineering&format=${format}`);
      expect(res.ok(), format).toBeTruthy();
      expect(res.headers()['content-type']).toMatch(type);
      expect(res.headers()['content-disposition']).toMatch(
        new RegExp(`attachment; filename="piwi-quality-report-engineering-\\d{4}-\\d{2}-\\d{2}\\.${format}"`),
      );
    }
    const pdf = await request.get(`/api/reports/preview?${scope()}&format=pdf`);
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('a test titled =1+1 is inert in the CSV', async ({ request }) => {
    const res = await request.get(`/api/reports/preview?${scope()}&dashboard=engineering&format=csv`);
    const csv = await res.text();
    expect(csv).toContain("'=1+1");
    expect(csv).not.toMatch(/(^|,)=1\+1/m);
  });

  test('a test titled =1+1 is a text cell in the Excel workbook, never a formula', async ({ request }) => {
    const res = await request.get(`/api/reports/preview?${scope()}&dashboard=engineering&format=xlsx`);
    expect(res.ok()).toBeTruthy();
    const bytes = await res.body();
    const sheets = await readXlsxFile(bytes);
    const cells = sheets.flatMap((sheet) => sheet.data.flat());
    expect(cells).toContain('=1+1');
    const files = unzipSync(new Uint8Array(bytes));
    for (const [name, file] of Object.entries(files)) {
      if (name.startsWith('xl/worksheets/sheet')) expect(strFromU8(file), name).not.toContain('<f>');
    }
  });

  test('a French report translates the labels', async ({ request }) => {
    const bundle: ReportBundle = await (await request.get(`/api/reports/preview?${scope()}&lang=fr`)).json();
    expect(bundle.language).toBe('fr');
    expect(bundle.bands[0]!.title).toBe('Où en sont les choses');
    expect(bundle.verdict.sentence).toMatch(/\d+(,\d)?\s%/u);
  });

  test('an unknown dashboard or format is a 400', async ({ request }) => {
    expect((await request.get('/api/reports/preview?dashboard=nope')).status()).toBe(400);
    expect((await request.get('/api/reports/preview?format=docx')).status()).toBe(400);
  });

  test('MCP get_quality_report returns the same bundle', async ({ request }) => {
    const res = await request.post('/mcp', {
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_quality_report', arguments: { projectIds: [projectId], period: 'last-7d' } },
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const bundle = JSON.parse(body.result.content[0].text) as ReportBundle;
    const preview: ReportBundle = await (await request.get(`/api/reports/preview?${scope()}`)).json();
    expect(bundle.scopeText.projects).toBe(PROJECT.QUALITY_REPORT);
    expect(bundle.verdict.sentence).toBe(preview.verdict.sentence);
  });
});

test.describe('Quality report on the analytics page', () => {
  test('previews the scope as a quality report and downloads it', async ({ page, request }) => {
    const bundle: ReportBundle = await (await request.get(`/api/reports/preview?${scope()}`)).json();
    await page.goto(`/analytics?${scope()}`);
    const preview = await openReport(page);
    // The in-app view states the facts of the bundle the downloads render.
    await expect(preview.getByText(bundle.verdict.sentence.split(':')[0]!)).toBeVisible();
    const stats = bundle.bands[0]!.widgets[1]!.blocks[0]!;
    if (stats.kind !== 'stats') throw new Error('stats block expected');
    for (const tile of stats.tiles) await expect(preview.getByText(tile.value, { exact: true }).first()).toBeVisible();
    for (const band of bundle.bands)
      await expect(preview.getByRole('heading', { name: band.title }).first()).toBeVisible();

    await page.getByTestId('report-dashboard').click();
    await page.getByRole('option', { name: 'Engineering' }).click();
    await expect(preview.getByRole('heading', { name: 'Where the pain is' })).toBeVisible();

    await page.getByTestId('report-language').click();
    await page.getByRole('option', { name: 'Français' }).click();
    await expect(preview.getByRole('heading', { name: 'Où en sont les choses' })).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByTestId('report-download').click();
    await page.getByRole('menuitem', { name: 'PDF' }).click();
    expect((await download).suggestedFilename()).toMatch(/^piwi-quality-report-engineering-.*\.pdf$/);

    const workbook = page.waitForEvent('download');
    await page.getByTestId('report-download').click();
    await page.getByRole('menuitem', { name: 'Excel' }).click();
    expect((await workbook).suggestedFilename()).toMatch(/^piwi-quality-report-engineering-.*\.xlsx$/);
  });

  test('each section of the preview downloads as its own Excel workbook', async ({ page }) => {
    await page.goto(`/analytics?${scope()}`);
    const preview = await openReport(page);
    await page.getByTestId('report-dashboard').click();
    await page.getByRole('option', { name: 'Engineering' }).click();
    await expect(preview.getByRole('heading', { name: 'Where the pain is' })).toBeVisible();

    const button = preview.locator('[data-testid^="report-section-xlsx-"]').first();
    await expect(button).toHaveText('Excel');
    const download = page.waitForEvent('download');
    await button.click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^piwi-quality-report-engineering-\d{4}-\d{2}-\d{2}-.+\.xlsx$/);
    const sheets = await readXlsxFile(await file.path());
    expect(sheets.length).toBeGreaterThan(0);
    // The header row, then at least one row of data.
    expect(sheets[0]!.data.length).toBeGreaterThan(1);
  });

  test('the project page offers a quality report of that project', async ({ page }) => {
    await page.goto(`/projects/${projectId}`);
    const preview = await openReport(page);
    await expect(preview.getByText(`${PROJECT.QUALITY_REPORT}, Last 30 days`)).toBeVisible();
  });
});

test.describe.serial('Cost of a CI minute', () => {
  test.afterAll(async ({ request }) => {
    await request.put('/api/settings/ci-cost', { data: { cost: null } });
  });

  test('is set in Settings → Performance and prices the wasted minutes', async ({ page, request }) => {
    await page.goto('/settings/performance');
    // Retry until the save lands: before hydration the inputs and the button are inert.
    await expect(async () => {
      await page.getByTestId('ci-cost-amount').fill('0.5');
      await page.getByTestId('ci-cost-currency').fill('EUR');
      await page.getByRole('button', { name: 'Save' }).last().click();
      const saved = await (await request.get('/api/settings/ci-cost')).json();
      expect(saved).toEqual({ cost: { amount: 0.5, currency: 'EUR' }, envManaged: false });
    }).toPass({ timeout: 60_000 });

    const stats = await (
      await request.get(
        `/api/widgets/stats?${scope()}&options=${encodeURIComponent('{"metrics":["wasted-ci-minutes"]}')}`,
      )
    ).json();
    expect(stats.tiles[0].companion).toMatchObject({ metric: 'wasted-ci-cost', currency: 'EUR' });
  });

  test('refuses a cost without a currency', async ({ request }) => {
    const res = await request.put('/api/settings/ci-cost', { data: { cost: { amount: 1 } } });
    expect(res.status()).toBe(400);
  });
});
