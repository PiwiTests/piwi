/**
 * The run control a host other than the language server builds on: a desktop shell's host, the hub of the runs its
 * shell starts (`./shell-runs.ts`, which the desktop app's server and Piwi Runner's host run). Each piece is the service's own, and none speaks the
 * Language Server Protocol: the socket every run names, which takes the workers' run connections with its token
 * (`RecordChannel`); the sessions and the controls they pass on (`RunSessions`); the hub's WebSocket for Piwi Picker,
 * and the peers a host joins to it with a transport of its own (`RunHub.join`); the code made at a stop
 * (`StopActions`), placed where the stopped statement stands (`RunLines`); Playwright's trace viewer on a lane's running
 * test's trace so far, from the project's own Playwright (`startTraceViewer`); the agents' tools for those runs, in the
 * host's words (`RunAgent`, `agentTools`), which a host serves from an MCP server of its own. A host wires their
 * callbacks to its own surfaces, as `server.ts` wires them to the client.
 */
export { RecordChannel, sameToken, type Handoff } from './recorder/handoff.js';
export { expectModuleOf } from './recorder/imports.js';
export { siblingSpecs } from './recorder/sessions.js';
export { RunLines, type DiskFile } from './run-lines.js';
export { RunSessions, type Viewer } from './run-sessions.js';
export { MAX_HUB_BUFFERED, RunHub, type HubPeer, type HubTransport } from './run-hub.js';
export { StopActions, type StopCodeWords, type StopTarget } from './stop-actions.js';
export { startTraceViewer, type TraceViewerLauncher } from './trace-viewer.js';
export {
  RunAgent,
  agentTools,
  type AgentWords,
  type RunAgentOptions,
  type ToolDefinition,
  type ToolResult,
} from './run-agent.js';
export type { Notice, RunControlResult, RunHoldFailures, RunSession, StopCode } from './protocol.js';
