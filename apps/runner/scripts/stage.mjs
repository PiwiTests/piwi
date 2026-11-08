// Put the built host and window where the Tauri shell bundles them: apps/desktop/src-tauri/resources/runner-host/
// (server.cjs, with the window's files in public/ beside it). The shell's `runner.conf.json` lists that folder as a
// resource. Run `npm run runner:build` and `npm run runner:window` first.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const host = path('../dist/server.cjs');
const window = path('../.output/public');
const destination = path('../../desktop/src-tauri/resources/runner-host');

for (const [what, from, command] of [
  ['host', host, 'runner:build'],
  ['window', window, 'runner:window'],
]) {
  if (!existsSync(from)) {
    console.error(`[stage] The ${what} is not built (${from}). Run: npm run ${command} --workspace=apps/runner`);
    process.exit(1);
  }
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(host, `${destination}/server.cjs`);
cpSync(window, `${destination}/public`, { recursive: true });
console.log(`[stage] Staged the host and the window in ${destination}`);
