/**
 * Settings → AI is one setting of the shared test server, and more than one
 * spec points it at a mock model of its own. A spec that changes it holds this
 * lock from its first test to its last, so another worker never swaps the
 * provider under it. The lock is a directory: creating it is atomic, and one
 * left behind by a crashed worker is taken over once it is stale.
 */
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_DIR = join(process.cwd(), '.test-temp', 'ai-settings.lock');
const STALE_MS = 10 * 60_000;
const POLL_MS = 250;

/** Wait for the lock, then hold it; the returned function releases it. */
export async function lockAiSettings(): Promise<() => void> {
  mkdirSync(join(process.cwd(), '.test-temp'), { recursive: true });
  while (true) {
    try {
      mkdirSync(LOCK_DIR);
      return () => rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      if (Date.now() - statSync(LOCK_DIR).mtimeMs > STALE_MS) rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {
      // Released meanwhile.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
