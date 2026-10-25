/**
 * Entry point of the bundled language server: serve over stdio (or the
 * transport the client passes on the command line: `--stdio`, `--node-ipc`,
 * `--socket=<port>`). The process's discovery file (`discovery.ts`) is written
 * once the service listens and removed on every way out it can hear: the
 * client's shutdown and exit, the process's own exit (the client gone, its
 * process ended), and the signals that end it.
 */
import * as os from 'node:os';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { editorsDir, removeDiscovery, writeDiscovery } from './discovery.js';
import { startServer } from './server.js';

const connection = createConnection(ProposedFeatures.all);
// A rejected promise nothing waits on is logged in the editor's output; the service keeps serving.
process.on('unhandledRejection', (reason) =>
  connection.console.error(`Piwi: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`),
);

let published: string | null = null;
const unpublish = () => {
  if (published) removeDiscovery(published);
  published = null;
};
process.on('exit', unpublish);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    unpublish();
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  });
}

startServer(connection, {
  publish: (discovery) => {
    unpublish();
    if (discovery) published = writeDiscovery(editorsDir(), discovery);
  },
});
