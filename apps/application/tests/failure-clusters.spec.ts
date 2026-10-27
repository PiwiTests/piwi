import { test, expect, type APIRequestContext } from './fixtures';
import { PROJECT } from '#shared/test-project-names';
import { computeErrorFingerprint, extractErrorSignature } from '#shared/error-fingerprint';

// ── Fingerprint util ───────────────────────────────────────────────────────

test.describe('Error fingerprinting', () => {
  const timeoutError = (ms: number) =>
    `TimeoutError: locator.click: Timeout ${ms}ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Submit' })`;

  test('same timeout error with different durations and ANSI codes shares a fingerprint', async () => {
    const plain = await computeErrorFingerprint(timeoutError(30000));
    const colored = await computeErrorFingerprint(`\u001B[31m${timeoutError(15000)}\u001B[0m`);

    expect(plain.fingerprint).toBe(colored.fingerprint);
    expect(plain.errorType).toBe('timeout');
    expect(plain.selector).toBe("getByRole('button', { name: 'Submit' })");
    expect(plain.signature).toBe('TimeoutError: locator.click: Timeout <N>ms exceeded.');
  });

  test('assertion errors with different received values share a fingerprint', async () => {
    const error = (received: string) =>
      `Error: expect(locator).toHaveText(expected)\n\nLocator: getByTestId('status')\nExpected string: "Ready"\nReceived string: "${received}"\nCall log:\n  - expect.toHaveText with timeout 5000ms`;

    const a = await computeErrorFingerprint(error('Loading'));
    const b = await computeErrorFingerprint(error('Error'));

    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.errorType).toBe('assertion');
    expect(a.selector).toBe("getByTestId('status')");
  });

  test('different selectors produce different fingerprints', async () => {
    const error = (selector: string) =>
      `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for ${selector}`;

    const a = await computeErrorFingerprint(error("getByTestId('login-button')"));
    const b = await computeErrorFingerprint(error("getByTestId('logout-button')"));

    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test('classifies strict mode violations, navigation and crash errors', () => {
    expect(
      extractErrorSignature(
        "Error: locator.click: Error: strict mode violation: getByRole('button') resolved to 3 elements",
      ).errorType,
    ).toBe('strict-mode');
    expect(
      extractErrorSignature('Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4000/').errorType,
    ).toBe('navigation');
    expect(extractErrorSignature('Error: page.click: Target page, context or browser has been closed').errorType).toBe(
      'crash',
    );
  });

  test('stack frame file paths are extracted but do NOT influence the fingerprint', async () => {
    const error = (file: string, line: number) =>
      `Error: boom\n    at doLogin (${file}:${line}:11)\n    at node_modules/playwright/lib/runner.js:5:1`;

    const a = await computeErrorFingerprint(error('tests/helpers/auth.ts', 10));
    const b = await computeErrorFingerprint(error('tests/helpers/auth.ts', 99));
    // Same root cause reached from a different spec file → still one cluster
    const c = await computeErrorFingerprint(error('tests/pages/checkout.spec.ts', 4));

    expect(a.topFrameFile).toBe('tests/helpers/auth.ts');
    expect(c.topFrameFile).toBe('tests/pages/checkout.spec.ts');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toBe(c.fingerprint);
  });

  test('dynamic locator option values are masked so per-row failures group', async () => {
    const error = (rowName: string) =>
      `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByRole('row', { name: '${rowName}' }).getByRole('button')`;

    const alice = await computeErrorFingerprint(error('Alice Smith'));
    const bob = await computeErrorFingerprint(error('Bob Jones'));

    expect(alice.fingerprint).toBe(bob.fingerprint);
    // The unmasked locator is still kept for display
    expect(alice.selector).toContain('Alice Smith');
  });

  test('expected and received assertion values are both masked', async () => {
    const error = (expected: string, received: string) =>
      `Error: expect(locator).toHaveText(expected)\n\nLocator: getByTestId('greeting')\nExpected string: "${expected}"\nReceived string: "${received}"`;

    const a = await computeErrorFingerprint(error('Welcome, Alice', 'Goodbye'));
    const b = await computeErrorFingerprint(error('Welcome, Bob', 'Loading'));

    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test('digits glued to a letter are kept (identifiers), standalone numbers are masked', async () => {
    const assertOn = (id: string) => `Error: expect(locator).toBeVisible()\n\nLocator: getByTestId('${id}')`;

    // Distinct parameter/test-id names → distinct fingerprints (not collapsed to <N>).
    const field1 = await computeErrorFingerprint(assertOn('field1'));
    const field2 = await computeErrorFingerprint(assertOn('field2'));
    expect(field1.fingerprint).not.toBe(field2.fingerprint);

    // But a delimiter-separated dynamic index still collapses to one cluster.
    const row1 = await computeErrorFingerprint(assertOn('row-1'));
    const row2 = await computeErrorFingerprint(assertOn('row-2'));
    expect(row1.fingerprint).toBe(row2.fingerprint);

    // And a standalone number with a unit (timeout) is still masked → still groups.
    const t1 = await computeErrorFingerprint(timeoutError(30000));
    const t2 = await computeErrorFingerprint(timeoutError(15000));
    expect(t1.fingerprint).toBe(t2.fingerprint);
  });

  test('URLs and emails are masked out of the message head', async () => {
    const a = await computeErrorFingerprint(
      'Error: page.goto: net::ERR_CONNECTION_REFUSED at https://pr-1234.preview.example.com/login',
    );
    const b = await computeErrorFingerprint(
      'Error: page.goto: net::ERR_CONNECTION_REFUSED at https://pr-5678.preview.example.com/login',
    );

    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

// ── End-to-end clustering via the submit API ──────────────────────────────

test.describe.serial('Failure clustering', () => {
  const loginTimeout = (ms: number) =>
    `TimeoutError: locator.click: Timeout ${ms}ms exceeded.\nCall log:\n  - waiting for getByTestId('login-button')`;
  const cartAssertion = `Error: expect(locator).toHaveText(expected)\n\nLocator: getByTestId('cart-total')\nExpected string: "3 items"\nReceived string: "0 items"`;

  let firstRunClusterId: number | null = null;
  let firstRunId: number | null = null;
  let projectId: number | null = null;

  async function submitRun(request: APIRequestContext, cases: object[]) {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.FAILURE_CLUSTERS,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 60000,
        totalTests: cases.length,
        passedTests: 1,
        failedTests: cases.length - 1,
        skippedTests: 0,
        testCases: cases,
      },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as { runId: number; projectId: number };
  }

  test('groups failures sharing a root cause on submission', async ({ request }) => {
    const { runId, projectId: pid } = await submitRun(request, [
      {
        title: 'login via header',
        status: 'failed',
        duration: 31000,
        location: 'tests/auth.spec.ts:10:5',
        error: loginTimeout(30000),
      },
      {
        title: 'login via modal',
        status: 'failed',
        duration: 16000,
        location: 'tests/auth.spec.ts:30:5',
        error: loginTimeout(15000),
      },
      {
        title: 'cart shows items',
        status: 'failed',
        duration: 2000,
        location: 'tests/cart.spec.ts:12:5',
        error: cartAssertion,
      },
      { title: 'homepage loads', status: 'passed', duration: 900, location: 'tests/home.spec.ts:5:5' },
    ]);

    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    const byTitle: Record<string, { failureClusterId: number | null }> = Object.fromEntries(
      run.testCases.map((tc: { title: string }) => [tc.title, tc]),
    );

    // The two login timeouts share a cluster despite different timeout values
    expect(byTitle['login via header']!.failureClusterId).toEqual(expect.any(Number));
    expect(byTitle['login via modal']!.failureClusterId).toBe(byTitle['login via header']!.failureClusterId);

    // The cart assertion is a different root cause → different cluster
    expect(byTitle['cart shows items']!.failureClusterId).toEqual(expect.any(Number));
    expect(byTitle['cart shows items']!.failureClusterId).not.toBe(byTitle['login via header']!.failureClusterId);

    // Passed cases are never clustered
    expect(byTitle['homepage loads']!.failureClusterId).toBeNull();

    firstRunClusterId = byTitle['login via header']!.failureClusterId;
    firstRunId = runId;
    projectId = pid;
  });

  test('reuses the cluster across runs of the same project', async ({ request }) => {
    const { runId } = await submitRun(request, [
      {
        title: 'login via header',
        status: 'failed',
        duration: 31000,
        location: 'tests/auth.spec.ts:10:5',
        error: loginTimeout(30000),
      },
      { title: 'homepage loads', status: 'passed', duration: 900, location: 'tests/home.spec.ts:5:5' },
    ]);

    const run = await (await request.get(`/api/test-runs/${runId}`)).json();
    const failed = run.testCases.find((tc: { title: string }) => tc.title === 'login via header');

    expect(failed.failureClusterId).toBe(firstRunClusterId);
  });

  test('failure-groups endpoint classifies known, new and flaky groups', async ({ request }) => {
    const checkoutError = 'Error: page.goto: net::ERR_CONNECTION_REFUSED at https://checkout.example.com/';

    const { runId } = await submitRun(request, [
      {
        title: 'login via header',
        status: 'failed',
        duration: 31000,
        location: 'tests/auth.spec.ts:10:5',
        error: loginTimeout(30000),
      },
      // Failed first attempt + passed retry of the same test → flaky signal
      {
        title: 'checkout works',
        status: 'failed',
        duration: 5000,
        location: 'tests/checkout.spec.ts:8:3',
        error: checkoutError,
        retries: 0,
      },
      { title: 'checkout works', status: 'passed', duration: 4000, location: 'tests/checkout.spec.ts:8:3', retries: 1 },
      { title: 'homepage loads', status: 'passed', duration: 900, location: 'tests/home.spec.ts:5:5' },
    ]);

    const response = await request.get(`/api/test-runs/${runId}/failure-groups`);
    expect(response.ok()).toBeTruthy();
    const groups: Array<{
      clusterId: number;
      signature: string;
      selector: string | null;
      caseCount: number;
      isNew: boolean;
      firstSeenRunId: number;
      flaky: boolean;
      cases: Array<{ title: string; passedOnRetry: boolean }>;
    }> = (await response.json()).items;

    expect(groups).toHaveLength(2);

    // The login timeout is a known cluster carried over from the first run
    const loginGroup = groups.find((g) => g.signature.includes('TimeoutError'))!;
    expect(loginGroup).toBeDefined();
    expect(loginGroup.clusterId).toBe(firstRunClusterId);
    expect(loginGroup.isNew).toBe(false);
    expect(loginGroup.firstSeenRunId).toBeLessThanOrEqual(firstRunId);
    expect(loginGroup.caseCount).toBe(1);
    expect(loginGroup.selector).toBe("getByTestId('login-button')");

    // The checkout failure is new and passed on retry → flagged flaky
    const checkoutGroup = groups.find((g) => g.clusterId !== firstRunClusterId)!;
    expect(checkoutGroup).toBeDefined();
    expect(checkoutGroup.isNew).toBe(true);
    expect(checkoutGroup.flaky).toBe(true);
    expect(checkoutGroup.caseCount).toBe(1);
    expect(checkoutGroup.cases[0]!.title).toBe('checkout works');
    expect(checkoutGroup.cases[0]!.passedOnRetry).toBe(true);
  });

  test('project failure-clusters endpoint aggregates across runs', async ({ request }) => {
    const response = await request.get(`/api/projects/${projectId}/failure-clusters`);
    expect(response.ok()).toBeTruthy();
    const clusters: Array<{
      id: number;
      errorType: string | null;
      occurrences: number;
      affectedTests: number;
      lastSeenRunId: number;
      lastSeenAt: string | null;
    }> = (await response.json()).items;

    const login = clusters.find((c) => c.id === firstRunClusterId)!;
    expect(login).toBeDefined();
    expect(login.errorType).toBe('timeout');
    // Two distinct tests ever hit this cluster (login via header + login via modal)
    expect(login.affectedTests).toBe(2);
    // Rows across runs 1-3: 2 + 1 + 1
    expect(login.occurrences).toBe(4);
    expect(login.lastSeenAt).not.toBeNull();

    // Unknown project → 404, matching the other project endpoints
    const missing = await request.get('/api/projects/999999/failure-clusters');
    expect(missing.status()).toBe(404);
  });

  test('cluster status defaults to open and is exposed in project endpoint', async ({ request }) => {
    const response = await request.get(`/api/projects/${projectId}/failure-clusters`);
    const clusters: Array<{ id: number; status: string; triageNote: string | null }> = (await response.json()).items;

    const login = clusters.find((c) => c.id === firstRunClusterId)!;
    expect(login).toBeDefined();
    expect(login.status).toBe('open');
    expect(login.triageNote).toBeNull();
  });

  test('PATCH cluster status updates status and triage note', async ({ request }) => {
    const note = 'Investigated — flaky test infrastructure';
    const patchRes = await request.patch(`/api/failure-clusters/${firstRunClusterId}/status`, {
      data: { status: 'resolved', triageNote: note },
    });
    expect(patchRes.ok()).toBeTruthy();
    const { cluster } = await patchRes.json();
    expect(cluster.status).toBe('resolved');
    expect(cluster.triageNote).toBe(note);

    // Verify the update is persisted
    const getRes = await request.get(`/api/projects/${projectId}/failure-clusters`);
    const clusters: Array<{ id: number; status: string; triageNote: string | null }> = (await getRes.json()).items;
    const login = clusters.find((c) => c.id === firstRunClusterId)!;
    expect(login.status).toBe('resolved');
    expect(login.triageNote).toBe(note);
  });

  test('PATCH cluster status rejects invalid status values', async ({ request }) => {
    const res = await request.patch(`/api/failure-clusters/${firstRunClusterId}/status`, {
      data: { status: 'invalid' },
    });
    expect(res.status()).toBe(400);
  });

  test('status filter on project clusters endpoint', async ({ request }) => {
    // After the previous test, the login timeout cluster is resolved
    const resolved = await request.get(`/api/projects/${projectId}/failure-clusters?status=resolved`);
    expect(resolved.ok()).toBeTruthy();
    const resolvedClusters: Array<{ id: number }> = (await resolved.json()).items;
    expect(resolvedClusters.some((c) => c.id === firstRunClusterId)).toBeTruthy();

    const open = await request.get(`/api/projects/${projectId}/failure-clusters?status=open`);
    expect(open.ok()).toBeTruthy();
    const openClusters: Array<{ id: number }> = (await open.json()).items;
    expect(openClusters.some((c) => c.id === firstRunClusterId)).toBeFalsy();
  });

  test('failure-groups endpoint exposes cluster status', async ({ request }) => {
    const { runId } = await submitRun(request, [
      {
        title: 'login via header',
        status: 'failed',
        duration: 31000,
        location: 'tests/auth.spec.ts:10:5',
        error: loginTimeout(30000),
      },
      { title: 'homepage loads', status: 'passed', duration: 900, location: 'tests/home.spec.ts:5:5' },
    ]);

    const groupsRes = await request.get(`/api/test-runs/${runId}/failure-groups`);
    const groups: Array<{ status: string; triageNote: string | null }> = (await groupsRes.json()).items;
    expect(groups[0]).toBeDefined();
    expect(groups[0].status).toBe('resolved');
    expect(groups[0].triageNote).toBe('Investigated — flaky test infrastructure');
  });

  test('a known-issue link pins to the cluster and surfaces in the detail and the list', async ({ request }) => {
    // Cluster detail carries an (empty) links array and an owner field.
    const before = await request.get(`/api/failure-clusters/${firstRunClusterId}`);
    expect(before.ok()).toBeTruthy();
    const beforeBody = (await before.json()) as {
      links: Array<{ id: number }>;
      owner: { name: string; source: string } | null;
    };
    expect(Array.isArray(beforeBody.links)).toBe(true);
    expect(beforeBody.links).toHaveLength(0);
    // No annotation and no reachable CODEOWNERS in the test env.
    expect(beforeBody.owner).toBeNull();

    // Pin a GitHub issue to the cluster via the shared links endpoint.
    const create = await request.post('/api/links', {
      data: {
        entityType: 'failure_cluster',
        entityId: firstRunClusterId,
        url: 'https://github.com/piwitests/piwi/issues/123',
      },
    });
    expect(create.ok(), `POST /api/links failed: ${create.status()} ${await create.text()}`).toBeTruthy();
    const linkId = ((await create.json()) as { link: { id: number; provider: string; key: string | null } }).link.id;

    // The cluster detail now returns the pinned link.
    const after = await request.get(`/api/failure-clusters/${firstRunClusterId}`);
    const afterBody = (await after.json()) as { links: Array<{ id: number; provider: string; key: string | null }> };
    expect(afterBody.links).toHaveLength(1);
    expect(afterBody.links[0]!.provider).toBe('github-issue');
    expect(afterBody.links[0]!.key).toBe('123');

    // The project cluster list carries the pinned link as a compact chip source.
    const list = await request.get(`/api/projects/${projectId}/failure-clusters`);
    const clusters = (await list.json()).items as Array<{
      id: number;
      issueLink: { url: string; provider: string; key: string | null } | null;
    }>;
    const login = clusters.find((c) => c.id === firstRunClusterId)!;
    expect(login.issueLink).not.toBeNull();
    expect(login.issueLink!.key).toBe('123');

    // GET /api/links reads it back by the new entity type.
    const listLinks = await request.get(`/api/links?entityType=failure_cluster&entityId=${firstRunClusterId}`);
    expect(listLinks.ok()).toBeTruthy();
    expect(((await listLinks.json()).items as unknown[]).length).toBe(1);

    // Clean up so the list assertions in other tests stay unaffected.
    const del = await request.delete(`/api/links/${linkId}`);
    expect(del.ok()).toBeTruthy();
  });
});

// ── Extract cases from a cluster ─────────────────────────────────────────────

test.describe.serial('Extract cases from failure cluster', () => {
  const sharedError =
    "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('x')";

  let clusterId: number;
  let extractableTestCaseId: number;
  let remainingTestCaseId: number;
  let newClusterId: number;

  test.beforeAll(async ({ request }) => {
    const response = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.EXTRACT_CASES,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 3000,
        totalTests: 2,
        passedTests: 0,
        failedTests: 2,
        skippedTests: 0,
        testCases: [
          { title: 'case1', status: 'failed', duration: 500, location: 'tests/x.spec.ts:1:1', error: sharedError },
          { title: 'case2', status: 'failed', duration: 600, location: 'tests/x.spec.ts:2:1', error: sharedError },
        ],
      },
    });
    expect(response.ok()).toBeTruthy();
    const { runId } = await response.json();

    const clusterRes = await request.get(`/api/test-runs/${runId}`);
    const run = (await clusterRes.json()) as { testCases: Array<{ status: string; failureClusterId: number }> };
    const failed = run.testCases.filter((c) => c.status === 'failed');
    expect(failed).toHaveLength(2);
    clusterId = failed[0]!.failureClusterId;
    expect(clusterId).toEqual(expect.any(Number));
    expect(failed[1]!.failureClusterId).toBe(clusterId);

    // extract-cases keys off the underlying test case id (`testCases.id`, exposed
    // as `affectedTestCases[].testCaseId`), not the per-run-case id.
    const detailRes = await request.get(`/api/failure-clusters/${clusterId}`);
    const detail = (await detailRes.json()) as {
      occurrences: number;
      affectedTestCases: Array<{ testCaseId: number; title: string }>;
    };
    expect(detail.occurrences).toBe(2);
    extractableTestCaseId = detail.affectedTestCases.find((t) => t.title === 'case1')!.testCaseId;
    remainingTestCaseId = detail.affectedTestCases.find((t) => t.title === 'case2')!.testCaseId;
    expect(extractableTestCaseId).toEqual(expect.any(Number));
    expect(remainingTestCaseId).toEqual(expect.any(Number));
  });

  test('POST /extract-cases returns 400 for an empty testCaseIds array', async ({ request }) => {
    const res = await request.post(`/api/failure-clusters/${clusterId}/extract-cases`, {
      data: { testCaseIds: [] },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /extract-cases returns 400 when testCaseIds is missing', async ({ request }) => {
    const res = await request.post(`/api/failure-clusters/${clusterId}/extract-cases`, {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('POST /extract-cases returns 404 for an unknown cluster', async ({ request }) => {
    const res = await request.post('/api/failure-clusters/999999/extract-cases', {
      data: { testCaseIds: [extractableTestCaseId] },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /extract-cases moves the given case to a new cluster with the typed note', async ({ request }) => {
    const res = await request.post(`/api/failure-clusters/${clusterId}/extract-cases`, {
      data: { testCaseIds: [extractableTestCaseId], triageNote: 'extracted the flaky one' },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { clusterId: number };
    expect(body).toEqual({
      success: true,
      extractedCount: 1,
      remainingOccurrences: 1,
      clusterId: expect.any(Number),
    });
    newClusterId = body.clusterId;
    expect(newClusterId).not.toBe(clusterId);

    const detailRes = await request.get(`/api/failure-clusters/${clusterId}`);
    const detail = (await detailRes.json()) as {
      occurrences: number;
      triageNote: string | null;
      affectedTestCases: Array<{ testCaseId: number }>;
    };
    expect(detail.occurrences).toBe(1);
    expect(detail.triageNote).toBe(`Moved 1 test to cluster #${newClusterId}.`);
    expect(detail.affectedTestCases.map((t) => t.testCaseId)).toEqual([remainingTestCaseId]);

    const moved = (await (await request.get(`/api/failure-clusters/${newClusterId}`)).json()) as {
      occurrences: number;
      triageNote: string | null;
      affectedTestCases: Array<{ testCaseId: number }>;
    };
    expect(moved.occurrences).toBe(1);
    expect(moved.triageNote).toBe('extracted the flaky one');
    expect(moved.affectedTestCases.map((t) => t.testCaseId)).toEqual([extractableTestCaseId]);
  });

  test('the moved case references its new cluster on the run detail page', async ({ request }) => {
    const projectsRes = await request.get('/api/projects/menu');
    const projects = ((await projectsRes.json()) as { items: Array<{ id: number; name: string }> }).items;
    const project = projects.find((p) => p.name === PROJECT.EXTRACT_CASES)!;
    const projectDetail = (await (await request.get(`/api/projects/${project.id}`)).json()) as {
      testRuns: Array<{ id: number }>;
    };
    const runId = projectDetail.testRuns[0]!.id;

    const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ title: string; failureClusterId: number | null }>;
    };
    const extracted = run.testCases.find((c) => c.title === 'case1')!;
    const remaining = run.testCases.find((c) => c.title === 'case2')!;
    expect(extracted.failureClusterId).toBe(newClusterId);
    expect(remaining.failureClusterId).toBe(clusterId);
  });
});
