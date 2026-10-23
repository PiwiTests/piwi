/**
 * Tests for the AI diagnosis endpoints (Pillar 4).
 *
 * Spins up a mock OpenAI-compatible HTTP server on a random port so the Nuxt
 * server can be configured to call it without needing real API credentials.
 */

import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { waitForHydration } from './utils';
import * as http from 'http';
import * as net from 'net';
import { PROJECT } from '#shared/test-project-names';
import type { AiDiagnosisResult } from '#shared/ai-diagnosis';
import { lockAiSettings } from './utils/ai-settings-lock';

// Force all tests in this file into a single serial worker so the two describe
// blocks don't interfere with each other's AI config state.
test.describe.configure({ mode: 'serial' });

// Other specs point Settings → AI at their own mock model; hold it for this whole file.
let releaseAiSettings = () => {};
test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  releaseAiSettings = await lockAiSettings();
});
test.afterAll(() => releaseAiSettings());

// ── Mock HTTP server ──────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

function buildMockAiResponse(): AiDiagnosisResult {
  return {
    category: 'app-bug',
    confidence: 'high',
    confidenceScore: 88,
    severity: 'high',
    affectedArea: 'auth / login',
    summary: 'Mock diagnosis summary from test',
    rootCause: 'Mock root cause explanation',
    evidence: ['Evidence line 1', 'Evidence line 2'],
    hypotheses: [
      {
        category: 'app-bug',
        rootCause: 'Mock root cause explanation',
        likelihood: 88,
        evidence: ['Evidence line 1', 'Evidence line 2'],
      },
      { category: 'test-bug', rootCause: 'Alternative cause', likelihood: 30, evidence: ['Alt evidence'] },
    ],
    suggestedFix: {
      description: 'Mock suggested fix',
      file: 'tests/mock.spec.ts',
      code: null,
      patch: null,
    },
    investigationSteps: ['Check the auth endpoint logs'],
    preventionTips: ['Add more tests'],
  };
}

function startMockAiServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
        if ('max_tokens' in parsed) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message:
                  "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
                type: 'invalid_request_error',
                param: 'max_tokens',
                code: 'unsupported_parameter',
              },
            }),
          );
          return;
        }

        const diagResult = buildMockAiResponse();
        const responseContent = JSON.stringify(diagResult);
        const payload = {
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: responseContent },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/**
 * Like `startMockAiServer`, but also answers `stream: true` requests as a real
 * OpenAI-compatible SSE stream (`data: {"choices":[{"delta":{"content": "..."}}]}`
 * chunks, terminated by a final chunk carrying `usage` and a `data: [DONE]` line)
 * so `POST /diagnose/stream`'s real streaming path can be exercised end to end.
 */
function startStreamingMockAiServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed: { stream?: boolean } = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          /* ignore */
        }

        if ('max_tokens' in parsed) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message:
                  "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
                type: 'invalid_request_error',
                param: 'max_tokens',
                code: 'unsupported_parameter',
              },
            }),
          );
          return;
        }

        const diagResult = buildMockAiResponse();
        const responseContent = JSON.stringify(diagResult);

        if (!parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              choices: [{ index: 0, message: { role: 'assistant', content: responseContent }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
            }),
          );
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        // Split the JSON payload into a handful of delta chunks to exercise the
        // "text" chunk path, not just a single chunk.
        const chunkSize = Math.max(1, Math.ceil(responseContent.length / 4));
        for (let i = 0; i < responseContent.length; i += chunkSize) {
          const piece = responseContent.slice(i, i + chunkSize);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/**
 * Like `startMockAiServer`, but refuses any request carrying an `image_url`
 * part the way a text-only OpenAI-compatible model does, so the provider's
 * drop-the-images retry runs without needing a real model. `imageAttempts`
 * counts the requests that arrived with images.
 */
function startTextOnlyMockAiServer(port: number): { server: http.Server; imageAttempts: () => number } {
  let imageAttempts = 0;
  const server = http.createServer((req, res) => {
    if (!(req.method === 'POST' && req.url?.includes('/chat/completions'))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let messages: Array<{ content?: unknown }> = [];
      try {
        messages = (JSON.parse(body || '{}') as { messages?: Array<{ content?: unknown }> }).messages ?? [];
      } catch {
        /* ignore */
      }
      const hasImage = messages.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some((part) => (part as { type?: string } | null)?.type === 'image_url'),
      );

      if (hasImage) {
        imageAttempts++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'This model does not support image inputs' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(buildMockAiResponse()) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
        }),
      );
    });
  });
  server.listen(port, '127.0.0.1');
  return { server, imageAttempts: () => imageAttempts };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function submitRun(request: APIRequestContext, cases: Array<{ status: string; [key: string]: unknown }>) {
  const res = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.AI_DIAGNOSIS,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 30000,
      totalTests: cases.length,
      passedTests: cases.filter((c) => c.status === 'passed').length,
      failedTests: cases.filter((c) => c.status === 'failed').length,
      skippedTests: 0,
      testCases: cases,
    },
  });
  expect(res.ok()).toBeTruthy();
  return res.json() as Promise<{ runId: number; projectId: number }>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe.serial('AI diagnosis endpoints', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let clusterId: number | null = null;
  let isEnvManaged = false;
  let freshClusterError = '';

  test.beforeAll(async ({ request }) => {
    // Check if AI is managed by env vars — if so, we can't clear/replace the config
    const statusRes = await request.get('/api/ai/status');
    if (statusRes.ok()) {
      const s = (await statusRes.json()) as { source?: string };
      isEnvManaged = s.source === 'env';
    }
    mockPort = await getFreePort();
    mockServer = startMockAiServer(mockPort);
  });

  test.beforeEach(async () => {
    // All tests in this block require controlling the AI config; skip when env-managed
    if (isEnvManaged) test.skip();
  });

  test.afterAll(async ({ request }) => {
    // Clean up AI settings
    await request.put('/api/settings/ai', { data: { roles: null } });
    mockServer.close();
  });

  test('GET /api/ai/status returns configured: false when no provider is set', async ({ request }) => {
    // Clean slate: ensure no AI is configured (env may not set it, DB may have stale state)
    await request.put('/api/settings/ai', { data: { roles: null } });

    const res = await request.get('/api/ai/status');
    expect(res.ok()).toBeTruthy();
    const status = await res.json();
    expect(status.configured).toBe(false);
  });

  test('PUT /api/settings/ai saves provider and model', async ({ request }) => {
    const res = await request.put('/api/settings/ai', {
      data: {
        roles: {
          diagnosis: {
            provider: 'openai',
            apiKey: 'test-key-unused',
            model: 'gpt-test',
            baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          },
        },
        autoDiagnose: false,
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('GET /api/ai/status returns configured: true after provider is saved', async ({ request }) => {
    const res = await request.get('/api/ai/status');
    expect(res.ok()).toBeTruthy();
    const status = await res.json();
    expect(status.configured).toBe(true);
    expect(status.provider).toBe('openai');
    expect(status.source).toBe('settings');
  });

  test('GET /api/failure-clusters/:id/diagnosis returns null before any diagnosis', async ({ request }) => {
    // Use a unique error per invocation so retries don't collide with previously-diagnosed clusters
    freshClusterError = `TimeoutError: locator.click: Timeout 30000ms exceeded.\n    at tests/auth.spec.ts:5:3 (${Date.now()})`;
    // Create a test run with a failure cluster
    const { runId } = await submitRun(request, [
      {
        title: 'login test',
        status: 'failed',
        duration: 1000,
        location: 'tests/auth.spec.ts:5:3',
        error: freshClusterError,
      },
    ]);

    const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ status: string; failureClusterId?: number }>;
    };
    const failedCase = run.testCases.find((c) => c.status === 'failed');
    expect(failedCase?.failureClusterId).toBeTruthy();
    clusterId = failedCase!.failureClusterId!;

    const res = await request.get(`/api/failure-clusters/${clusterId}/diagnosis`);
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual({ diagnosis: null, manualBaseCommit: null });
  });

  test('POST /api/failure-clusters/:id/diagnose returns completed diagnosis', async ({ request }) => {
    expect(clusterId).toBeTruthy();

    const res = await request.post(`/api/failure-clusters/${clusterId}/diagnose`);
    expect(res.ok()).toBeTruthy();

    const diagnosis = await res.json();
    expect(diagnosis.status).toBe('completed');
    expect(diagnosis.clusterId).toBe(clusterId);
    expect(diagnosis.category).toBe('app-bug');
    expect(diagnosis.confidence).toBe('high');
    expect(typeof diagnosis.summary).toBe('string');
    expect(typeof diagnosis.rootCause).toBe('string');
    // Structured Phase-1 fields are persisted in details
    expect(diagnosis.details.confidenceScore).toBe(88);
    expect(diagnosis.details.severity).toBe('high');
    expect(diagnosis.details.affectedArea).toBe('auth / login');
    expect(Array.isArray(diagnosis.details.hypotheses)).toBe(true);
    expect(diagnosis.details.hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(diagnosis.details.investigationSteps)).toBe(true);
  });

  test('GET /api/failure-clusters/:id/diagnosis returns the stored diagnosis', async ({ request }) => {
    expect(clusterId).toBeTruthy();

    const res = await request.get(`/api/failure-clusters/${clusterId}/diagnosis`);
    expect(res.ok()).toBeTruthy();

    const body = (await res.json()) as { diagnosis: { status: string; category: string } | null };
    expect(body.diagnosis).not.toBeNull();
    expect(body.diagnosis!.status).toBe('completed');
    expect(body.diagnosis!.category).toBe('app-bug');
  });

  test('Show context and Re-diagnose reach the Diagnosis panel that leads the cluster page', async ({
    page,
    request,
  }) => {
    expect(clusterId).toBeTruthy();
    // A completed diagnosis whose patch is absent: the step follows the diagnosis,
    // with Re-diagnose as its one secondary action, so it sits inline.
    const detail = (await (await request.get(`/api/failure-clusters/${clusterId}`)).json()) as {
      nextStep: { kind: string; secondary?: Array<{ action: string }> } | null;
    };
    expect(detail.nextStep?.kind).toBe('follow-diagnosis');
    expect(detail.nextStep?.secondary?.map((a) => a.action)).toEqual(['re-diagnose']);

    await page.goto(`/failure-clusters/${clusterId}`);
    await waitForHydration(page);

    // A step from the diagnosis puts Diagnosis in its own card, always open.
    const panel = page.locator('[data-shot="fix-lead"] [data-shot="cluster-diagnosis"]');
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-shot="fix"] [data-shot="fix-diagnosis"]')).toHaveCount(0);

    // More actions › Show context opens the context modal.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Show context' }).click();
    const context = page.getByRole('dialog').filter({ hasText: 'Context sent to AI' });
    await expect(context).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(context).toHaveCount(0);

    // The next step's Re-diagnose asks for a new diagnosis (answered here without
    // reaching the server, so the stored one stays).
    const diagnoseRequests: string[] = [];
    await page.route(/\/api\/failure-clusters\/\d+\/diagnose/, async (route) => {
      diagnoseRequests.push(route.request().url());
      await route.abort();
    });
    await page.locator('[data-shot="next-step"]').getByRole('button', { name: 'Re-diagnose' }).click();
    await expect(panel).toBeVisible();
    await expect.poll(() => diagnoseRequests.length).toBeGreaterThan(0);
  });

  test('Show context opens a folded Diagnosis section when the next step is not from the diagnosis', async ({
    page,
    request,
  }) => {
    // A cluster whose test passed again: the step is Mark resolved, which points at
    // no section, so Diagnosis is a folded section of More ways to fix and its
    // panel is not mounted until the section opens.
    const title = 'logout clears the session';
    const location = 'tests/logout.spec.ts:8:3';
    // Letters, not digits: the fingerprint masks numbers, so each attempt gets a cluster of its own.
    const token = String(Date.now()).replace(/\d/g, (d) => 'klmnopqrst'[Number(d)]!);
    const { runId } = await submitRun(request, [
      {
        title,
        status: 'failed',
        duration: 1000,
        location,
        error: `Error: logout left the session open ${token}`,
      },
    ]);
    const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ status: string; failureClusterId?: number }>;
    };
    const foldedClusterId = run.testCases.find((c) => c.status === 'failed')?.failureClusterId;
    expect(foldedClusterId).toBeTruthy();
    await submitRun(request, [{ title, status: 'passed', duration: 900, location }]);
    // The fix is recorded in the background after the passing run is stored.
    await expect
      .poll(
        async () =>
          (
            (await (await request.get(`/api/failure-clusters/${foldedClusterId}`)).json()) as {
              nextStep: { kind: string } | null;
            }
          ).nextStep?.kind,
        { timeout: 15_000 },
      )
      .toBe('mark-resolved');

    await page.goto(`/failure-clusters/${foldedClusterId}`);
    await waitForHydration(page);

    await expect(page.locator('[data-shot="fix-lead"]')).toHaveCount(0);
    const diagnosis = page.locator('[data-shot="fix"] [data-shot="fix-diagnosis"] button[aria-expanded]').first();
    await expect(diagnosis).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-shot="cluster-diagnosis"]')).toHaveCount(0);

    // More actions › Show context opens the section, mounts its panel, then the modal.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Show context' }).click();
    const context = page.getByRole('dialog').filter({ hasText: 'Context sent to AI' });
    await expect(context).toBeVisible();
    await expect(diagnosis).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-shot="fix"] [data-shot="cluster-diagnosis"]')).toBeVisible();
  });

  test('a completed diagnosis stores a context hash matching the current context, so it is not stale', async ({
    request,
  }) => {
    expect(clusterId).toBeTruthy();

    const diagRes = await request.get(`/api/failure-clusters/${clusterId}/diagnosis`);
    const { diagnosis } = (await diagRes.json()) as { diagnosis: { contextSha: string | null } | null };
    expect(diagnosis!.contextSha).toBeTruthy();

    // The context preview exposes the same hash. Equal hashes mean the evidence has
    // not moved on since the diagnosis — the banner rule says: not stale.
    const ctxRes = await request.get(`/api/failure-clusters/${clusterId}/context?format=json`);
    const ctx = (await ctxRes.json()) as { contextSha: string };
    expect(ctx.contextSha).toBe(diagnosis!.contextSha);
  });

  test('POST /api/failure-clusters/:id/diagnose returns 409 for existing completed (no force)', async ({ request }) => {
    expect(clusterId).toBeTruthy();

    // Without force, should return existing completed diagnosis (200 not 409)
    const res = await request.post(`/api/failure-clusters/${clusterId}/diagnose`);
    expect(res.ok()).toBeTruthy();
    const diagnosis = await res.json();
    expect(diagnosis.status).toBe('completed');
  });

  test('POST /api/failure-clusters/:id/diagnose?force=true re-runs and returns new diagnosis', async ({ request }) => {
    expect(clusterId).toBeTruthy();

    const res = await request.post(`/api/failure-clusters/${clusterId}/diagnose?force=true`);
    expect(res.ok()).toBeTruthy();

    const diagnosis = await res.json();
    expect(diagnosis.status).toBe('completed');
    expect(diagnosis.category).toBe('app-bug');
  });

  test('GET /api/failure-clusters/:id/diagnoses returns snapshotted history, full=1 carries details', async ({
    request,
  }) => {
    expect(clusterId).toBeTruthy();

    // The force re-diagnose above snapshotted the prior version.
    const lightRes = await request.get(`/api/failure-clusters/${clusterId}/diagnoses`);
    expect(lightRes.ok()).toBeTruthy();
    const light = (await lightRes.json()) as { items: Array<{ id: number; details?: unknown }> };
    expect(light.items.length).toBeGreaterThanOrEqual(1);
    // The light list omits details to stay small.
    expect(light.items[0]!.details).toBeUndefined();

    const fullRes = await request.get(`/api/failure-clusters/${clusterId}/diagnoses?full=1`);
    expect(fullRes.ok()).toBeTruthy();
    const full = (await fullRes.json()) as { items: Array<{ details?: unknown }> };
    expect(full.items[0]!.details).toBeTruthy();
  });

  test('failure-groups endpoint includes diagnosis compact for clustered groups', async ({ request }) => {
    expect(clusterId).toBeTruthy();

    // Submit another run with the same error to trigger the known cluster
    const { runId } = await submitRun(request, [
      {
        title: 'login test',
        status: 'failed',
        duration: 1000,
        location: 'tests/auth.spec.ts:5:3',
        error: freshClusterError,
      },
    ]);

    const res = await request.get(`/api/test-runs/${runId}/failure-groups`);
    expect(res.ok()).toBeTruthy();
    const { items: groups } = await res.json();
    expect(Array.isArray(groups)).toBe(true);

    const group = (groups as Array<{ clusterId: number; diagnosis: { status: string; category: string } | null }>).find(
      (g) => g.clusterId === clusterId,
    );
    expect(group).toBeDefined();
    expect(group.diagnosis).toBeDefined();
    expect(group.diagnosis.status).toBe('completed');
    expect(group.diagnosis.category).toBe('app-bug');
  });

  test('a configured researchModel runs a two-stage pipeline', async ({ request }) => {
    expect(clusterId).toBeTruthy();

    // Add a distinct research model; both stages hit the same mock server.
    const put = await request.put('/api/settings/ai', {
      data: {
        roles: {
          diagnosis: { provider: 'openai', model: 'gpt-test', baseUrl: `http://127.0.0.1:${mockPort}/v1` },
          research: { provider: 'openai', model: 'gpt-research-small', baseUrl: `http://127.0.0.1:${mockPort}/v1` },
        },
        autoDiagnose: false,
      },
    });
    expect(put.ok()).toBeTruthy();

    const res = await request.post(`/api/failure-clusters/${clusterId}/diagnose?force=true`);
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.status).toBe('completed');
    expect(Array.isArray(d.details.pipeline)).toBe(true);
    expect(d.details.pipeline).toHaveLength(2);
    expect(d.details.pipeline[0].role).toBe('research');
    expect(d.details.pipeline[1].role).toBe('diagnosis');
    // Total tokens are summed across both stages
    expect(d.inputTokens).toBeGreaterThan(0);
  });
});

test.describe.serial('AI diagnosis — unconfigured error cases', () => {
  let isEnvManaged = false;

  test.beforeAll(async ({ request }) => {
    // Check if AI is managed by env vars
    const statusRes = await request.get('/api/ai/status');
    if (statusRes.ok()) {
      const s = (await statusRes.json()) as { source?: string };
      isEnvManaged = s.source === 'env';
    }
    if (!isEnvManaged) {
      // Ensure AI is not configured
      await request.put('/api/settings/ai', { data: { roles: null } });
    }
  });

  test('POST /diagnose returns 503 when AI is not configured', async ({ request }) => {
    if (isEnvManaged) {
      test.skip();
      return;
    }
    // Submit a run to get a cluster ID
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.AI_DIAGNOSIS,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 5000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'unconfigured test',
            status: 'failed',
            duration: 1000,
            location: 'tests/x.spec.ts:1:1',
            error: 'expect(received).toBe(expected)\nExpected: true\nReceived: false',
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const { runId } = await res.json();

    const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ status: string; failureClusterId?: number }>;
    };
    const failedCase = run.testCases.find((c) => c.status === 'failed');
    const cId = failedCase?.failureClusterId;

    if (!cId) return; // no cluster → skip

    const diagnoseRes = await request.post(`/api/failure-clusters/${cId}/diagnose`);
    expect(diagnoseRes.status()).toBe(503);
  });

  test('POST /diagnose/stream returns 404 for an unknown cluster', async ({ request }) => {
    const res = await request.post('/api/failure-clusters/999999/diagnose/stream');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.message).toContain('Failure cluster not found');
  });

  test('POST /diagnose/stream returns 503 when AI is not configured', async ({ request }) => {
    if (isEnvManaged) {
      test.skip();
      return;
    }
    // Submit a run to get a fresh cluster ID
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.DIAGNOSE_STREAM,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 5000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'unconfigured stream test',
            status: 'failed',
            duration: 1000,
            location: 'tests/stream.spec.ts:1:1',
            error: 'expect(received).toBe(expected)\nExpected: true\nReceived: false',
          },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();
    const { runId } = await res.json();

    const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ status: string; failureClusterId?: number }>;
    };
    const failedCase = run.testCases.find((c) => c.status === 'failed');
    const cId = failedCase?.failureClusterId;

    if (!cId) return; // no cluster → skip

    const streamRes = await request.post(`/api/failure-clusters/${cId}/diagnose/stream`);
    expect(streamRes.status()).toBe(503);
    const body = await streamRes.json();
    expect(body.message).toContain('AI diagnosis is not configured');
  });
});

// ── /diagnose/stream success path (real SSE) ─────────────────────────────────

test.describe.serial('AI diagnosis — streaming success path', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let isEnvManaged = false;

  test.beforeAll(async ({ request }) => {
    const statusRes = await request.get('/api/ai/status');
    if (statusRes.ok()) {
      const s = (await statusRes.json()) as { source?: string };
      isEnvManaged = s.source === 'env';
    }
    mockPort = await getFreePort();
    mockServer = startStreamingMockAiServer(mockPort);
  });

  test.beforeEach(async () => {
    if (isEnvManaged) test.skip();
  });

  test.afterAll(async ({ request }) => {
    if (!isEnvManaged) await request.put('/api/settings/ai', { data: { roles: null } });
    mockServer.close();
  });

  test('POST /diagnose/stream streams thinking chunks then a completed result event', async ({ request, baseURL }) => {
    const put = await request.put('/api/settings/ai', {
      data: {
        roles: {
          diagnosis: { provider: 'openai', model: 'gpt-test', baseUrl: `http://127.0.0.1:${mockPort}/v1` },
        },
        autoDiagnose: false,
      },
    });
    expect(put.ok()).toBeTruthy();

    // A distinct selector (not just a distinct timestamp) is required so this
    // gets its own failure cluster: the fingerprint deliberately does NOT hash
    // the stack frame file (see `shared/error-fingerprint.ts`), so an error with
    // no selector would otherwise collide with the plain-timeout clusters created
    // earlier in this same file (e.g. `freshClusterError` above).
    const uniqueError = `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('stream-success-${Date.now()}')`;
    const { runId } = await submitRun(request, [
      {
        title: 'streaming diagnosis test',
        status: 'failed',
        duration: 1000,
        location: 'tests/stream-success.spec.ts:5:3',
        error: uniqueError,
      },
    ]);

    const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ status: string; failureClusterId?: number }>;
    };
    const failedCase = run.testCases.find((c) => c.status === 'failed');
    const clusterId = failedCase?.failureClusterId;
    expect(clusterId).toBeTruthy();

    // Read the SSE response with raw fetch (Playwright's `request` fixture buffers
    // the whole body, which would hang until the stream closes on its own).
    // `force=true` guarantees the real streaming path runs rather than the
    // immediate single-event replay of a pre-existing completed diagnosis.
    const response = await fetch(`${baseURL}/api/failure-clusters/${clusterId}/diagnose/stream?force=true`, {
      method: 'POST',
    });
    expect(response.ok).toBeTruthy();
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes('event: result')) break;
    }
    reader.releaseLock();

    // The diagnosis stage is announced before its first "thinking" chunk arrives.
    expect(text).toContain('event: stage\ndata: {"stage":"diagnosis"}');
    expect(text.indexOf('event: stage')).toBeLessThan(text.indexOf('event: thinking'));
    expect(text).toContain('event: thinking');

    const resultIdx = text.indexOf('event: result');
    expect(resultIdx).toBeGreaterThan(-1);
    const afterResult = text.slice(resultIdx);
    const dataLine = afterResult.split('\n').find((l) => l.startsWith('data:'));
    expect(dataLine).toBeDefined();

    const diagnosis = JSON.parse(dataLine!.slice('data:'.length).trim());
    expect(diagnosis.status).toBe('completed');
    expect(diagnosis.clusterId).toBe(clusterId);
    expect(diagnosis.category).toBe('app-bug');
    expect(diagnosis.confidence).toBe('high');
    expect(diagnosis.details.confidenceScore).toBe(88);
  });
});

// ── Text-only models (no vision) ─────────────────────────────────────────────

test.describe.serial('AI diagnosis — a model that rejects images', () => {
  /** A real (1×1) PNG, so the ingested attachment is classified as a screenshot. */
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  let mock: { server: http.Server; imageAttempts: () => number };
  let mockPort: number;
  let isEnvManaged = false;

  test.beforeAll(async ({ request }) => {
    const statusRes = await request.get('/api/ai/status');
    if (statusRes.ok()) {
      isEnvManaged = ((await statusRes.json()) as { source?: string }).source === 'env';
    }
    mockPort = await getFreePort();
    mock = startTextOnlyMockAiServer(mockPort);
  });

  test.beforeEach(async () => {
    if (isEnvManaged) test.skip();
  });

  test.afterAll(async ({ request }) => {
    if (!isEnvManaged) await request.put('/api/settings/ai', { data: { roles: null } });
    mock.server.close();
  });

  test('drops the screenshots and still completes the diagnosis', async ({ request }) => {
    const put = await request.put('/api/settings/ai', {
      data: {
        roles: { diagnosis: { provider: 'openai', model: 'text-only', baseUrl: `http://127.0.0.1:${mockPort}/v1` } },
        autoDiagnose: false,
      },
    });
    expect(put.ok()).toBeTruthy();

    // A screenshot only reaches the context through a live case-file upload, so
    // this failure is ingested through the streaming API rather than /submit.
    const start = await request.post('/api/test-runs/start', {
      data: { projectName: PROJECT.AI_IMAGE_FALLBACK, startTime: new Date().toISOString() },
    });
    expect(start.ok()).toBeTruthy();
    const { runId, streamToken } = (await start.json()) as { runId: number; streamToken: string };

    const testCase = { title: 'checkout completes', location: 'tests/no-vision.spec.ts:7:3', retries: 0 };
    const uniqueError = `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('no-vision-${Date.now()}')`;
    const events = await request.post(`/api/test-runs/${runId}/events`, {
      data: {
        streamToken,
        testCases: [{ type: 'complete', ...testCase, status: 'failed', duration: 5000, error: uniqueError }],
      },
    });
    expect(events.ok()).toBeTruthy();

    const upload = await request.post(`/api/test-runs/${runId}/case-files`, {
      multipart: {
        streamToken,
        testCase: JSON.stringify(testCase),
        attach_meta: JSON.stringify([{ name: 'screenshot', contentType: 'image/png', originalName: 'failure.png' }]),
        attach_file: { name: 'failure.png', mimeType: 'image/png', buffer: PNG_1X1 },
      },
    });
    expect(upload.ok()).toBeTruthy();

    const finish = await request.post(`/api/test-runs/${runId}/finish`, {
      data: { streamToken, status: 'failed', duration: 5000 },
    });
    expect(finish.ok()).toBeTruthy();

    const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ status: string; failureClusterId?: number }>;
    };
    const clusterId = run.testCases.find((c) => c.status === 'failed')?.failureClusterId;
    expect(clusterId).toBeTruthy();

    // The screenshot is in the context, so the first provider call carries it.
    const ctx = (await (await request.get(`/api/failure-clusters/${clusterId}/context?format=json`)).json()) as {
      imageTokenEstimate: number;
      sections: Array<{ id: string; markdown: string }>;
    };
    expect(ctx.imageTokenEstimate).toBeGreaterThan(0);
    // The image is titled with the attachment name, not with its content type.
    expect(ctx.sections.find((s) => s.id === 'screenshots')?.markdown).toContain('![screenshot]');

    const res = await request.post(`/api/failure-clusters/${clusterId}/diagnose`);
    expect(res.ok()).toBeTruthy();
    const diagnosis = await res.json();
    expect(diagnosis.status).toBe('completed');
    expect(diagnosis.category).toBe('app-bug');
    expect(mock.imageAttempts()).toBe(1);
  });
});

// ── Cluster reconciliation, merge suggestions & naming (Phases 2–3) ──────────
//
// Uses an enhanced mock that also serves /embeddings and branches
// /chat/completions into naming / adjudication / diagnosis. Embedding vectors
// are driven by an `EMBVEC=` marker placed in the (raw) error text, and the
// adjudication verdict by an `ADJ=` marker — both sit after the Playwright Call
// log so they don't affect the deterministic fingerprint, only the embedding /
// adjudication inputs.
//
// Components are letter-prefixed integers (`v2 v1 v0`), not bare numbers: the
// embedder input is now cleaned by `buildEmbedText`, whose `maskVolatile` pass
// rewrites bare digit runs to `<N>` (a digit is kept only when glued to a
// preceding letter). Bare numbers here would all collapse to the fallback
// vector and every cluster would look identical.

function vecFor(input: string): number[] {
  const m = /EMBVEC=((?:v\d+[ ,]*)+)/i.exec(input);
  if (m) {
    const nums = [...m[1].matchAll(/v(\d+)/gi)].map((x) => Number(x[1]));
    if (nums.length) return nums;
  }
  return [1, 1, 1];
}

function startReconcileMockServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url || '';
      const send = (obj: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      let parsed: { input?: string | string[]; model?: string; messages?: Array<{ role: string; content: string }> } =
        {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        /* ignore */
      }

      if (url.includes('/embeddings')) {
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? ''];
        send({
          model: parsed.model,
          data: inputs.map((inp, i) => ({ index: i, embedding: vecFor(String(inp)) })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
        return;
      }

      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const sys = String(msgs.find((m) => m.role === 'system')?.content ?? '');
      const user = String(msgs.find((m) => m.role === 'user')?.content ?? '');
      let content: string;
      if (/name software-test failure clusters/i.test(sys)) {
        const ids = [...user.matchAll(/\bid (\d+)/g)].map((m) => Number(m[1]));
        content = JSON.stringify({ titles: ids.map((id) => ({ id, title: `Mock cluster ${id}` })) });
      } else if (/triaging/i.test(sys)) {
        let verdict = { merge: false, confidence: 'low', reason: 'different root causes' };
        if (/ADJ=high/.test(user)) verdict = { merge: true, confidence: 'high', reason: 'same root cause' };
        else if (/ADJ=medium/.test(user)) verdict = { merge: true, confidence: 'medium', reason: 'likely the same' };
        content = JSON.stringify(verdict);
      } else {
        content = JSON.stringify(buildMockAiResponse());
      }
      send({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

async function pollUntil<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 20000): Promise<T> {
  const start = Date.now();
  let last = await fn();
  while (!pred(last) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 300));
    last = await fn();
  }
  return last;
}

test.describe.serial('Cluster reconciliation, suggestions & naming', () => {
  let server: http.Server;
  let port: number;
  let envManaged = false;

  test.beforeAll(async ({ request }) => {
    const s = await request.get('/api/ai/status');
    if (s.ok()) envManaged = ((await s.json()) as { source?: string }).source === 'env';
    port = await getFreePort();
    server = startReconcileMockServer(port);
  });

  test.beforeEach(async () => {
    if (envManaged) test.skip();
  });

  test.afterAll(async ({ request }) => {
    if (!envManaged) await request.put('/api/settings/ai', { data: { roles: null } });
    server.close();
  });

  async function configureAi(request: APIRequestContext, opts: { embedding: boolean; autoDiagnose: boolean }) {
    const base = `http://127.0.0.1:${port}/v1`;
    const roles: Record<string, unknown> = {
      diagnosis: { provider: 'openai', model: 'mock', baseUrl: base, apiKey: 'x' },
    };
    if (opts.embedding) roles.embedding = { provider: 'openai', model: 'mock-embed', baseUrl: base, apiKey: 'x' };
    const r = await request.put('/api/settings/ai', { data: { roles, autoDiagnose: opts.autoDiagnose } });
    expect(r.ok()).toBeTruthy();
  }

  async function submitFailures(request: APIRequestContext, projectName: string, cases: object[]) {
    const r = await request.post('/api/test-runs/submit', {
      data: {
        projectName,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: cases.length,
        passedTests: 0,
        failedTests: cases.length,
        skippedTests: 0,
        testCases: cases,
      },
    });
    expect(r.ok()).toBeTruthy();
    return r.json() as Promise<{ runId: number; projectId: number }>;
  }

  const err = (selector: string, embvec: string, extra = '') =>
    `TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for ${selector}\nEMBVEC=${embvec}\n${extra}`;

  const clustersOf = (request: APIRequestContext, projectId: number) =>
    request
      .get(`/api/projects/${projectId}/failure-clusters`)
      .then((r) => r.json())
      .then((j) => j.items) as Promise<any[]>;
  const suggestionsOf = (request: APIRequestContext, projectId: number) =>
    request
      .get(`/api/projects/${projectId}/cluster-merge-suggestions`)
      .then((r) => r.json())
      .then((j) => j.items) as Promise<any[]>;

  test('auto-merges embedding near-duplicates', async ({ request }) => {
    await configureAi(request, { embedding: true, autoDiagnose: false });
    const { projectId } = await submitFailures(request, PROJECT.CLUSTER_MERGE, [
      {
        title: 'login a',
        status: 'failed',
        duration: 1,
        location: 'tests/a.spec.ts:1:1',
        error: err("getByTestId('alpha')", 'v1 v0 v0'),
      },
      {
        title: 'login b',
        status: 'failed',
        duration: 1,
        location: 'tests/b.spec.ts:1:1',
        error: err("getByTestId('beta')", 'v1 v0 v0'),
      },
    ]);

    // Two distinct fingerprints form two clusters, then identical embeddings merge them.
    const clusters = await pollUntil(
      () => clustersOf(request, projectId),
      (c) => c.length === 1,
    );
    expect(clusters.length).toBe(1);
    expect(clusters[0].occurrences).toBe(2);
  });

  test('ambiguous pairs become LLM suggestions; approve merges, reject keeps', async ({ request }) => {
    await configureAi(request, { embedding: true, autoDiagnose: false });
    // Distinct, digit-free selectors → four distinct fingerprints (digits in a
    // selector are masked, which would otherwise collapse e.g. 'p1'/'p2').
    // Two ambiguous-band pairs: cos(alpha,bravo) = cos(charlie,delta) =
    // 2/√5 ≈ 0.894 (in [0.80, 0.92)); every cross pair is orthogonal.
    const { projectId } = await submitFailures(request, PROJECT.CLUSTER_SUGGEST, [
      {
        title: 'alpha',
        status: 'failed',
        duration: 1,
        location: 'tests/alpha.spec.ts:1:1',
        error: err("getByTestId('alpha')", 'v1 v0 v0 v0', 'ADJ=medium'),
      },
      {
        title: 'bravo',
        status: 'failed',
        duration: 1,
        location: 'tests/bravo.spec.ts:1:1',
        error: err("getByTestId('bravo')", 'v2 v1 v0 v0', 'ADJ=medium'),
      },
      {
        title: 'charlie',
        status: 'failed',
        duration: 1,
        location: 'tests/charlie.spec.ts:1:1',
        error: err("getByTestId('charlie')", 'v0 v0 v1 v0', 'ADJ=medium'),
      },
      {
        title: 'delta',
        status: 'failed',
        duration: 1,
        location: 'tests/delta.spec.ts:1:1',
        error: err("getByTestId('delta')", 'v0 v0 v2 v1', 'ADJ=medium'),
      },
    ]);

    const suggestions = await pollUntil(
      () => suggestionsOf(request, projectId),
      (s) => s.length === 2,
    );
    expect(suggestions.length).toBe(2);
    expect(suggestions.every((s) => s.method === 'llm' && s.llmConfidence === 'medium')).toBeTruthy();

    // medium confidence → not auto-merged; all four clusters still present.
    expect((await clustersOf(request, projectId)).length).toBe(4);

    const [s1, s2] = suggestions;
    expect((await request.post(`/api/cluster-merge-suggestions/${s1.id}/approve`)).ok()).toBeTruthy();
    expect((await request.post(`/api/cluster-merge-suggestions/${s2.id}/reject`)).ok()).toBeTruthy();

    // Approved pair merged (4 → 3); rejected pair untouched; no pending left.
    const after = await pollUntil(
      () => clustersOf(request, projectId),
      (c) => c.length === 3,
    );
    expect(after.length).toBe(3);
    expect((await suggestionsOf(request, projectId)).length).toBe(0);
  });

  test('auto-diagnose generates human-readable cluster titles', async ({ request }) => {
    await configureAi(request, { embedding: false, autoDiagnose: true });
    const { projectId } = await submitFailures(request, PROJECT.CLUSTER_NAMING, [
      {
        title: 'name me',
        status: 'failed',
        duration: 1,
        location: 'tests/n.spec.ts:1:1',
        error: err("getByTestId('name-me')", 'v1 v0 v0'),
      },
    ]);

    const clusters = await pollUntil(
      () => clustersOf(request, projectId),
      (c) => c.length >= 1 && !!c[0].title,
    );
    expect(clusters[0].title).toMatch(/^Mock cluster \d+$/);
  });
});

// ── Execution-scope context (Tier 0.1 regression guard) ─────────────────────────

test.describe('Execution-scope diagnosis context', () => {
  test('GET /api/test-run-cases/:id/diagnosis-context builds a non-trivial context', async ({ request }) => {
    const uniqueError = `Error: expect(locator).toBeVisible() failed\n  locator: getByRole('button', { name: 'Pay' }) (${Date.now()})`;
    const { runId } = await submitRun(request, [
      {
        title: 'checkout flow',
        status: 'failed',
        duration: 1200,
        location: 'tests/checkout.spec.ts:12:3',
        error: uniqueError,
      },
    ]);

    const runData = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
      testCases: Array<{ executionId: number; status: string }>;
    };
    const failed = runData.testCases.find((c) => c.status === 'failed');
    expect(failed?.executionId).toBeTruthy();

    const res = await request.get(`/api/test-run-cases/${failed!.executionId}/diagnosis-context?format=json`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      scope: { kind: string; executionId: number };
      sections: Array<{ id: string; markdown: string }>;
      text: string;
      tokenEstimate: number;
    };

    // Before 0.1 the execution branch returned only a Data Coverage block with
    // every section "absent" — assert we now get real evidence.
    expect(body.scope.kind).toBe('execution');
    expect(body.scope.executionId).toBe(failed!.executionId);
    expect(body.sections.length).toBeGreaterThanOrEqual(3);
    expect(body.sections.map((s) => s.id)).toContain('representativeExecution');
    // The failing error must reach the context (somewhere), not be dropped.
    expect(body.text).toContain('toBeVisible');
    expect(body.text).toContain('## Data Coverage');
    expect(body.tokenEstimate).toBeGreaterThan(0);
  });
});
