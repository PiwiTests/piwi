import { describe, expect, test } from 'vitest';
import { openPostgresPool } from '../../server/database/postgres-pool';

/**
 * The server's PostgreSQL pool runs its queries with JIT compilation off, the parameter its connections send as they
 * open. Runs against `PIWI_POSTGRES_TEST_URL`.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;

describe.skipIf(!postgresUrl)('the PostgreSQL pool', async () => {
  const { default: postgres } = await import('postgres');

  test('runs its queries with JIT compilation off', async () => {
    const client = await openPostgresPool(postgres, postgresUrl!, { max: 1, onnotice: () => {} });
    try {
      expect(await client`SHOW jit`).toEqual([{ jit: 'off' }]);
    } finally {
      await client.end();
    }
  });
});
