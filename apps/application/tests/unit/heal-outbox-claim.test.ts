import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { HealActionPayload } from '#shared/auto-heal';
import { migrateToLatest } from './temp-db';

/**
 * Heal actions open one PR each when sweeps overlap: every action is claimed
 * before the SCM is called, an action another sweep holds is left alone, and a
 * claim whose lease ran out is retried.
 */

const FILE = "test('pay', async ({ page }) => {\n  await page.getByRole('button', { name: 'Pay' }).click();\n});\n";
const OLD = "  await page.getByRole('button', { name: 'Pay' }).click();";
const NEW = "  await page.getByTestId('pay-btn').click();";

const scm = vi.hoisted(() => ({ pullRequests: 0 }));

// An SCM that answers after a moment, so a second sweep runs while the first is mid-sequence.
vi.mock('../../server/utils/scm', () => {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    createScmProvider: vi.fn(async () => ({
      provider: 'github',
      async getBranchHead(branch: string) {
        await pause();
        return branch === 'main' ? 'basesha' : null;
      },
      async findPullRequestForBranch() {
        return null;
      },
      async fetchFileAtRef() {
        return { content: FILE, truncated: false };
      },
      async createBranch() {},
      async commitFiles() {
        await pause();
        return 'newcommitsha';
      },
      async createPullRequest() {
        scm.pullRequests++;
        return { number: scm.pullRequests, url: `https://github.com/acme/app/pull/${scm.pullRequests}` };
      },
    })),
  };
});
vi.mock('../../server/utils/notifications/emit', () => ({ emitNotification: vi.fn(async () => {}) }));

delete process.env.PIWI_DATABASE_URL;
const { sweepHealActions } = await import('../../server/utils/heal/dispatch');
const { OUTBOX_LEASE_MS } = await import('../../server/utils/outbox');

let db: ReturnType<typeof drizzle<typeof schema>>;
let seq = 0;

function payload(): HealActionPayload {
  return {
    repositoryUrl: 'https://github.com/acme/app',
    provider: 'github',
    baseBranch: 'main',
    baseSha: 'basesha',
    branch: `piwi/heal/${seq}-deadbeef`,
    commitMessage: 'test: heal broken locators',
    title: 'test: heal broken locators',
    draft: true,
    verifyCommand: 'npx playwright test',
    edits: [
      {
        filePath: 'tests/a.spec.ts',
        line: 2,
        oldLine: OLD,
        newLine: NEW,
        failingLocator: "getByRole('button', { name: 'Pay' })",
        suggestedLocator: "getByTestId('pay-btn')",
        score: 100,
        source: 'prior-run',
        pickedByUser: false,
        clusterId: 1,
        executionId: 1,
        testTitle: 'pay',
        owner: null,
      },
    ],
  };
}

async function seedAction(over: Partial<typeof schema.healActions.$inferInsert> = {}): Promise<number> {
  seq++;
  const [row] = await db
    .insert(schema.healActions)
    .values({
      projectId: 1,
      dedupeKey: `heal:v1:1:${seq}`,
      status: 'pending',
      payload: payload(),
      scheduledFor: new Date(Date.now() - 1000),
      ...over,
    })
    .returning({ id: schema.healActions.id });
  return row!.id;
}

async function actionRow(id: number) {
  const [row] = await db.select().from(schema.healActions).where(eq(schema.healActions.id, id));
  return row!;
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'checkout' });
  await db.insert(schema.appSettings).values({ key: 'auto_heal', value: { enabled: true, projects: [1] } });
});

beforeEach(async () => {
  scm.pullRequests = 0;
  await db.delete(schema.healActions);
});

describe('sweepHealActions', () => {
  test('two sweeps started together open one PR for an action', async () => {
    const id = await seedAction();
    const results = await Promise.all([sweepHealActions(db as never), sweepHealActions(db as never)]);

    expect(scm.pullRequests).toBe(1);
    expect(results.reduce((n, r) => n + r.opened + r.failed + r.skipped, 0)).toBe(1);
    expect(await actionRow(id)).toMatchObject({ status: 'opened', attempts: 1 });
  });

  test('an action another sweep holds is left alone', async () => {
    const id = await seedAction({ status: 'processing', scheduledFor: new Date(Date.now() + OUTBOX_LEASE_MS) });

    expect(await sweepHealActions(db as never)).toEqual({ opened: 0, failed: 0, skipped: 0 });
    expect(scm.pullRequests).toBe(0);
    expect((await actionRow(id)).status).toBe('processing');
  });

  test('a claim whose lease ran out is retried', async () => {
    const id = await seedAction({ status: 'processing', scheduledFor: new Date(Date.now() - 1000) });

    expect(await sweepHealActions(db as never)).toEqual({ opened: 1, failed: 0, skipped: 0 });
    expect(scm.pullRequests).toBe(1);
    expect((await actionRow(id)).status).toBe('opened');
  });
});
