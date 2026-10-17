/**
 * Combined coverage end to end: a run of a commit records its run coverage
 * and its test's coverage, a unit-test report of the same commit is uploaded,
 * and the project's coverage page, the run's header and the file view count
 * both on the run's executable lines. The overview stays in place while it
 * reads another folder, a file opened from it reads its tests' coverage, the
 * links keep the pinned commit and the area, and a line is selected from the
 * keyboard. On a branch, a newer push supersedes an earlier one's report: the
 * earlier commit keeps only its totals, and the notes above the numbers say
 * so, and which suite the newer push carries from it. A run whose backend
 * restarted is flagged on its page, and its commit's notes name it.
 */
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

const COMMIT = 'c0ffee'.padEnd(40, '0');
const BLOB = 'a'.repeat(40);
const OTHER_BLOB = 'b'.repeat(40);
/** `src/Shop.cs` at `BLOB`: nine lines. */
const SOURCE = Array.from({ length: 9 }, (_, i) => `// line ${i + 1}`).join('\n');

test('combines a uploaded unit report with the commit’s run coverage', async ({ page, request }) => {
  test.setTimeout(90_000);
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
      testCases: [
        {
          title: 'pays',
          status: 'passed',
          duration: 10,
          location: 'tests/pay.spec.ts:1:1',
          // The test's own coverage: the project records test coverage, which the file view reads.
          coverage: { v: 1, files: [{ path: 'src/Shop.cs', runtime: 'server', blob: BLOB, lines: [[6, 7]] }] },
        },
      ],
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

  await page.route(
    (url) => url.pathname.endsWith(`/projects/${projectId}/source`) && url.searchParams.get('blob') === BLOB,
    (route) => route.fulfill({ json: { path: 'src/Shop.cs', blob: BLOB, content: SOURCE } }),
  );
  await page.goto(`/projects/${projectId}/coverage`);
  // The first visit compiles the page on a dev server: give it time.
  await expect(page.getByTestId('coverage-totals')).toContainText('83.3% of 6 executable lines ran, across 2 suites.', {
    timeout: 30_000,
  });
  await expect(page.locator('[data-area="api"]')).toContainText('83.3%');
  await expect(page.locator('[data-area="api"]')).toContainText('unit-back 50.0% · e2e 33.3%');
  await expect(page.getByTestId('coverage-suites').locator('[data-suite]')).toHaveCount(2);
  // Another folder is read in place: the tree is the same element after the read.
  const tree = page.getByTestId('coverage-tree');
  await tree.evaluate((el) => el.setAttribute('data-kept', ''));
  await tree.getByRole('button', { name: 'src/', exact: true }).click();
  await expect(page).toHaveURL(/folder=src/);
  await expect(page.locator('[data-entry="src/Shop.cs"]')).toContainText('83.3%');
  await expect(page.getByTestId('coverage-folder-totals')).toContainText('of 6 lines ran');
  await expect(tree).toHaveAttribute('data-kept', '');
  // The tree shows the file no suite names, greyed, and the folder's suites beside it.
  await expect(page.locator('[data-entry="src/Idle.cs"]')).toContainText('no coverage data');
  await expect(page.getByTestId('coverage-folder-totals')).toHaveText('83.3% of 6 lines ran · 1 no suite ran.');

  // Line 8 ran in no suite: the file leads the least-covered list, and its view steps to that gap.
  // Opened from the overview, the file view reads the test's coverage of the file too.
  await expect(page.locator('[data-least-covered="src/Shop.cs"]')).toContainText('1 line no suite ran');
  await page.locator('[data-least-covered="src/Shop.cs"]').getByRole('link').click();
  await expect(page).toHaveURL(/marks=suites/);
  await expect(page.getByTestId('coverage-file-summary')).toContainText('1 test', { timeout: 15_000 });
  await expect(page.getByTestId('coverage-file-marks')).toBeVisible();
  await expect(page.getByTestId('coverage-file-gaps')).toContainText('1 gap: 1 line.');
  await page.getByTestId('coverage-gap-next').click();
  await expect(page.getByTestId('coverage-file-gaps')).toContainText('Gap 1 of 1 · line 8');
  await expect(page.getByTestId('coverage-file-combined')).toContainText('No suite ran line 8.');

  // Each line number is a button naming the line's class: Enter selects it.
  await page.getByRole('button', { name: 'Line 3: Unit only', exact: true }).press('Enter');
  await expect(page.getByTestId('coverage-file-combined')).toContainText('Line 3 ran in unit-back.');
  await expect(page.getByRole('button', { name: 'Line 6: End to end only', exact: true })).toBeVisible();

  // A pinned commit and an area stay through the links: to a file, and back to its folder.
  await page.goto(`/projects/${projectId}/coverage?commit=${COMMIT}&area=api`);
  await expect(page.locator('[data-area="api"]').getByRole('link')).toHaveAttribute('aria-current', 'true', {
    timeout: 30_000,
  });
  await expect(page.locator('[data-entry="src/Shop.cs"]').getByRole('link')).toHaveAttribute(
    'href',
    new RegExp(`commit=${COMMIT}.*area=api`),
  );
  await page.locator('[data-least-covered="src/Shop.cs"]').getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`commit=${COMMIT}.*area=api.*file=src(/|%2F)Shop\\.cs`));
  await page.getByRole('navigation', { name: 'Folder' }).getByRole('link', { name: 'src', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`commit=${COMMIT}.*area=api.*folder=src`));
  await expect(page.getByTestId('coverage-folder-totals')).toContainText('of 6 lines ran');

  // The open folders saved in this browser stay open beside the selected folder's parents.
  const key = `piwi-coverage-tree-${projectId}`;
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify(['docs'])), key);
  await page.reload();
  await expect(page.locator('[data-entry="src/Shop.cs"]')).toBeVisible({ timeout: 30_000 });
  expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), key)) ?? '[]')).toEqual(['docs', 'src']);

  await page.goto(`/test-runs/${runId}`);
  await expect(page.getByTestId('run-coverage-fact')).toHaveText(/Coverage 83\.3% of 6 lines\s*· 2 suites/, {
    timeout: 30_000,
  });
});

test('keeps only the totals of a branch push a newer one superseded, and says what the numbers leave out', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const BRANCH = 'feature/notes';
  const FIRST = 'feed01'.padEnd(40, '0');
  const SECOND = 'feed02'.padEnd(40, '0');
  const submitted = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.COMBINED_COVERAGE_NOTES,
      status: 'passed',
      startTime: new Date(Date.now() - 60_000).toISOString(),
      duration: 1000,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      metadata: { scm: { commit: FIRST, branch: BRANCH }, ci: { provider: 'GitHub Actions' } },
      testCases: [{ title: 'pays', status: 'passed', duration: 10, location: 'tests/pay.spec.ts:1:1' }],
    },
  });
  expect(submitted.ok()).toBeTruthy();
  const { projectId, runId } = (await submitted.json()) as { projectId: number; runId: number };
  // The project's only runs are on the branch: name its default branch, or the branch would read as the default.
  expect((await request.patch(`/api/projects/${projectId}`, { data: { defaultBranch: 'main' } })).ok()).toBeTruthy();

  const report = (commit: string, suite: string, path: string, blob: string, lines: number[][]) =>
    request.post(`/api/projects/${projectId}/coverage-reports`, {
      data: {
        v: 1,
        commit,
        branch: BRANCH,
        suite,
        inventory: [
          ['src/Pay.cs', BLOB],
          ['src/pay.ts', OTHER_BLOB],
        ],
        files: [{ path, blob, executable: [[1, 9]], lines }],
      },
    });
  // The first push uploads both suites, the second the back end's only.
  expect((await report(FIRST, 'unit-back', 'src/Pay.cs', BLOB, [[1, 4]])).ok()).toBeTruthy();
  expect((await report(FIRST, 'unit-front', 'src/pay.ts', OTHER_BLOB, [[1, 3]])).ok()).toBeTruthy();
  // A report's time is kept to the second: the second push arrives a second later, so it carries from the first.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect((await report(SECOND, 'unit-back', 'src/Pay.cs', BLOB, [[1, 6]])).ok()).toBeTruthy();

  // Once both commits' totals are stored, the first keeps only its totals.
  const firstSummary = async () =>
    (await (await request.get(`/api/projects/${projectId}/coverage-summary?commit=${FIRST}`)).json()) as {
      detailRemoved: { supersededBy: string | null } | null;
      totals: { executedLines: number };
      entries: unknown[];
    };
  await expect
    .poll(async () => (await firstSummary()).detailRemoved?.supersededBy ?? null, { timeout: 30_000 })
    .toBe(SECOND);
  expect(await firstSummary()).toMatchObject({ totals: { executedLines: 7 }, entries: [] });
  expect((await request.get(`/api/projects/${projectId}/coverage-tree?commit=${FIRST}`)).status()).toBe(410);
  expect((await request.get(`/api/projects/${projectId}/coverage-export?commit=${FIRST}`)).status()).toBe(410);
  // A CI job of the first push run again: accepted, and kept out of its totals.
  const late = await report(FIRST, 'unit-back', 'src/Pay.cs', BLOB, [[1, 9]]);
  expect(late.ok()).toBeTruthy();
  expect(await late.json()).toMatchObject({ superseded: { by: SECOND } });
  expect((await firstSummary()).totals.executedLines).toBe(7);

  // The branch's newest push carries the front end's suite from the first.
  await page.goto(`/projects/${projectId}/coverage?branch=${encodeURIComponent(BRANCH)}`);
  const notes = page.getByTestId('coverage-notes');
  await expect(notes.locator('[data-note="carried"]')).toHaveText(
    'unit-front: 1 file carried from feed010, an earlier commit.',
    { timeout: 30_000 },
  );
  await notes.getByRole('link', { name: 'feed010' }).click();
  await expect(page).toHaveURL(new RegExp(`commit=${FIRST}`));
  await expect(page.getByTestId('coverage-notes').locator('[data-note="detail-removed"]')).toHaveText(
    `Only this commit’s totals are kept: its file detail went when feed020 arrived on ${BRANCH}.`,
  );
  await expect(page.getByTestId('coverage-totals')).toContainText('across 2 suites');
  await expect(page.getByTestId('coverage-files-removed')).toContainText('No file of this commit is kept');
  await expect(page.getByTestId('coverage-tree')).toHaveCount(0);
  await expect(page.getByTestId('coverage-export')).toHaveCount(0);

  // The run of the first push says its commit's coverage is totals only.
  await page.goto(`/test-runs/${runId}`);
  await expect(page.getByTestId('run-coverage-fact')).toContainText('totals only', { timeout: 30_000 });
});

test('flags a run whose backend restarted, and notes it in its commit’s coverage', async ({ page, request }) => {
  test.setTimeout(90_000);
  const RESTART_COMMIT = 'dead01'.padEnd(40, '0');
  const submitted = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.COMBINED_COVERAGE_RESTART,
      status: 'passed',
      startTime: new Date(Date.now() - 60_000).toISOString(),
      duration: 1000,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      metadata: { scm: { commit: RESTART_COMMIT, branch: 'main' }, ci: { provider: 'GitHub Actions' } },
      testCases: [{ title: 'pays', status: 'passed', duration: 10, location: 'tests/pay.spec.ts:1:1' }],
    },
  });
  expect(submitted.ok()).toBeTruthy();
  const { projectId, runId } = (await submitted.json()) as { projectId: number; runId: number };

  // The reporter's run coverage: the lines the tests ran, and the backend that restarted meanwhile.
  const put = await request.put(`/api/test-runs/${runId}/coverage`, {
    data: {
      v: 1,
      files: [{ path: 'src/Shop.cs', runtime: 'server', blob: BLOB, lines: [[2, 3]], executable: [[2, 8]] }],
      incomplete: [{ origin: 'http://localhost:5080', reason: 'restarted', at: new Date().toISOString() }],
    },
  });
  expect(put.ok()).toBeTruthy();
  const coverage = (await (await request.get(`/api/test-runs/${runId}/coverage?limit=0`)).json()) as {
    incomplete: Array<{ origin: string; reason: string }>;
  };
  expect(coverage.incomplete).toMatchObject([{ origin: 'http://localhost:5080', reason: 'restarted' }]);

  await page.goto(`/test-runs/${runId}`);
  await expect(page.getByTestId('run-coverage-incomplete')).toHaveText(
    'Coverage incomplete: the backend restarted during the run',
    { timeout: 30_000 },
  );

  await page.goto(`/projects/${projectId}/coverage?commit=${RESTART_COMMIT}`);
  const note = page.getByTestId('coverage-notes').locator('[data-note="runs-incomplete"]');
  await expect(note).toContainText(`e2e: incomplete: the backend restarted during run #${runId}.`, {
    timeout: 30_000,
  });
  await note.getByRole('link', { name: `#${runId}` }).click();
  await expect(page).toHaveURL(new RegExp(`/test-runs/${runId}$`));
});
