/**
 * The LIVE end-to-end test of the AI diagnosis pipeline: a real failure is
 * ingested, then diagnosed by a REAL model through the same endpoints the
 * dashboard calls — context assembly, the provider call, schema-validated
 * parsing and persistence, on both the synchronous and the SSE path.
 *
 * `tests/ai-diagnosis.spec.ts` covers the same endpoints against a mock provider
 * for a zero-token CI gate; this one costs tokens, so it lives under `tests/live/`
 * (excluded from the main suite) and runs behind `npm run app:test:ai:live` —
 * see `playwright.config.ts` next to this file.
 *
 * The model is text-only, so the server runs with screenshots disabled and the
 * first test proves an attached screenshot really is kept out of the context: an
 * image would make the provider reject the whole diagnosis call.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DIAGNOSIS_CATEGORIES, DIAGNOSIS_CONFIDENCES, DIAGNOSIS_SEVERITIES } from '#shared/ai-diagnosis';
import { PROJECT } from '#shared/test-project-names';

test.describe.configure({ mode: 'serial' });

/** A real (1×1) PNG, so the ingested attachment is classified as a screenshot. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const EXPECTED_MODEL = process.env.PIWI_AI_MODEL || 'deepseek-v4-flash';

interface Diagnosis {
  status: string;
  error: string | null;
  clusterId: number | null;
  provider: string;
  model: string;
  category: string;
  confidence: string;
  summary: string;
  rootCause: string;
  inputTokens: number | null;
  outputTokens: number | null;
  details: {
    severity: string;
    confidenceScore: number;
    hypotheses: Array<{ category: string; rootCause: string; likelihood: number; evidence: string[] }>;
    investigationSteps: string[];
    preventionTips: string[];
    pipeline: Array<{ role: string; model: string; inputTokens: number | null; outputTokens: number | null }>;
  };
}

/**
 * Ingest one failing execution through the streaming API and return its cluster.
 * `attachScreenshot` uploads a PNG for the case, which is what the context has
 * to leave out for a text-only model.
 */
async function ingestFailure(
  request: APIRequestContext,
  opts: { title: string; location: string; error: string; attachScreenshot?: boolean },
): Promise<{ clusterId: number; testRunsCaseId: number }> {
  const start = await request.post('/api/test-runs/start', {
    data: { projectName: PROJECT.AI_LIVE_DIAGNOSIS, startTime: new Date().toISOString() },
  });
  expect(start.ok()).toBeTruthy();
  const { runId, streamToken } = (await start.json()) as { runId: number; streamToken: string };

  const testCase = { title: opts.title, location: opts.location, retries: 0 };
  const events = await request.post(`/api/test-runs/${runId}/events`, {
    data: {
      streamToken,
      testCases: [{ type: 'complete', ...testCase, status: 'failed', duration: 5000, error: opts.error }],
    },
  });
  expect(events.ok()).toBeTruthy();

  if (opts.attachScreenshot) {
    const upload = await request.post(`/api/test-runs/${runId}/case-files`, {
      multipart: {
        streamToken,
        testCase: JSON.stringify(testCase),
        attach_meta: JSON.stringify([{ name: 'screenshot', contentType: 'image/png', originalName: 'failure.png' }]),
        attach_file: { name: 'failure.png', mimeType: 'image/png', buffer: PNG_1X1 },
      },
    });
    expect(upload.ok()).toBeTruthy();
    expect((await upload.json()).attachments).toBe(1);
  }

  const finish = await request.post(`/api/test-runs/${runId}/finish`, {
    data: { streamToken, status: 'failed', duration: 5000 },
  });
  expect(finish.ok()).toBeTruthy();

  const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
    testCases: Array<{ executionId: number; status: string; failureClusterId?: number }>;
  };
  const failed = run.testCases.find((c) => c.status === 'failed');
  expect(failed?.failureClusterId).toBeTruthy();
  return { clusterId: failed!.failureClusterId!, testRunsCaseId: failed!.executionId };
}

/** Assert a live diagnosis came back complete and inside the schema's vocabulary. */
function expectWellFormedDiagnosis(diagnosis: Diagnosis, clusterId: number): void {
  expect(diagnosis.error).toBeNull();
  expect(diagnosis.status).toBe('completed');
  expect(diagnosis.clusterId).toBe(clusterId);
  expect(diagnosis.provider).toBe('openai');
  expect(diagnosis.model.toLowerCase()).toContain(EXPECTED_MODEL.toLowerCase());

  expect(DIAGNOSIS_CATEGORIES).toContain(diagnosis.category);
  expect(DIAGNOSIS_CONFIDENCES).toContain(diagnosis.confidence);
  expect(DIAGNOSIS_SEVERITIES).toContain(diagnosis.details.severity);
  expect(diagnosis.summary.length).toBeGreaterThan(0);
  expect(diagnosis.rootCause.length).toBeGreaterThan(0);
  expect(diagnosis.details.confidenceScore).toBeGreaterThanOrEqual(0);
  expect(diagnosis.details.confidenceScore).toBeLessThanOrEqual(100);

  expect(diagnosis.details.hypotheses.length).toBeGreaterThanOrEqual(1);
  for (const hypothesis of diagnosis.details.hypotheses) {
    expect(DIAGNOSIS_CATEGORIES).toContain(hypothesis.category);
    expect(hypothesis.likelihood).toBeGreaterThanOrEqual(0);
    expect(hypothesis.likelihood).toBeLessThanOrEqual(100);
  }
  // The top-level verdict is derived from the highest-ranked hypothesis.
  expect(diagnosis.category).toBe(diagnosis.details.hypotheses[0]!.category);
  expect(diagnosis.rootCause).toBe(diagnosis.details.hypotheses[0]!.rootCause);

  // A single stage: only a distinct research role adds a second one.
  expect(diagnosis.details.pipeline.map((s) => s.role)).toEqual(['diagnosis']);
  expect(diagnosis.inputTokens).toBeGreaterThan(0);
  expect(diagnosis.outputTokens).toBeGreaterThan(0);
}

test('the server is configured for a live model from the environment', async ({ request }) => {
  const res = await request.get('/api/ai/status');
  expect(res.ok()).toBeTruthy();

  const status = (await res.json()) as { configured: boolean; provider: string; model: string; source: string };
  expect(status.configured).toBe(true);
  expect(status.source).toBe('env');
  expect(status.provider).toBe('openai');
  expect(status.model).toBe(EXPECTED_MODEL);
});

test('a real model diagnoses a failure whose screenshot is kept out of the context', async ({ request }) => {
  const { clusterId, testRunsCaseId } = await ingestFailure(request, {
    title: 'checkout completes',
    location: 'tests/checkout.spec.ts:12:3',
    error: [
      'TimeoutError: locator.click: Timeout 30000ms exceeded.',
      'Call log:',
      "  - waiting for getByRole('button', { name: 'Checkout' })",
      '  -   locator resolved to <button disabled name="checkout">Checkout</button>',
      '  - element is not enabled',
      '',
      '   at tests/checkout.spec.ts:12:3',
    ].join('\n'),
    attachScreenshot: true,
  });

  // The screenshot really was ingested…
  const caseData = (await (await request.get(`/api/test-run-cases/${testRunsCaseId}`)).json()) as {
    attachments: Array<{ name: string; contentType: string }>;
  };
  expect(caseData.attachments.map((a) => a.name)).toContain('screenshot');

  // …and the context the model is sent still carries no image at all.
  const ctxRes = await request.get(`/api/failure-clusters/${clusterId}/context?format=json`);
  expect(ctxRes.ok()).toBeTruthy();
  const ctx = (await ctxRes.json()) as {
    sections: Array<{ id: string }>;
    imageTokenEstimate: number;
    textTokenEstimate: number;
  };
  expect(ctx.imageTokenEstimate).toBe(0);
  expect(ctx.sections.map((s) => s.id)).not.toContain('screenshots');
  expect(ctx.textTokenEstimate).toBeGreaterThan(0);

  const res = await request.post(`/api/failure-clusters/${clusterId}/diagnose`);
  expect(res.ok()).toBeTruthy();
  expectWellFormedDiagnosis((await res.json()) as Diagnosis, clusterId);

  // The completed row is what a page load reads back.
  const stored = (await (await request.get(`/api/failure-clusters/${clusterId}/diagnosis`)).json()) as {
    diagnosis: Diagnosis | null;
  };
  expect(stored.diagnosis).not.toBeNull();
  expectWellFormedDiagnosis(stored.diagnosis!, clusterId);
});

test('the streaming endpoint relays real model output and persists the result', async ({ request, baseURL }) => {
  const { clusterId } = await ingestFailure(request, {
    title: 'order confirmation appears',
    location: 'tests/order.spec.ts:20:5',
    error: [
      'Error: expect(locator).toBeVisible() failed',
      '',
      "Locator: getByTestId('order-confirmation')",
      'Expected: visible',
      'Received: <element(s) not found>',
      'Timeout: 5000ms',
      '',
      'Call log:',
      "  - waiting for getByTestId('order-confirmation')",
    ].join('\n'),
  });

  // Raw fetch, not the `request` fixture: that one buffers the whole body, which
  // would hang until the stream closes on its own.
  const response = await fetch(`${baseURL}/api/failure-clusters/${clusterId}/diagnose/stream`, { method: 'POST' });
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

  // Output arrived incrementally rather than in one final blob.
  expect(text.split('event: thinking').length - 1).toBeGreaterThan(1);

  const resultIdx = text.indexOf('event: result');
  expect(resultIdx).toBeGreaterThan(-1);
  const dataLine = text
    .slice(resultIdx)
    .split('\n')
    .find((l) => l.startsWith('data:'));
  expect(dataLine).toBeDefined();

  expectWellFormedDiagnosis(JSON.parse(dataLine!.slice('data:'.length).trim()) as Diagnosis, clusterId);
});
