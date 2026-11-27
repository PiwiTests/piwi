import { test, expect } from './fixtures';
import { retryPost } from './utils';
import { PROJECT } from '#shared/test-project-names';

/**
 * The operator's usage route, for whoever runs the instance without an account in it: the token of
 * PIWI_OPERATOR_TOKEN opens it, nothing else does, and it answers counts only, a run in progress among them.
 */

const TOKEN = process.env.PIWI_OPERATOR_TOKEN!;

test.describe('Operator usage', () => {
  test('opens to the operator token only, and counts a run in progress without naming it', async ({ request }) => {
    const refused: Record<string, string>[] = [{}, { Authorization: `Bearer ${TOKEN}x` }, { 'X-API-Key': TOKEN }];
    for (const headers of refused) {
      expect((await request.get('/api/operator/usage', { headers })).status(), JSON.stringify(headers)).toBe(401);
    }

    const setup = await (
      await retryPost(request, '/api/test-runs/setup', {
        data: { projectName: PROJECT.OPERATOR_USAGE, startTime: new Date().toISOString() },
      })
    ).json();
    try {
      const response = await request.get('/api/operator/usage', { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(response.status()).toBe(200);
      expect(response.headers()['cache-control']).toBe('no-store');
      const usage = await response.json();
      expect(usage.now.runsInProgress).toBeGreaterThanOrEqual(1);
      expect(Date.parse(usage.now.lastRunActivityAt)).not.toBeNaN();
      expect(usage).toMatchObject({
        now: {
          requestsInProgress: expect.any(Number),
          diagnosesInProgress: expect.any(Number),
          assistantAnswersInProgress: expect.any(Number),
          openEventStreams: expect.any(Number),
        },
        projects: expect.any(Number),
        users: expect.any(Number),
        runs: { total: expect.any(Number), last24Hours: expect.any(Number), last30Days: expect.any(Number) },
        storage: { files: expect.any(Number), bytes: expect.any(Number), quotaBytes: null },
        reporterVersions: expect.any(Array),
      });
      expect(JSON.stringify(usage)).not.toContain(PROJECT.OPERATOR_USAGE);
    } finally {
      const begun = await (
        await retryPost(request, `/api/test-runs/${setup.runId}/begin`, {
          data: { setupToken: setup.setupToken, totalTests: 0 },
        })
      ).json();
      await retryPost(request, `/api/test-runs/${setup.runId}/finish`, {
        data: { streamToken: begun.streamToken, status: 'passed', totalTests: 0 },
      });
    }
  });
});
