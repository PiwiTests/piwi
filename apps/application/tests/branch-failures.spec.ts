import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

/**
 * The latest run on a branch and its failures, as editors read them for their
 * Problems panel and status bar.
 */

function run(minutes: number, branch: string, cases: Array<{ title: string; status: string; error?: string }>) {
  const failed = cases.filter((c) => c.status === 'failed').length;
  return {
    projectName: PROJECT.BRANCH_FAILURES,
    status: failed ? 'failed' : 'passed',
    startTime: new Date(Date.UTC(2026, 8, 3, 10, minutes)).toISOString(),
    duration: 1000,
    totalTests: cases.length,
    passedTests: cases.length - failed,
    failedTests: failed,
    skippedTests: 0,
    metadata: { scm: { branch } },
    testCases: cases.map((c, i) => ({
      title: c.title,
      status: c.status,
      duration: 100,
      location: `tests/checkout.spec.ts:${10 + i}:1`,
      retries: 0,
      error: c.error,
    })),
  };
}

const ERROR =
  "Error: locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay now' })\n\n    at CheckoutPage.pay (/ci/work/tests/pages/checkout.page.ts:12:19)";

test.describe.serial('Branch failures', () => {
  let projectId: number;

  test('lists the failures of the newest run on the branch, at their failing call', async ({ request }) => {
    const first = await request.post('/api/test-runs/submit', {
      data: run(0, 'feature/pay', [
        { title: 'pays', status: 'failed', error: ERROR },
        { title: 'adds to cart', status: 'passed' },
      ]),
    });
    expect(first.ok()).toBeTruthy();
    projectId = (await first.json()).projectId;
    await request.post('/api/test-runs/submit', { data: run(5, 'main', [{ title: 'pays', status: 'passed' }]) });

    const body = await (
      await request.get(`/api/projects/${projectId}/branch-failures`, { params: { branch: 'feature/pay' } })
    ).json();
    expect(body.run).toMatchObject({ branch: 'feature/pay', status: 'failed', failedTests: 1 });
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]).toMatchObject({
      title: 'pays',
      file: 'tests/checkout.spec.ts',
      line: 10,
      location: '/ci/work/tests/pages/checkout.page.ts:12:19',
      frames: ['/ci/work/tests/pages/checkout.page.ts:12:19'],
    });
    expect(body.failures[0].headline).toContain('Pay now');
    expect(body.failures[0].message).toContain("Call log:\n  - waiting for getByRole('button', { name: 'Pay now' })");
    expect(body.failures[0].message).not.toContain('    at ');
  });

  test('reads the newest run of any branch without one, and no run for an unknown branch', async ({ request }) => {
    const any = await (await request.get(`/api/projects/${projectId}/branch-failures`)).json();
    expect(any.run.branch).toBe('main');
    expect(any.failures).toEqual([]);
    const none = await (
      await request.get(`/api/projects/${projectId}/branch-failures`, { params: { branch: 'nope' } })
    ).json();
    expect(none).toEqual({ run: null, overlays: [], failures: [], resolved: [], flaky: [] });
  });

  test('lays a test re-run from the editor over the run: the failure it passed is resolved', async ({ request }) => {
    const editor = await request.post('/api/test-runs/submit', {
      data: {
        ...run(10, 'feature/pay', [{ title: 'pays', status: 'passed' }]),
        isFullRun: false,
        metadata: { scm: { branch: 'feature/pay' }, piwiOrigin: { kind: 'editor' } },
      },
    });
    expect(editor.ok()).toBeTruthy();
    const editorRunId = (await editor.json()).runId;

    const body = await (
      await request.get(`/api/projects/${projectId}/branch-failures`, {
        params: { branch: 'feature/pay', overlays: '1' },
      })
    ).json();
    expect(body.run).toMatchObject({ branch: 'feature/pay', status: 'failed', failedTests: 1 });
    expect(body.overlays).toEqual([
      expect.objectContaining({ id: editorRunId, origin: 'editor', isFullRun: false, passedTests: 1 }),
    ]);
    expect(body.failures).toEqual([]);
    expect(body.resolved).toEqual([
      expect.objectContaining({ title: 'pays', file: 'tests/checkout.spec.ts', line: 10, runId: editorRunId }),
    ]);

    const alone = await (
      await request.get(`/api/projects/${projectId}/branch-failures`, { params: { branch: 'feature/pay' } })
    ).json();
    expect(alone.failures).toEqual([expect.objectContaining({ title: 'pays', source: 'baseline' })]);
    expect(alone.overlays).toEqual([]);
    expect(alone.resolved).toEqual([]);
  });
});
