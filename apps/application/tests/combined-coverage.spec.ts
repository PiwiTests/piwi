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

  // An area of the code counts apart: every file here is under src/.
  const patched = await request.patch(`/api/projects/${projectId}`, {
    data: { coverageAreas: [{ name: 'api', include: ['src/'] }] },
  });
  expect(patched.ok()).toBeTruthy();
  expect(
    (
      await request.patch(`/api/projects/${projectId}`, { data: { coverageAreas: [{ name: 'api', include: [] }] } })
    ).status(),
  ).toBe(400);

  await page.goto(`/projects/${projectId}/coverage`);
  // The first visit compiles the page on a dev server: give it time.
  await expect(page.getByTestId('coverage-totals')).toContainText('83.3% of 6 executable lines ran, across 2 suites.', {
    timeout: 30_000,
  });
  await expect(page.locator('[data-area="api"]')).toContainText('83.3%');
  await expect(page.locator('[data-area="api"]')).toContainText('unit-back 50.0% · e2e 33.3%');
  await expect(page.getByTestId('coverage-suites').locator('[data-suite]')).toHaveCount(2);
  await page.getByTestId('coverage-tree').getByRole('button', { name: 'src/', exact: true }).click();
  await expect(page).toHaveURL(/folder=src/);
  await expect(page.locator('[data-entry="src/Shop.cs"]')).toContainText('83.3%');
  // The tree shows the file no suite names, greyed, and the folder's suites beside it.
  await expect(page.locator('[data-entry="src/Idle.cs"]')).toContainText('no coverage data');
  await expect(page.getByTestId('coverage-folder-totals')).toHaveText('83.3% of 6 lines ran · 1 no suite ran.');

  // Line 8 ran in no suite: the file leads the least-covered list, and its view steps to that gap.
  await expect(page.locator('[data-least-covered="src/Shop.cs"]')).toContainText('1 line no suite ran');
  await page.locator('[data-least-covered="src/Shop.cs"]').getByRole('link').click();
  await expect(page).toHaveURL(/marks=suites/);
  await expect(page.getByTestId('coverage-file-gaps')).toContainText('1 gap: 1 line.');
  await page.getByTestId('coverage-gap-next').click();
  await expect(page.getByTestId('coverage-file-gaps')).toContainText('Gap 1 of 1 · line 8');
  await expect(page.getByTestId('coverage-file-combined')).toContainText('No suite ran line 8.');

  await page.goto(`/test-runs/${runId}`);
  await expect(page.getByTestId('run-coverage-fact')).toHaveText(/Coverage 83\.3% of 6 lines\s*· 2 suites/, {
    timeout: 30_000,
  });
});
