import { createKeyedLock } from './keyed-lock';

const instanceLock = createKeyedLock<string>();

/**
 * Run `fn` alone among the requests that create or join a run of one project
 * instance (`/setup`, `/start`, `/begin`, `/submit`, `/upload`). Each looks for
 * the instance's active run before it creates one, so shards of a run that
 * arrive together end in that one run. A request with no instance id has no run
 * to join and runs at once.
 */
export function withInstanceRunLock<T>(
  projectId: number,
  instanceId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!instanceId) return fn();
  return instanceLock(`${projectId}\u0000${instanceId}`, fn);
}
