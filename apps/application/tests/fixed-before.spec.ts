/**
 * "Fixed before" — resolved-cluster memory.
 *
 * When a cluster is open, Piwi finds the resolved clusters it resembles and
 * shows how they were fixed. This checks the whole path: the match is found,
 * the section renders on the cluster page, and applying the earlier triage
 * copies its note onto the open cluster without ever marking it resolved.
 */

import { test, expect, type APIRequestContext } from './fixtures';
import { waitForHydration } from './utils';
import { PROJECT } from '#shared/test-project-names';

let clock = Date.now() - 6 * 60 * 60 * 1000;

/** Submit one failing run and return nothing; the cluster is created on ingest. */
async function submitFailure(request: APIRequestContext, title: string, error: string): Promise<void> {
  clock += 60 * 1000;
  const res = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.FIXED_BEFORE,
      status: 'failed',
      startTime: new Date(clock).toISOString(),
      duration: 2000,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      skippedTests: 0,
      testCases: [{ title, status: 'failed', error, duration: 1000, location: 'tests/orders.spec.ts:12:5' }],
    },
  });
  expect(res.ok(), `submit failed: ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function clustersOf(request: APIRequestContext, projectId: number) {
  return (
    (await (await request.get(`/api/projects/${projectId}/failure-clusters`)).json()) as {
      items: Array<{ id: number; signature: string; status: string }>;
    }
  ).items;
}

// The two failures share the same failing locator and error kind (timeout) but
// differ in message, so they fingerprint into two clusters that the memory
// scorer still recognizes as the same family.
const RESOLVED_ERROR =
  "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('save-order')";
const OPEN_ERROR =
  "TimeoutError: locator.waitFor: Timeout 15000ms exceeded.\nCall log:\n  - waiting for getByTestId('save-order')";

test.describe.serial('Fixed before', () => {
  let projectId: number;
  let resolvedId: number;
  let openId: number;

  test.beforeAll(async ({ request }) => {
    await submitFailure(request, 'saves an order', RESOLVED_ERROR);

    const projects = (
      (await (await request.get('/api/projects')).json()) as { items: Array<{ id: number; name: string }> }
    ).items;
    projectId = projects.find((p) => p.name === PROJECT.FIXED_BEFORE)!.id;

    const first = await clustersOf(request, projectId);
    expect(first.length).toBe(1);
    resolvedId = first[0]!.id;

    // Resolve it — a triage note is what "Apply the same triage" reuses.
    const patch = await request.patch(`/api/failure-clusters/${resolvedId}/status`, {
      data: { status: 'resolved', triageNote: 'Waited for the save request to settle before asserting.' },
    });
    expect(patch.ok()).toBeTruthy();

    await submitFailure(request, 'updates an order', OPEN_ERROR);
    const after = await clustersOf(request, projectId);
    expect(after.length).toBe(2);
    openId = after.find((c) => c.id !== resolvedId)!.id;
  });

  test('finds the resolved cluster the open one resembles', async ({ request }) => {
    const res = await request.get(`/api/failure-clusters/${openId}/fixed-before`);
    expect(res.ok()).toBeTruthy();
    const { items } = (await res.json()) as { items: Array<{ clusterId: number; reason: string }> };
    expect(items.map((m) => m.clusterId)).toContain(resolvedId);
    expect(items.find((m) => m.clusterId === resolvedId)!.reason).toContain('locator');
  });

  test('never lists an open cluster as a prior fix', async ({ request }) => {
    // The resolved cluster has no resolved peer, so its own memory is empty.
    const res = await request.get(`/api/failure-clusters/${resolvedId}/fixed-before`);
    const { items } = (await res.json()) as { items: unknown[] };
    expect(items).toHaveLength(0);
  });

  test('renders the section and applies the earlier triage without resolving', async ({ page, request }) => {
    await page.goto(`/failure-clusters/${openId}`);
    await waitForHydration(page);
    // Fixed before is a section of "More ways to fix" (it is never the next step),
    // opening in a side panel from its button, so open it before asserting on its content.
    await page.getByRole('button', { name: /^Fixed before/ }).click();
    const section = page.locator('[data-shot="fixed-before"]');
    await expect(section).toBeVisible();
    await expect(section.getByText(`#${resolvedId}`, { exact: false })).toBeVisible();
    // The relative "Fixed …" timestamp is client-only, so its appearance means
    // this subtree has hydrated and the apply button's handler is attached.
    await expect(section.getByText(/^Fixed /)).toBeVisible();

    // Retry the click until the note lands: the note is idempotent for the
    // assertion below, and the retry rides out client hydration on a dev server.
    const applyButton = section.getByRole('button', { name: 'Apply the same triage' });
    const readNote = async () =>
      ((await (await request.get(`/api/failure-clusters/${openId}`)).json()) as { triageNote: string | null })
        .triageNote ?? '';

    await expect(async () => {
      await applyButton.click();
      expect(await readNote()).toContain(`Same as cluster #${resolvedId}:`);
    }).toPass({ timeout: 60_000, intervals: [1000, 2000, 3000, 5000] });

    // The status is untouched — a new cluster is never marked resolved because
    // an old one was.
    const cluster = (await (await request.get(`/api/failure-clusters/${openId}`)).json()) as { status: string };
    expect(cluster.status).toBe('open');
  });
});
