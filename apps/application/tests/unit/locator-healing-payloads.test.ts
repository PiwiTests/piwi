import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel (server/database/schema.ts) picks the PostgreSQL schema at
// import time when PIWI_DATABASE_URL is set, so clear it before the handler
// module (which imports the barrel) is loaded.
delete process.env.PIWI_DATABASE_URL;
const { getLocatorHealing, getLocatorHealingBatch } = await import('../../server/utils/locator-healing');

/**
 * The healing lookup must read the ARIA snapshot and test source through the
 * content-addressed `case_payloads` rows (streaming/submit ingest stores them
 * there with the inline columns left null) — not only through the legacy
 * inline columns the demo writer still uses.
 */

const ARIA = ['- heading "Piwi fixtures demo" [level=1] [ref=e9]', '- button "Load items" [ref=e11]'].join('\n');

const ERROR = [
  'Error: locator.click: Timeout 2000ms exceeded.',
  'Call log:',
  "  - waiting for getByRole('button', { name: 'Load records' })",
  '',
  '    at /repo/tests/failing-locator.spec.ts:24:60',
].join('\n');

let db: ReturnType<typeof drizzle<typeof schema>>;
let payloadCaseId: number;
let inlineCaseId: number;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);

  await db.insert(schema.projects).values({ id: 1, name: 'payloads-project' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  await db
    .insert(schema.testCases)
    .values({ id: 1, projectId: 1, filePath: 'tests/failing-locator.spec.ts', title: 'fails' });

  const payload = await db
    .insert(schema.casePayloads)
    .values({ projectId: 1, hash: 'a'.repeat(64), content: ARIA, size: ARIA.length })
    .returning({ id: schema.casePayloads.id });

  // Payload-stored variant: inline aria column left null, payload id set.
  const payloadRow = await db
    .insert(schema.testRunsCases)
    .values({
      testRunId: 1,
      testCaseId: 1,
      status: 'failed',
      error: ERROR,
      ariaSnapshot: null,
      ariaSnapshotPayloadId: payload[0]!.id,
      createdAt: new Date(),
    })
    .returning({ id: schema.testRunsCases.id });
  payloadCaseId = payloadRow[0]!.id;

  // Legacy inline variant: same content in the inline column, no payload.
  const inlineRow = await db
    .insert(schema.testRunsCases)
    .values({
      testRunId: 1,
      testCaseId: 1,
      status: 'failed',
      error: ERROR,
      ariaSnapshot: ARIA,
      createdAt: new Date(),
    })
    .returning({ id: schema.testRunsCases.id });
  inlineCaseId = inlineRow[0]!.id;
});

describe('getLocatorHealing with payload-stored content', () => {
  test('generates ARIA-fallback alternatives from a case_payloads-stored snapshot', async () => {
    const result = await getLocatorHealing(db, payloadCaseId);
    expect(result.source).toBe('aria-snapshot');
    expect(result.fromAriaSnapshot?.some((l) => l.locator.includes("'Load items'"))).toBe(true);
  });

  test('still reads the legacy inline column', async () => {
    const result = await getLocatorHealing(db, inlineCaseId);
    expect(result.source).toBe('aria-snapshot');
    expect(result.fromAriaSnapshot?.some((l) => l.locator.includes("'Load items'"))).toBe(true);
  });

  test('batch lookup coalesces payloads too', async () => {
    const results = await getLocatorHealingBatch(db, [payloadCaseId, inlineCaseId]);
    expect(results.get(payloadCaseId)?.source).toBe('aria-snapshot');
    expect(results.get(inlineCaseId)?.source).toBe('aria-snapshot');
  });
});
