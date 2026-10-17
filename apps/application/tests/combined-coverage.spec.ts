/**
 * Combined coverage end to end: a run of a commit records its run coverage,
 * a unit-test report of the same commit is uploaded, and the project's
 * coverage page, the run's header and the file view count both on the run's
 * executable lines.
 */
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

const COMMIT = 'c0ffee'.padEnd(40, '0');
const BLOB = 'a'.repeat(40);
const OTHER_BLOB = 'b'.repeat(40);

test('combines a uploaded unit report with the commit’s run coverage', async ({ page, request }) => {
  const submitted = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.COMBINED_COVERAGE,
      status: 'passed',
      startTime: new Date(Date.now() - 60_000).toISOString(),
      duration: 1000,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      metadata: { scm: { commit: COMMIT, branch: 'main' }, ci: { provider: 'GitHub Actions' } },
      testCases: [{ title: 'pays', status: 'passed', duration: 10, location: 'tests/pay.spec.ts:1:1' }],
    },
  });
  expect(submitted.ok()).toBeTruthy();
  const { projectId, runId } = (await submitted.json()) as { projectId: number; runId: number };

  // The backend's run coverage: lines 6-7 ran, its span table counts 2-4 and 6-8.
  const runCoverage = await request.put(`/api/test-runs/${runId}/coverage`, {
    data: {
      v: 1,
      files: [
        {
          path: 'src/Shop.cs',
          runtime: 'server',
          blob: BLOB,
          lines: [[6, 7]],
          executable: [
            [2, 4],
            [6, 8],
          ],
        },
      ],
    },
  });
  expect(runCoverage.ok()).toBeTruthy();

  // The unit tool counts braces on lines 1, 5 and 9 too: they do not count.
  const uploaded = await request.post(`/api/projects/${projectId}/coverage-reports`, {
    data: {
      v: 1,
      commit: COMMIT,
      branch: 'main',
      suite: 'unit-back',
      tool: 'cobertura',
      inventory: [
        ['src/Shop.cs', BLOB],
        ['src/Idle.cs', OTHER_BLOB],
      ],
      files: [{ path: 'src/Shop.cs', blob: BLOB, executable: [[1, 9]], lines: [[1, 5]] }],
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  expect(
    (
      await request.post(`/api/projects/${projectId}/coverage-reports`, {
        data: { v: 1, commit: COMMIT, suite: 'e2e', files: [] },
      })
    ).status(),
  ).toBe(400);

  const summary = await request.get(`/api/projects/${projectId}/coverage-summary`);
  expect(summary.ok()).toBeTruthy();
  expect(await summary.json()).toMatchObject({
    commit: COMMIT,
    totals: { executableLines: 6, executedLines: 5, linePercent: 83.3 },
    suites: [
      { name: 'unit-back', executedLines: 3 },
      { name: 'e2e', executedLines: 2 },
    ],
    filesWithoutData: { count: 1, paths: ['src/Idle.cs'] },
  });

  // The export writes the same lines: the span table's, hit when either suite ran them.
  const lcov = await request.get(`/api/projects/${projectId}/coverage-export?format=lcov`);
  expect(lcov.ok()).toBeTruthy();
  expect(lcov.headers()['content-disposition']).toContain(`piwi-coverage-${COMMIT.slice(0, 12)}.info`);
  expect(await lcov.text()).toContain(
    'SF:src/Shop.cs\nFNF:0\nFNH:0\nDA:2,1\nDA:3,1\nDA:4,1\nDA:6,1\nDA:7,1\nDA:8,0\nLF:6\nLH:5',
  );

  await page.goto(`/projects/${projectId}/coverage`);
  await expect(page.getByTestId('coverage-totals')).toContainText('83.3% of 6 executable lines ran, across 2 suites.');
  await expect(page.getByTestId('coverage-suites').locator('[data-suite]')).toHaveCount(2);
  await page.getByRole('link', { name: 'src/' }).click();
  await expect(page).toHaveURL(/folder=src/);
  await expect(page.locator('[data-entry="src/Shop.cs"]')).toContainText('83.3%');

  await page.goto(`/test-runs/${runId}`);
  await expect(page.getByTestId('run-coverage-fact')).toHaveText(/Coverage 83\.3% of 6 lines\s*· 2 suites/);
});
