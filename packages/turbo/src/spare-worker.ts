// The spare test worker `piwi-turbo test` starts with the runner. It loads Playwright's bundles while the runner starts,
// records the environment variables they read as they load, reports them, and launches the browser the last run's
// first worker launched. Handed off, it takes the environment of the worker Playwright meant to start and runs
// Playwright's worker entry in this process, whose first launch takes that browser when it asks for the same one.
import { adoptEarlyBrowser, startEarlyBrowser, type EarlyBrowser } from './early-browser';
import { recordReads } from './env-reads';
import {
  DISCARD_CODE_CACHE,
  SPARE_CORE,
  SPARE_ENTRY,
  SPARE_PRELOAD,
  type SpareHandoff,
  type SpareLoaded,
} from './startup-env';

const entry = process.env[SPARE_ENTRY];
const preload: string[] = JSON.parse(process.env[SPARE_PRELOAD] ?? '[]');
const coreDir = process.env[SPARE_CORE];
const earlyBrowsers = process.env.PIWI_TURBO_EARLY_BROWSER !== '0' && !!coreDir;
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

let early: EarlyBrowser | undefined;
const reads = recordReads(() => {
  for (const id of preload) require(id);
  if (earlyBrowsers) early = startEarlyBrowser(coreDir!);
});
process.send({ method: '__piwi_turbo_spare_loaded__', envRead: [...reads.env] } satisfies SpareLoaded);

void handoff.then((workerEnv) => {
  handedOff = true;
  process.off('disconnect', exitUnlessHandedOff);
  for (const key of Object.keys(process.env)) if (workerEnv[key] === undefined) delete process.env[key];
  for (const [key, value] of Object.entries(workerEnv)) if (value !== undefined) process.env[key] = value;
  if (earlyBrowsers) {
    const log = process.env.PIWI_TURBO_DEBUG
      ? (message: string) => process.stderr.write(`piwi-turbo: ${message}\n`)
      : undefined;
    adoptEarlyBrowser(coreDir!, early, log);
  }
  require(entry);
});
