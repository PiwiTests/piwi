/**
 * End-to-end coverage for the AI-step usage surface: submit a run whose test
 * cases carry the reporter's `aiUsage` manifest, then assert the project
 * `ai-steps` endpoint aggregates it. Exercises the full ingest path
 * (submit → sanitize → the `ai_usage` column) that the handler unit test cannot.
 */
import { test, expect } from './fixtures';
import { PROJECT } from '#shared/test-project-names';

const RUN_START = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const SHARED = 'tests/__piwi__/login.spec.ts/sign-in.the-email-field.aaaa1111.json';
const FLOW = 'tests/__piwi__/login.spec.ts/sign-in.sign-in-flow.bbbb2222.json';
const EMAIL_INTENT = {
  template: 'the email address field',
  locator: "getByRole('textbox', { name: 'Email' })",
  kind: 'locator',
};

test('project ai-steps endpoint aggregates the reporter AI-step usage manifest', async ({ request }) => {
  const res = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.AI_STEPS,
      status: 'passed',
      startTime: RUN_START,
      duration: 2000,
      totalTests: 2,
      passedTests: 2,
      failedTests: 0,
      skippedTests: 0,
      testCases: [
        {
          title: 'sign in',
          status: 'passed',
          duration: 500,
          location: 'tests/auth/login.spec.ts:1:1',
          // Two artifacts; the email locator is shared with the test below. The
          // intent mapping ties the compiled locator back to its prompt.
          aiUsage: { entries: [FLOW, SHARED], intents: [EMAIL_INTENT] },
        },
        {
          title: 'reset password',
          status: 'passed',
          duration: 400,
          location: 'tests/auth/reset.spec.ts:1:1',
          aiUsage: { entries: [SHARED] },
        },
      ],
    },
  });
  expect(res.ok()).toBeTruthy();
  const { projectId, runId } = (await res.json()) as { projectId: number; runId: number };
  expect(projectId).toBeGreaterThan(0);

  const covRes = await request.get(`/api/projects/${projectId}/ai-steps`);
  expect(covRes.ok()).toBeTruthy();
  const cov = (await covRes.json()) as {
    summary: { artifactCount: number; testCount: number; runCount: number; replayCount: number };
    artifacts: Array<{ entry: string; testCount: number; replayCount: number; lastSeen: string | null }>;
  };

  expect(cov.summary.artifactCount).toBe(2);
  expect(cov.summary.testCount).toBe(2);
  expect(cov.summary.replayCount).toBe(3);

  const shared = cov.artifacts.find((a) => a.entry === SHARED);
  const flow = cov.artifacts.find((a) => a.entry === FLOW);
  expect(shared, 'shared artifact present').toBeTruthy();
  expect(shared!.testCount, 'email locator is exercised by both tests').toBe(2);
  expect(flow!.testCount).toBe(1);
  expect(typeof shared!.lastSeen).toBe('string');

  // Intent round-trip: submit → sanitize → ai_usage column → case-detail payload,
  // where the healing panel and AI diagnosis read the prompt behind the locator.
  const runRes = await request.get(`/api/test-runs/${runId}`);
  expect(runRes.ok()).toBeTruthy();
  const run = (await runRes.json()) as { testCases: Array<{ id: number; executionId: number; title: string }> };
  const signIn = run.testCases.find((c) => c.title === 'sign in');
  expect(signIn, 'sign in run case present').toBeTruthy();

  const caseRes = await request.get(`/api/test-run-cases/${signIn!.executionId}`);
  expect(caseRes.ok()).toBeTruthy();
  const detail = (await caseRes.json()) as {
    aiUsage?: { entries: string[]; intents?: Array<{ template: string; locator: string; kind: string }> } | null;
  };
  expect(detail.aiUsage?.entries?.sort()).toEqual([FLOW, SHARED].sort());
  expect(detail.aiUsage?.intents).toEqual([EMAIL_INTENT]);
});

test('ai-steps endpoint 404s for an unknown project', async ({ request }) => {
  expect((await request.get('/api/projects/9999999/ai-steps')).status()).toBe(404);
});
