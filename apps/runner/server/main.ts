/**
 * The entry of Piwi Runner's sidecar: reads what the shell hands it in the environment, serves the host on the loopback
 * address and port the shell chose, and stops with the shell.
 *  - `PIWI_DESKTOP_TOKEN`: the access token (required).
 *  - `PIWI_RUNNER_PORT`: the port on `127.0.0.1` (required).
 *  - `PIWI_RUNNER_ROOT`: the folder of the window's files; `public` beside this file by default.
 */
import * as http from 'node:http';
import * as path from 'node:path';
import { setRunTargetKind, setRunTargetVersion, shutdownRunTarget } from '@piwitests/editor/run-target';
import { runnerHandler } from './host';

declare const __PIWI_RUNNER_VERSION__: string | undefined;

const token = process.env.PIWI_DESKTOP_TOKEN;
const port = Number(process.env.PIWI_RUNNER_PORT);
if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('[runner] PIWI_DESKTOP_TOKEN and PIWI_RUNNER_PORT are required.');
  process.exit(1);
}

setRunTargetKind('runner');
setRunTargetVersion(typeof __PIWI_RUNNER_VERSION__ === 'string' ? __PIWI_RUNNER_VERSION__ : '');

const root = process.env.PIWI_RUNNER_ROOT || path.join(__dirname, 'public');
const server = http.createServer(runnerHandler({ token, root }));
// A listen that fails ends the process with the reason on stderr; the shell logs it and starts the sidecar again.
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `[runner] Port ${port} on 127.0.0.1 is already in use.`
      : `[runner] The host stopped: ${error.message}`,
  );
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`[runner] Listening on 127.0.0.1:${port}`));

// A rejection nobody awaited is logged and the host keeps serving, as the dashboard's server does.
process.on('unhandledRejection', (reason) => {
  console.error('[runner] Unhandled rejection:', reason);
});

function stop(): void {
  shutdownRunTarget();
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
