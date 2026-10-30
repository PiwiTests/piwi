import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient, type Client } from '@libsql/client';
import { inject } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';

declare global {
  // Exposed when the test process runs with `--expose-gc` (the unit-test scripts set it).
  var gc: (() => void) | undefined;
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** The statements that rebuild a SQLite database holding every migration (`global-setup.ts`). */
    migratedSchema: string[];
  }
}

export type TempDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Gives an empty SQLite database the schema and rows every migration leaves, as Drizzle's `migrate` does, and in
 * the same connection state: one transaction with foreign keys off, then foreign keys on. Tests of the migrations
 * themselves run Drizzle's `migrate`.
 */
export async function migrateToLatest(db: { $client: Client }): Promise<void> {
  await db.$client.migrate(inject('migratedSchema'));
}

/**
 * A migrated SQLite database in a temporary file. Code that opens a transaction
 * needs one: libsql gives a `:memory:` database a single connection, which an
 * open transaction holds, so no other statement runs beside it.
 */
export async function openTempDb(): Promise<{ db: TempDb; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'piwi-unit-db-'));
  const client = createClient({ url: `file:${join(dir, 'test.db')}` });
  const db = drizzle(client, { schema });
  await migrateToLatest(db);

  async function close() {
    // The native libsql binding releases the file handles from a V8 finalizer, so
    // on Windows the file stays locked until a garbage collection runs.
    client.close();
    globalThis.gc?.();
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' || attempt >= 40) throw error;
        if (!globalThis.gc) {
          const junk: Buffer[] = [];
          for (let i = 0; i < 60; i++) junk.push(Buffer.alloc(1 << 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  return { db, close };
}
