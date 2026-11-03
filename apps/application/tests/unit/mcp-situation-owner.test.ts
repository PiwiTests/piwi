import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { McpContext } from '../../server/utils/mcp/tools';
import type { User } from '../../server/database/schema';
import { InstanceRole, ProjectRole, buildAccessSummary } from '#shared/permissions';
import { compileCodeowners, parseCodeowners } from '@piwitests/core/codeowners';
import { withStoredVerdicts } from './stored-verdicts';

/**
 * The situation sentence an agent reads names the owner the execution page
 * names: explain_failure and get_fix_plan fall back to the repository's
 * CODEOWNERS for a failing test with no `piwi:owner` annotation. explain_failure
 * also says whether the execution is the latest of its test, and which one is,
 * and gives a test that passed on retry its failed attempt's headline and execution.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

vi.mock('../../server/utils/scm', () => ({
  createScmProvider: async () => ({
    fetchCodeowners: async () => compileCodeowners(parseCodeowners('tests/checkout.spec.ts @payments\n')),
  }),
}));

const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');

const tool = (name: string) => {
  const found = MCP_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.handler;
};

const viewer: McpContext = {
  user: { id: 2, role: InstanceRole.MEMBER, name: 'Sam', username: 'sam' } as User,
  access: buildAccessSummary(InstanceRole.MEMBER, [{ projectId: 1, role: ProjectRole.VIEWER }]),
  scope: new Set([1]),
};

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db
    .insert(schema.testCases)
    .values({ id: 1, projectId: 1, title: 'pays by card', filePath: 'tests/checkout.spec.ts' });
  await db.insert(schema.testRuns).values({
    id: 1,
    projectId: 1,
    status: 'failed',
    startTime: new Date('2026-09-01T10:00:00Z'),
    metadata: { scm: { remoteUrl: 'https://github.com/acme/shop.git', branch: 'main' } },
  });
  await db.insert(schema.failureClusters).values({
    id: 1,
    projectId: 1,
    errorType: 'unknown',
    fingerprint: 'fp-1',
    signature: 'Error: card declined',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
  });
  await db.insert(schema.testRunsCases).values(
    withStoredVerdicts({
      id: 10,
      testRunId: 1,
      testCaseId: 1,
      status: 'failed',
      error: 'Error: card declined',
      failureClusterId: 1,
    }),
  );
});

afterAll(async () => {
  await close();
});

describe('the owner in the situation an agent reads', () => {
  test('explain_failure names the CODEOWNERS owner', async () => {
    const result = (await tool('explain_failure')(db as never, { executionId: 10 }, viewer)) as { situation?: string };
    expect(result.situation).toMatch(/Owner @payments\.$/);
  });

  test("get_fix_plan's situation names the owner its ownership names", async () => {
    const result = (await tool('get_fix_plan')(db as never, { clusterId: 1 }, viewer)) as {
      situation?: string | null;
      ownership: { owner: string | null; source: string | null };
    };
    expect(result.ownership).toEqual({ owner: '@payments', source: 'codeowners' });
    expect(result.situation).toMatch(/Owner @payments\.$/);
  });
});

describe('whether the execution is the latest, as an agent reads it', () => {
  type Latest = { isLatest: boolean; executionId?: number; runId?: number; status?: string };

  test('explain_failure says the only execution is the latest', async () => {
    const result = (await tool('explain_failure')(db as never, { executionId: 10 }, viewer)) as { latest?: Latest };
    expect(result.latest).toEqual({ isLatest: true });
  });

  test('after a later run, explain_failure names the newest execution, its run and its status', async () => {
    await db.insert(schema.testRuns).values({
      id: 2,
      projectId: 1,
      status: 'failed',
      startTime: new Date('2026-09-02T10:00:00Z'),
      metadata: { scm: { remoteUrl: 'https://github.com/acme/shop.git', branch: 'main' } },
    });
    await db.insert(schema.testRunsCases).values(
      withStoredVerdicts({
        id: 11,
        testRunId: 2,
        testCaseId: 1,
        status: 'failed',
        error: 'Error: card declined',
        failureClusterId: 1,
      }),
    );
    const result = (await tool('explain_failure')(db as never, { executionId: 10 }, viewer)) as { latest?: Latest };
    expect(result.latest).toEqual({ isLatest: false, executionId: 11, runId: 2, status: 'failed' });
    const newest = (await tool('explain_failure')(db as never, { executionId: 11 }, viewer)) as { latest?: Latest };
    expect(newest.latest).toEqual({ isLatest: true });
  });
});

describe('a test that passed on retry, as an agent reads it', () => {
  test("explain_failure gives its failed attempt's headline and execution, the attempt in the situation and the attempts step", async () => {
    await db
      .insert(schema.testCases)
      .values({ id: 2, projectId: 1, title: 'keeps the cart', filePath: 'tests/cart.spec.ts' });
    await db
      .insert(schema.testRuns)
      .values({ id: 3, projectId: 1, status: 'passed', startTime: new Date('2026-09-03T10:00:00Z') });
    await db.insert(schema.testRunsCases).values(
      withStoredVerdicts([
        { id: 20, testRunId: 3, testCaseId: 2, status: 'failed', retries: 0, error: 'Error: card declined' },
        { id: 21, testRunId: 3, testCaseId: 2, status: 'passed', retries: 1 },
      ]),
    );
    const failed = (await tool('explain_failure')(db as never, { executionId: 20 }, viewer)) as {
      headline?: string;
      failedAttempt?: unknown;
    };
    const result = (await tool('explain_failure')(db as never, { executionId: 21 }, viewer)) as {
      headline?: string;
      failedAttempt?: unknown;
      situation?: string;
      nextStep?: { kind: string };
    };
    expect(failed.headline).toBeTruthy();
    expect(failed.failedAttempt).toBeUndefined();
    expect(result.headline).toBe(failed.headline);
    expect(result.failedAttempt).toEqual({ executionId: 20, retry: 0 });
    expect(result.situation).toMatch(/^Failed on attempt 1, passed on attempt 2/);
    expect(result.nextStep?.kind).toBe('compare-attempts');
  });
});
