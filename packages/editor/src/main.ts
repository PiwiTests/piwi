/**
 * Entry point of the bundled language server: serve over stdio (or the
 * transport the client passes on the command line: `--stdio`, `--node-ipc`,
 * `--socket=<port>`).
 */
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { startServer } from './server.js';

const connection = createConnection(ProposedFeatures.all);
// A rejected promise nothing waits on is logged in the editor's output; the service keeps serving.
process.on('unhandledRejection', (reason) =>
  connection.console.error(`Piwi: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`),
);
startServer(connection);
