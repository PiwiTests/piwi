import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

/** Submit one run of the external IDs project with the given tests, all passed. */
async function submit(
  request: import('@playwright/test').APIRequestContext,
  testCases: Array<{ title: string; location: string; externalId?: string | null; displayTitle?: string | null }>,
): Promise<number> {
  const res = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.EXTERNAL_IDS,
      status: 'passed',
      startTime: new Date().toISOString(),
      duration: 1000,
      totalTests: testCases.length,
      passedTests: testCases.length,
      failedTests: 0,
      skippedTests: 0,
      testCases: testCases.map((tc) => ({ ...tc, status: 'passed', duration: 100, retries: 0 })),
    },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).runId;
}

async function runCases(request: import('@playwright/test').APIRequestContext, runId: number) {
  const res = await request.get(`/api/test-runs/${runId}`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

test.describe.serial('External test IDs', () => {
  let renamedRunId: number;
  let testCaseId: number;

  test('a test renamed and moved keeps its history when its external ID matches', async ({ request }) => {
    const firstRunId = await submit(request, [
      {
        title: '12526, Log in modal: Log in with Email',
        location: 'tests/login.spec.ts:4:1',
        externalId: '12526',
        displayTitle: 'Log in modal: Log in with Email',
      },
    ]);
    renamedRunId = await submit(request, [
      { title: '12526, Log in', location: 'tests/auth/login.spec.ts:9:1', externalId: '12526', displayTitle: 'Log in' },
    ]);

    const before = (await runCases(request, firstRunId)).testCases[0];
    const after = (await runCases(request, renamedRunId)).testCases[0];
    expect(after.testCaseId).toBe(before.testCaseId);
    testCaseId = after.testCaseId;
    expect(after).toMatchObject({
      title: '12526, Log in',
      displayTitle: 'Log in',
      externalId: '12526',
      filePath: 'tests/auth/login.spec.ts',
    });
  });

  test('the test page shows the ID before the title without it', async ({ page }) => {
    await page.goto(`/test-cases/${testCaseId}`);
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading.getByTestId('test-id-chip')).toHaveText('12526');
    await expect(heading).toHaveText(/^\s*12526\s*Log in\s*$/);
  });

  test('two tests sharing an ID are listed on the run and matched by title', async ({ request, page }) => {
    const runId = await submit(request, [
      { title: 'Sign up', location: 'tests/signup.spec.ts:3:1', externalId: '900' },
      { title: 'Sign out', location: 'tests/signout.spec.ts:3:1', externalId: '900' },
    ]);
    const run = await runCases(request, runId);
    const [first, second] = run.testCases;
    expect(first.testCaseId).not.toBe(second.testCaseId);
    expect(run.metadata.externalIdDuplicates).toEqual([
      expect.objectContaining({ externalId: '900', tests: expect.any(Array) }),
    ]);

    await page.goto(`/test-runs/${runId}`);
    await expect(page.getByTestId('run-external-id-duplicates-fact')).toHaveText('1 duplicate test ID');
  });
});
