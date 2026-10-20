import { test, expect, type APIRequestContext } from './fixtures';
import { waitForHydration } from './utils';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PROJECT } from '#shared/test-project-names';
import { buildZip } from '../server/utils/trace-zip';

/**
 * End-to-end deletion coverage for runs that carry real evidence (a trace, so a
 * blob + shared resources + a `files` row, and a failing case, so a failure
 * cluster) and for deleting a whole project. The pre-existing delete test only
 * covered a bare run with no files; the paths that touch storage, blob
 * refcounting and cluster recompute went unexercised. Dialect-agnostic — it
 * asserts through the API, so the same spec validates SQLite and PostgreSQL.
 */

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// A real committed trace with resources — populates trace_blobs AND trace_resources.
const traceZip = readFileSync('public/demo/traces/checkout-pay-timeout.zip');
const traceHash = sha256(traceZip);

async function uploadRunWithEvidence(request: APIRequestContext, projectName: string) {
  const response = await request.post('/api/test-runs/upload', {
    multipart: {
      projectName,
      testRun: JSON.stringify({
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 5000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
      }),
      testCases: JSON.stringify([
        {
          title: 'evidence case that fails',
          status: 'failed',
          duration: 1200,
          location: 'tests/evidence.spec.ts:7:3',
          error: 'Error: expected true to be false\n    at tests/evidence.spec.ts:7:3',
        },
      ]),
      trace_0: { name: 'trace.zip', mimeType: 'application/zip', buffer: traceZip },
    },
  });
  expect(response.ok(), `upload failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

test.describe.serial('Delete a run that has evidence', () => {
  let runId: number;
  let projectId: number;
  // The trace is content-addressed and deduped: its stored path is deterministic.
  let blobPath: string;

  test('upload a run with a trace and a failing case', async ({ request }) => {
    const data = await uploadRunWithEvidence(request, PROJECT.DELETE_EVIDENCE);
    runId = data.runId;
    projectId = data.projectId;
    expect(runId).toBeTruthy();
    blobPath = `project-${projectId}/blobs/${traceHash}.zip`;

    // The stored trace is served (reconstructed from the slim blob + resources)
    // before deletion.
    const traceResponse = await request.get(`/api/files/${blobPath}`);
    expect(traceResponse.ok(), `trace downloadable before deletion: ${traceResponse.status()}`).toBeTruthy();
  });

  test('deleting the run removes the run, its cases and its trace', async ({ request }) => {
    const del = await request.delete(`/api/test-runs/${runId}`);
    expect(del.ok(), `delete failed: ${del.status()} ${await del.text()}`).toBeTruthy();
    expect((await del.json()).success).toBe(true);

    // The run itself is gone.
    expect((await request.get(`/api/test-runs/${runId}`)).status()).toBe(404);

    // It no longer appears in the project's run list.
    const project = await (await request.get(`/api/projects/${projectId}`)).json();
    expect(project.testRuns?.some((r: { id: number }) => r.id === runId)).toBeFalsy();

    // The trace evidence is gone from storage (last reference removed).
    expect((await request.get(`/api/files/${blobPath}`)).status()).toBe(404);
  });
});

/** Upload a run whose `caseCount` cases all point at the same shared trace blob. */
async function uploadRunSharingOneTrace(request: APIRequestContext, projectName: string, caseCount: number) {
  const multipart: Record<string, unknown> = {
    projectName,
    testRun: JSON.stringify({
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 5000,
      totalTests: caseCount,
      passedTests: 0,
      failedTests: caseCount,
      skippedTests: 0,
    }),
    testCases: JSON.stringify(
      Array.from({ length: caseCount }, (_, i) => ({
        title: `shared-trace case ${i}`,
        status: 'failed',
        duration: 1000,
        location: `tests/shared.spec.ts:${i + 1}:1`,
        error: `boom ${i}`,
      })),
    ),
  };
  // Same bytes for every case → one deduplicated blob, `caseCount` files rows.
  for (let i = 0; i < caseCount; i++) {
    multipart[`trace_${i}`] = { name: 'trace.zip', mimeType: 'application/zip', buffer: traceZip };
  }
  const response = await request.post('/api/test-runs/upload', { multipart });
  expect(response.ok(), `upload failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json();
}

test.describe.serial('Deleting frees a shared trace blob (no leak)', () => {
  test('a run whose cases share one blob frees it on delete', async ({ request }) => {
    const data = await uploadRunSharingOneTrace(request, PROJECT.DELETE_SHARED_BLOB, 2);
    const blobPath = `project-${data.projectId}/blobs/${traceHash}.zip`;
    expect((await request.get(`/api/files/${blobPath}`)).ok()).toBeTruthy();

    expect((await request.delete(`/api/test-runs/${data.runId}`)).ok()).toBeTruthy();

    // The blob must be gone — the two cases were its only references.
    expect((await request.get(`/api/files/${blobPath}`)).status()).toBe(404);
  });

  test('a blob shared across two runs survives deleting one, and is freed with the last', async ({ request }) => {
    const first = await uploadRunSharingOneTrace(request, PROJECT.DELETE_SHARED_BLOB, 1);
    const second = await uploadRunSharingOneTrace(request, PROJECT.DELETE_SHARED_BLOB, 1);
    const blobPath = `project-${first.projectId}/blobs/${traceHash}.zip`;
    expect((await request.get(`/api/files/${blobPath}`)).ok()).toBeTruthy();

    // Deleting the first run must NOT remove a blob the second still references.
    expect((await request.delete(`/api/test-runs/${first.runId}`)).ok()).toBeTruthy();
    expect(
      (await request.get(`/api/files/${blobPath}`)).ok(),
      'blob kept while a run still references it',
    ).toBeTruthy();

    // Deleting the last referencing run frees it.
    expect((await request.delete(`/api/test-runs/${second.runId}`)).ok()).toBeTruthy();
    expect((await request.get(`/api/files/${blobPath}`)).status()).toBe(404);
  });
});

/** A minimal trace ZIP: one event stream (its marker makes the blob hash unique) plus named resources. */
function buildTrace(marker: string, resources: { name: string; content: string }[]): Buffer {
  return buildZip([
    { name: 'trace.trace', data: Buffer.from(`{"type":"context","marker":"${marker}"}\n`) },
    ...resources.map((r) => ({ name: `resources/${r.name}`, data: Buffer.from(r.content, 'utf8') })),
  ]);
}

async function uploadRunWithTrace(request: APIRequestContext, projectName: string, trace: Buffer) {
  const hash = sha256(trace);
  const response = await request.post('/api/test-runs/upload', {
    multipart: {
      projectName,
      testRun: JSON.stringify({
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 3000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
      }),
      testCases: JSON.stringify([
        { title: 'refcount case', status: 'failed', duration: 500, location: 'tests/rc.spec.ts:1:1', error: 'boom' },
      ]),
      trace_0: { name: 'trace.zip', mimeType: 'application/zip', buffer: trace },
    },
  });
  expect(response.ok(), `upload failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  return { ...(await response.json()), hash } as { runId: number; projectId: number; hash: string };
}

/** A trace resource as Playwright names it: the SHA-1 of its bytes, then an extension. */
function sha1Resource(content: string): { name: string; content: string } {
  return { name: `${createHash('sha1').update(content).digest('hex')}.txt`, content };
}

test.describe.serial('Partial delete reclaims only unshared resources', () => {
  // Two traces in one project: one shared resource (same name+bytes → stored once,
  // referenced by both blobs) plus a resource unique to each.
  const SHARED = sha1Resource('shared resource body '.repeat(40));
  const ONLY_A = sha1Resource('A-only body '.repeat(40));
  const ONLY_B = sha1Resource('B-only body '.repeat(40));
  const traceA = buildTrace('A', [SHARED, ONLY_A]);
  const traceB = buildTrace('B', [SHARED, ONLY_B]);

  let projectId: number;
  let runA: number;
  let runB: number;
  let hashA: string;
  let hashB: string;
  const resPath = (name: string) => `project-${projectId}/trace-resources/${name}`;
  const blobPath = (hash: string) => `project-${projectId}/blobs/${hash}.zip`;

  test('upload two runs sharing a resource', async ({ request }) => {
    const a = await uploadRunWithTrace(request, PROJECT.DELETE_RESOURCE_REFCOUNT, traceA);
    projectId = a.projectId;
    runA = a.runId;
    hashA = a.hash;
    const b = await uploadRunWithTrace(request, PROJECT.DELETE_RESOURCE_REFCOUNT, traceB);
    runB = b.runId;
    hashB = b.hash;
    expect(b.projectId).toBe(projectId);

    for (const p of [
      blobPath(hashA),
      blobPath(hashB),
      resPath(SHARED.name),
      resPath(ONLY_A.name),
      resPath(ONLY_B.name),
    ]) {
      expect((await request.get(`/api/files/${p}`)).ok(), `present before delete: ${p}`).toBeTruthy();
    }
  });

  test('deleting run A frees only its unique resource', async ({ request }) => {
    expect((await request.delete(`/api/test-runs/${runA}`)).ok()).toBeTruthy();

    expect((await request.get(`/api/files/${blobPath(hashA)}`)).status(), 'A blob gone').toBe(404);
    expect((await request.get(`/api/files/${blobPath(hashB)}`)).ok(), 'B blob kept').toBeTruthy();
    // The resource only run A used is reclaimed by the partial delete…
    expect((await request.get(`/api/files/${resPath(ONLY_A.name)}`)).status(), 'A-only reclaimed').toBe(404);
    // …while the shared one and B's own resource survive.
    expect((await request.get(`/api/files/${resPath(SHARED.name)}`)).ok(), 'shared kept').toBeTruthy();
    expect((await request.get(`/api/files/${resPath(ONLY_B.name)}`)).ok(), 'B-only kept').toBeTruthy();
  });

  test('deleting run B frees the shared and remaining resources', async ({ request }) => {
    expect((await request.delete(`/api/test-runs/${runB}`)).ok()).toBeTruthy();

    expect((await request.get(`/api/files/${blobPath(hashB)}`)).status()).toBe(404);
    expect((await request.get(`/api/files/${resPath(SHARED.name)}`)).status()).toBe(404);
    expect((await request.get(`/api/files/${resPath(ONLY_B.name)}`)).status()).toBe(404);
  });
});

/** Submit a bare one-case run to `projectName`; returns the new run's and project's ids. */
async function submitBareRun(request: APIRequestContext, projectName: string, n: number) {
  const response = await request.post('/api/test-runs/submit', {
    data: {
      projectName,
      status: 'passed',
      startTime: new Date(Date.now() - n * 60_000).toISOString(),
      duration: 1000,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      testCases: [{ title: `bare case ${n}`, status: 'passed', duration: 100, location: 'tests/bare.spec.ts:3:1' }],
    },
  });
  expect(response.ok(), `submit failed: ${response.status()} ${await response.text()}`).toBeTruthy();
  return (await response.json()) as { runId: number; projectId: number };
}

test.describe.serial('Delete a whole project', () => {
  let projectId: number;
  const runIds: number[] = [];

  test('create a project with an evidence-bearing run and more runs than one delete batch', async ({ request }) => {
    const data = await uploadRunWithEvidence(request, PROJECT.DELETE_PROJECT);
    projectId = data.projectId;
    runIds.push(data.runId);
    // The runs are deleted 50 at a time; 52 runs make a second, partial batch.
    for (let n = 1; n <= 51; n++) runIds.push((await submitBareRun(request, PROJECT.DELETE_PROJECT, n)).runId);
    expect(projectId).toBeTruthy();
    expect((await request.get(`/api/projects/${projectId}`)).ok()).toBeTruthy();
  });

  test('no deletion progress is reported while none is running', async ({ request }) => {
    const res = await request.get(`/api/projects/${projectId}/deletion`);
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual({ progress: null });
  });

  test('deleting the project removes the project and all its runs', async ({ request }) => {
    const del = await request.delete(`/api/projects/${projectId}`);
    expect(del.ok(), `project delete failed: ${del.status()} ${await del.text()}`).toBeTruthy();
    expect((await del.json()).success).toBe(true);

    expect((await request.get(`/api/projects/${projectId}`)).status()).toBe(404);
    for (const runId of [runIds[0], runIds[50], runIds.at(-1)]) {
      expect((await request.get(`/api/test-runs/${runId}`)).status(), `run ${runId}`).toBe(404);
    }
    expect(await (await request.get(`/api/projects/${projectId}/deletion`)).json()).toEqual({ progress: null });
  });
});

test.describe.serial('Delete a project from its page', () => {
  let projectId: number;

  test.beforeAll(async ({ request }) => {
    projectId = (await submitBareRun(request, PROJECT.DELETE_PROJECT_UI, 1)).projectId;
    await submitBareRun(request, PROJECT.DELETE_PROJECT_UI, 2);
  });

  test('the modal shows the deletion step by step until it ends', async ({ page, request }) => {
    // Hold the DELETE and answer the progress poll with a run count, so the
    // in-between state stays on screen long enough to be read.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/projects/${projectId}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      await released;
      await route.continue();
    });
    await page.route(`**/api/projects/${projectId}/deletion`, (route) =>
      route.fulfill({ json: { progress: { phase: 'runs', totalRuns: 2, runsDeleted: 1 } } }),
    );

    await page.goto(`/projects/${projectId}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill(PROJECT.DELETE_PROJECT_UI);
    await dialog.getByRole('button', { name: 'Delete project' }).click();

    await expect(dialog.getByRole('heading', { name: 'Deleting project' })).toBeVisible();
    const steps = dialog.getByTestId('project-delete-steps');
    await expect(steps.locator('[data-state="ok"]')).toContainText('Removing stored files');
    await expect(steps.locator('[data-state="pending"]')).toContainText('Deleting 2 test runs');
    await expect(steps.locator('[data-state="pending"]')).toContainText('1 of 2 deleted');
    await expect(steps.locator('[data-state="waiting"]')).toContainText('failure clusters');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Close' })).toHaveCount(0);

    release();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Project deleted', { exact: true })).toBeVisible();
    expect((await request.get(`/api/projects/${projectId}`)).status()).toBe(404);
  });
});
