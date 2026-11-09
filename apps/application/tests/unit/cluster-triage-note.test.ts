import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { patchClusterStatus, bulkTriageClusters } = await import('#shared/handlers/failure-clusters');

const NOTE = 'Checkout API flaky on staging\nReopened automatically: regressed in run #7';

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
});

beforeEach(async () => {
  await db.delete(schema.failureClusters);
  const base = { projectId: 1, errorType: 'assertion', firstSeenRunId: 1, lastSeenRunId: 1, triageNote: NOTE };
  await db.insert(schema.failureClusters).values([
    { ...base, id: 1, fingerprint: 'a', signature: 'a' },
    { ...base, id: 2, fingerprint: 'b', signature: 'b' },
  ]);
});

async function noteOf(id: number) {
  const [row] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, id));
  return row?.triageNote;
}

describe('the triage note across status changes', () => {
  test('a status change without a note keeps the note', async () => {
    await patchClusterStatus(db, 1, 'resolved');
    expect(await noteOf(1)).toBe(NOTE);
  });

  test('a given note replaces it; an empty one or null clears it', async () => {
    await patchClusterStatus(db, 1, 'resolved', 'Fixed by the cart refactor');
    expect(await noteOf(1)).toBe('Fixed by the cart refactor');
    await patchClusterStatus(db, 1, 'open', '  ');
    expect(await noteOf(1)).toBeNull();
    await patchClusterStatus(db, 2, 'open', null);
    expect(await noteOf(2)).toBeNull();
  });

  test('bulk triage keeps every note', async () => {
    await bulkTriageClusters(db, [1, 2], { action: 'status', status: 'ignored' });
    expect([await noteOf(1), await noteOf(2)]).toEqual([NOTE, NOTE]);
  });
});
