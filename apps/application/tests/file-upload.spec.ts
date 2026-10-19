import { test, expect } from './fixtures';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import FormData from 'form-data';
import { PROJECT } from '#shared/test-project-names';

test.describe('File Upload API Tests', () => {
  // fullyParallel can schedule these tests across multiple workers; beforeAll
  // is scoped per-worker, so without serial mode multiple workers could race
  // to write the same fixture files under tempDir.
  test.describe.configure({ mode: 'serial' });

  const tempDir = join(process.cwd(), '.test-temp');

  test.beforeAll(() => {
    // Create temp directory for test files
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    // Create mock HTML report
    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Report</title></head>
        <body><h1>Playwright Test Report</h1></body>
      </html>
    `;
    writeFileSync(join(tempDir, 'test-report.html'), htmlContent);

    // Create a second mock report (monocart-style HTML)
    const monocartContent = `
      <!DOCTYPE html>
      <html>
        <head><title>Monocart Report</title></head>
        <body><h1>Monocart Test Report</h1></body>
      </html>
    `;
    writeFileSync(join(tempDir, 'monocart-report.html'), monocartContent);

    // Create mock trace file (just a text file for testing)
    writeFileSync(join(tempDir, 'trace.zip'), 'Mock trace data');
  });

  test('should upload test results with HTML report (legacy htmlReport field)', async ({ request }) => {
    const form = new FormData();

    form.append('projectName', 'upload-test-project');
    form.append(
      'testRun',
      JSON.stringify({
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 120000,
        totalTests: 3,
        passedTests: 3,
        failedTests: 0,
        skippedTests: 0,
      }),
    );
    form.append(
      'testCases',
      JSON.stringify([
        {
          title: 'test with report',
          status: 'passed',
          duration: 1000,
          location: 'tests/test.spec.ts:10:5',
        },
      ]),
    );

    // Read the file
    const htmlReport = readFileSync(join(tempDir, 'test-report.html'));
    form.append('htmlReport', htmlReport, {
      filename: 'index.html',
      contentType: 'text/html',
    });

    const response = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.UPLOAD_TEST,
        testRun: JSON.stringify({
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 120000,
          totalTests: 3,
          passedTests: 3,
          failedTests: 0,
          skippedTests: 0,
        }),
        testCases: JSON.stringify([
          {
            title: 'test with report',
            status: 'passed',
            duration: 1000,
            location: 'tests/test.spec.ts:10:5',
          },
        ]),
        htmlReport: {
          name: 'index.html',
          mimeType: 'text/html',
          buffer: htmlReport,
        },
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.runId).toBeDefined();
    expect(data.projectId).toBeDefined();
  });

  test('should upload test results with report_html field (new API)', async ({ request }) => {
    const htmlReport = readFileSync(join(tempDir, 'test-report.html'));

    const response = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.MULTI_REPORT,
        testRun: JSON.stringify({
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 60000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
        }),
        testCases: JSON.stringify([
          {
            title: 'report_html test',
            status: 'passed',
            duration: 500,
          },
        ]),
        report_html: {
          name: 'index.html',
          mimeType: 'text/html',
          buffer: htmlReport,
        },
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.runId).toBeDefined();
    // New API returns a reports array
    expect(Array.isArray(data.reports)).toBe(true);
    expect(data.reports.length).toBe(1);
    expect(data.reports[0].type).toBe('html');
    expect(data.reports[0].label).toBe('HTML Report');
    expect(data.reports[0].path).toBeDefined();
  });

  test('should upload test results with multiple report types', async ({ request }) => {
    const htmlReport = readFileSync(join(tempDir, 'test-report.html'));
    const monocartReport = readFileSync(join(tempDir, 'monocart-report.html'));

    const response = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.MULTI_REPORT,
        testRun: JSON.stringify({
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 90000,
          totalTests: 2,
          passedTests: 2,
          failedTests: 0,
          skippedTests: 0,
        }),
        testCases: JSON.stringify([
          { title: 'test one', status: 'passed', duration: 400 },
          { title: 'test two', status: 'passed', duration: 600 },
        ]),
        report_html: {
          name: 'index.html',
          mimeType: 'text/html',
          buffer: htmlReport,
        },
        report_monocart: {
          name: 'index.html',
          mimeType: 'text/html',
          buffer: monocartReport,
        },
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.runId).toBeDefined();
    expect(Array.isArray(data.reports)).toBe(true);
    expect(data.reports.length).toBe(2);

    const types = data.reports.map((r: { type: string }) => r.type);
    expect(types).toContain('html');
    expect(types).toContain('monocart');

    const monocartEntry = data.reports.find((r: { type: string }) => r.type === 'monocart');
    expect(monocartEntry.label).toBe('Monocart Report');
  });

  test('test run details should include reports array', async ({ request }) => {
    // Upload a run with a report
    const htmlReport = readFileSync(join(tempDir, 'test-report.html'));
    const uploadResponse = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.REPORTS_DETAILS,
        testRun: JSON.stringify({
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 30000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
        }),
        testCases: JSON.stringify([{ title: 'check reports', status: 'passed', duration: 200 }]),
        report_html: {
          name: 'index.html',
          mimeType: 'text/html',
          buffer: htmlReport,
        },
      },
    });

    const uploadData = await uploadResponse.json();
    expect(uploadData.runId).toBeDefined();

    // Fetch the test run and verify reports are returned
    const runResponse = await request.get(`/api/test-runs/${uploadData.runId}`);
    expect(runResponse.ok()).toBeTruthy();
    const runData = await runResponse.json();

    expect(Array.isArray(runData.reports)).toBe(true);
    expect(runData.reports.length).toBeGreaterThan(0);
    const htmlEntry = runData.reports.find((r: { type: string }) => r.type === 'html');
    expect(htmlEntry).toBeDefined();
    expect(htmlEntry.label).toBe('HTML Report');
    expect(htmlEntry.path).toBeDefined();
  });

  test('should upload with report_label override', async ({ request }) => {
    const htmlReport = readFileSync(join(tempDir, 'test-report.html'));

    const response = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.LABEL_OVERRIDE,
        testRun: JSON.stringify({
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 30000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
        }),
        testCases: JSON.stringify([{ title: 'label test', status: 'passed', duration: 100 }]),
        report_html: {
          name: 'index.html',
          mimeType: 'text/html',
          buffer: htmlReport,
        },
        report_label_html: 'My Custom HTML Report',
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.reports[0].label).toBe('My Custom HTML Report');
  });

  test('should handle upload without files', async ({ request }) => {
    const response = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.NO_FILES,
        testRun: JSON.stringify({
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 60000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
        }),
        testCases: JSON.stringify([
          {
            title: 'test without files',
            status: 'passed',
            duration: 500,
          },
        ]),
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.success).toBe(true);
    // No reports uploaded → empty array
    expect(Array.isArray(data.reports)).toBe(true);
    expect(data.reports.length).toBe(0);
  });

  test('should reject upload with missing required fields', async ({ request }) => {
    const response = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.INCOMPLETE,
        // Missing testRun and testCases
      },
    });

    expect(response.status()).toBe(400);
  });

  test('should reject upload with malformed JSON', async ({ request }) => {
    const response = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.MALFORMED,
        testRun: '{invalid json}',
        testCases: '[]',
      },
    });

    expect(response.status()).toBe(400);
  });

  test('should download uploaded HTML report', async ({ request }) => {
    // First upload a report
    const uploadResponse = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.DOWNLOAD_TEST,
        testRun: JSON.stringify({
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 60000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
        }),
        testCases: JSON.stringify([
          {
            title: 'download test',
            status: 'passed',
            duration: 500,
          },
        ]),
        htmlReport: {
          name: 'index.html',
          mimeType: 'text/html',
          buffer: readFileSync(join(tempDir, 'test-report.html')),
        },
      },
    });

    const uploadData = await uploadResponse.json();
    expect(Array.isArray(uploadData.reports)).toBe(true);
    expect(uploadData.reports.length).toBeGreaterThan(0);

    // Try to download the report
    const firstReport = uploadData.reports[0];
    if (firstReport?.path) {
      const downloadResponse = await request.get(`/api/files/${firstReport.path}`);

      expect(downloadResponse.ok()).toBeTruthy();
      expect(downloadResponse.headers()['content-type']).toContain('text/html');
    }
  });

  test('renders an HTML report with opaque-origin storage isolation', async ({ request, page }) => {
    const htmlReport = Buffer.from(`
      <!doctype html>
      <html>
        <head><title>Sandboxed report</title></head>
        <body>
          <h1>Sandboxed report</h1>
          <script>
            window.addEventListener('focus', (event) => event.target.document.nodeType);
            window.onload = () => {
              document.body.dataset.reportReady = localStorage.getItem('piwi-report-isolation') || 'ready';
            };
          </script>
        </body>
      </html>
    `);

    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('piwi-report-isolation', 'dashboard-value'));

    const uploadResponse = await request.post('/api/test-runs/upload', {
      multipart: {
        projectName: PROJECT.HTML_REPORT_SANDBOX,
        testRun: JSON.stringify({
          status: 'passed',
          startTime: new Date().toISOString(),
          duration: 1000,
          totalTests: 1,
          passedTests: 1,
          failedTests: 0,
          skippedTests: 0,
        }),
        testCases: JSON.stringify([{ title: 'sandboxed report', status: 'passed', duration: 100 }]),
        htmlReport: {
          name: 'index.html',
          mimeType: 'text/html',
          buffer: htmlReport,
        },
      },
    });
    if (!uploadResponse.ok()) {
      throw new Error(`Report upload failed with ${uploadResponse.status()}: ${await uploadResponse.text()}`);
    }

    const uploadData = await uploadResponse.json();
    const reportPath = uploadData.reports?.[0]?.path;
    expect(reportPath).toBeDefined();

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const reportResponse = await page.goto(`/api/files/${reportPath}`);
    expect(reportResponse?.headers()['content-security-policy']).toBe('sandbox allow-scripts');
    expect(reportResponse?.headers()['x-frame-options']).toBe('SAMEORIGIN');

    await expect(page.locator('h1')).toHaveText('Sandboxed report');
    await expect(page.locator('body')).toHaveAttribute('data-report-ready', 'ready');

    const isolation = await page.evaluate(() => ({
      cookie: (() => {
        try {
          return document.cookie;
        } catch (error) {
          return error instanceof DOMException ? error.name : 'blocked';
        }
      })(),
      storedDashboardValue: localStorage.getItem('piwi-report-isolation'),
    }));
    expect(isolation.cookie).toBe('SecurityError');
    expect(isolation.storedDashboardValue).toBeNull();
    expect(
      pageErrors.some((message) =>
        /Failed to read a named property|Failed to read the 'localStorage' property/.test(message),
      ),
    ).toBe(false);
  });

  test('should prevent path traversal in file download', async ({ request }) => {
    const response = await request.get('/api/files/../../../etc/passwd');
    expect(response.status()).toBeGreaterThan(400);
  });

  test('should return 404 for non-existent files', async ({ request }) => {
    const response = await request.get('/api/files/project-999/nonexistent.html');
    expect(response.status()).toBe(404);
  });
});
