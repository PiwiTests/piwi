import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

declare global {
  // Exposed when the test process runs with `--expose-gc` (the unit-test scripts set it).
  var gc: (() => void) | undefined;
}

export type TempDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A migrated SQLite database in a temporary file. Code that opens a transaction
 * needs one: libsql gives a `:memory:` database a single connection, which an
 * open transaction holds, so no other statement runs beside it.
 */
export async function openTempDb(): Promise<{ db: TempDb; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'piwi-unit-db-'));
  const client = createClient({ url: `file:${join(dir, 'test.db')}` });
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
  });

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
