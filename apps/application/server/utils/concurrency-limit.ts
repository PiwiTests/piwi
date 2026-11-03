/**
 * A bound on concurrent calls: at most `maxRunning` run at once, and up to
 * `maxWaiting` more wait, then start in arrival order as running ones end.
 * The returned `run` answers null, without calling `fn`, when that many
 * already wait.
 *
 * In-memory, so it bounds one server process.
 */
export function createConcurrencyLimit(
  maxRunning: number,
  maxWaiting: number,
): <T>(fn: () => Promise<T>) => Promise<T> | null {
  let running = 0;
  const waiting: (() => void)[] = [];

  // An ending call hands its slot to the first waiting one, so a newcomer never starts ahead of it.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  async function start<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return function run<T>(fn: () => Promise<T>): Promise<T> | null {
    if (running < maxRunning) {
      running++;
      return start(fn);
    }
    if (waiting.length >= maxWaiting) return null;
    return new Promise<void>((resolve) => waiting.push(resolve)).then(() => start(fn));
  };
}
