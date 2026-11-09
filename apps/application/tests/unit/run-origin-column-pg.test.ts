import { describe, expect, test } from 'vitest';
import { runOrigin } from '#shared/run-eligibility';
import { backfillSql, ORIGIN_SHAPES, POSTGRES_MIGRATIONS } from './run-backfill';

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;

describe.skipIf(!postgresUrl)('the origin backfill on PostgreSQL (PIWI_POSTGRES_TEST_URL)', () => {
  test('reads each stored run as runOrigin does', async () => {
    const { default: postgres } = await import('postgres');
    const client = postgres(postgresUrl!, { max: 1, onnotice: () => {} });
    try {
      // A temporary table of the same name is the one the migration's UPDATE reaches in this session.
      await client`CREATE TEMP TABLE test_runs (id integer PRIMARY KEY, metadata jsonb, origin text NOT NULL DEFAULT 'local')`;
      const values = [null, ...ORIGIN_SHAPES];
      for (const [i, metadata] of values.entries()) {
        await client`INSERT INTO test_runs (id, metadata) VALUES (${i + 1}, ${metadata === null ? null : client.json(metadata as never)})`;
      }
      await client.unsafe(backfillSql(POSTGRES_MIGRATIONS));
      const rows = await client<Array<{ origin: string }>>`SELECT origin FROM test_runs ORDER BY id`;
      expect(rows.map((r) => r.origin)).toEqual(values.map((m) => runOrigin(m)));
    } finally {
      await client.end();
    }
  });
});
