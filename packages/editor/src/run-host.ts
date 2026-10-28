/**
 * The run control a host other than the language server builds on: the desktop app's server, the hub of the runs its
 * shell starts (`apps/application/server/utils/desktop-runs.ts`). Each piece is the service's own, and none speaks the
 * Language Server Protocol: the socket every run names, which takes the workers' run connections with its token
 * (`RecordChannel`); the sessions and the controls they pass on (`RunSessions`); the hub's WebSocket for Piwi Picker,
 * and the peers a host joins to it with a transport of its own (`RunHub.join`); the code made at a stop
 * (`StopActions`), placed where the stopped statement stands (`RunLines`). A host wires their callbacks to its own
 * surfaces, as `server.ts` wires them to the client.
 */
export { RecordChannel, sameToken, type Handoff } from './recorder/handoff.js';
export { expectModuleOf } from './recorder/imports.js';
export { siblingSpecs } from './recorder/sessions.js';
export { RunLines, type DiskFile } from './run-lines.js';
export { RunSessions, type Viewer } from './run-sessions.js';
export { MAX_HUB_BUFFERED, RunHub, type HubPeer, type HubTransport } from './run-hub.js';
export { StopActions, type StopCodeWords, type StopTarget } from './stop-actions.js';
export type { Notice, RunSession, StopCode } from './protocol.js';
