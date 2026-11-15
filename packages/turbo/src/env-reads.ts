// The environment variables and the working folder that code reads as it runs: what a process loaded ahead of time
// depends on, so it can tell whether a later environment would have loaded it differently.

/** What `load` read: the names of the environment variables, and whether it asked for the working folder. */
export interface Reads {
  env: Set<string>;
  cwd: boolean;
}

/**
 * Runs `load` with `process.env` and `process.cwd` watched, and returns what it read. A copy of the whole environment
 * (a spread, `Object.assign`), which reads each variable's descriptor before its value, is not a read of its
 * variables: Playwright's runner keeps such a copy for its worker processes and never uses it itself.
 */
export function recordReads(load: () => void): Reads {
  const reads: Reads = { env: new Set(), cwd: false };
  const env = process.env;
  const cwd = process.cwd;
  let copying: string | symbol | undefined;
  const record = (key: string | symbol) => typeof key === 'string' && reads.env.add(key);
  process.env = new Proxy(env, {
    get: (target, key) => {
      if (key === copying) copying = undefined;
      else record(key);
      return Reflect.get(target, key);
    },
    has: (target, key) => (record(key), Reflect.has(target, key)),
    getOwnPropertyDescriptor: (target, key) => {
      copying = key;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  process.cwd = () => {
    reads.cwd = true;
    return cwd();
  };
  try {
    load();
  } finally {
    process.env = env;
    process.cwd = cwd;
  }
  return reads;
}
