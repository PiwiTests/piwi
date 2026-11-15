// The spare test worker `piwi-turbo test` starts with the runner. It loads Playwright's bundles while the runner starts,
// records the environment variables they read as they load, and reports them. Handed off, it takes the environment of
// the worker Playwright meant to start and runs Playwright's worker entry in this process.
import { DISCARD_CODE_CACHE, SPARE_ENTRY, SPARE_PRELOAD, type SpareHandoff, type SpareLoaded } from './startup-env';

const entry = process.env[SPARE_ENTRY];
const preload: string[] = JSON.parse(process.env[SPARE_PRELOAD] ?? '[]');
if (!entry || !process.send) process.exit(1);
process.argv[1] = entry;

let handedOff = false;
const exitUnlessHandedOff = () => {
  if (handedOff) return;
  (globalThis as { [DISCARD_CODE_CACHE]?: boolean })[DISCARD_CODE_CACHE] = true;
  process.exit(0);
};
process.on('disconnect', exitUnlessHandedOff);

const handoff = new Promise<NodeJS.ProcessEnv>((resolve) => {
  const onMessage = (message: SpareHandoff) => {
    if (message?.method !== '__piwi_turbo_spare_handoff__') return;
    process.off('message', onMessage);
    resolve(message.env);
  };
  process.on('message', onMessage);
});

const env = process.env;
const envRead = new Set<string>();
const record = (key: string | symbol) => typeof key === 'string' && envRead.add(key);
process.env = new Proxy(env, {
  get: (target, key) => (record(key), Reflect.get(target, key)),
  has: (target, key) => (record(key), Reflect.has(target, key)),
});
try {
  for (const id of preload) require(id);
} finally {
  process.env = env;
}
process.send({ method: '__piwi_turbo_spare_loaded__', envRead: [...envRead] } satisfies SpareLoaded);

void handoff.then((workerEnv) => {
  handedOff = true;
  process.off('disconnect', exitUnlessHandedOff);
  for (const key of Object.keys(process.env)) if (workerEnv[key] === undefined) delete process.env[key];
  for (const [key, value] of Object.entries(workerEnv)) if (value !== undefined) process.env[key] = value;
  require(entry);
});
