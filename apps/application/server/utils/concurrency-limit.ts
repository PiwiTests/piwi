/**
 * A bound on concurrent calls: at most `maxRunning` run at once, and up to
 * `maxWaiting` more wait, then start in arrival order as running ones end.
 * A call made for a `client` also counts against that client's share: it holds
 * at most `maxPerClient` of the places, running or waiting. The returned `run`
 * answers null, without calling `fn`, when that many already wait or the
 * client holds its whole share. A call made for no client counts against no
 * share.
 *
 * In-memory, so it bounds one server process.
 */
export function createConcurrencyLimit(
  maxRunning: number,
  maxWaiting: number,
  maxPerClient = Infinity,
): <T>(fn: () => Promise<T>, client?: string) => Promise<T> | null {
  let running = 0;
  const waiting: (() => void)[] = [];
  /** The places each client holds, running or waiting; a client holding none has no entry. */
  const held = new Map<string, number>();

  // An ending call hands its slot to the first waiting one, so a newcomer never starts ahead of it.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  const leave = (client: string | undefined) => {
    if (client === undefined) return;
    const count = (held.get(client) ?? 1) - 1;
    if (count > 0) held.set(client, count);
    else held.delete(client);
  };

  async function start<T>(fn: () => Promise<T>, client: string | undefined): Promise<T> {
    try {
      return await fn();
    } finally {
      leave(client);
      release();
    }
  }

  return function run<T>(fn: () => Promise<T>, client?: string): Promise<T> | null {
    if (client !== undefined && (held.get(client) ?? 0) >= maxPerClient) return null;
    if (running >= maxRunning && waiting.length >= maxWaiting) return null;
    if (client !== undefined) held.set(client, (held.get(client) ?? 0) + 1);
    if (running < maxRunning) {
      running++;
      return start(fn, client);
    }
    return new Promise<void>((resolve) => waiting.push(resolve)).then(() => start(fn, client));
  };
}
