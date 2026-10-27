import { getRequestURL, type H3Event } from 'h3';
import { isAuthEnabled } from '../utils/auth';
import { requireMcpAuth } from '../utils/mcp-oauth';
import { getDatabase, type DbClient } from '../database';
import { toContent } from '../utils/mcp/tools';
import type { McpContext, McpTool } from '../utils/mcp/tools';
import { mcpCatalog, requestMcpContext, toolsForCaller } from '../utils/mcp/catalog';
import { getPrompt, isKnownPrompt } from '../utils/mcp/prompts';
import { publicBaseUrl } from '../utils/public-base-url';
import { ok, rpcErr, RPC, mcpServerInfo, negotiateProtocolVersion } from '../utils/mcp/protocol';
import type { JsonRpcRequest } from '../utils/mcp/protocol';
import { MCP_PROMPT_DEFS } from '#shared/mcp-prompts';
import { resolveInstanceStates, getInstanceDecisions } from '#shared/handlers/setup-status';
import { CAPABILITY_MODULES, type CapabilityModule } from '#shared/capabilities';
import { narrowToolsByModule } from '../utils/mcp/filter';
import { logMcpToolCall } from '../utils/mcp/write-log';

// The desktop app's bundled server (launched with PIWI_DESKTOP_TOKEN) advertises
// the shared catalog plus the desktop-only tools that read and write files on the
// machine it runs on; a hosted/Docker/npx server serves the shared catalog only.
const IS_DESKTOP = !!process.env.PIWI_DESKTOP_TOKEN;
const TOOL_BY_NAME = new Map(mcpCatalog(IS_DESKTOP).map((t) => [t.name, t]));
const MAX_BODY_BYTES = 1_048_576; // 1 MB — reject oversized batches early
// Every request of a batch runs at once, and one tool call can be a heavy query.
const MAX_BATCH_REQUESTS = 20;

const KNOWN_MODULES = new Set<CapabilityModule>(CAPABILITY_MODULES);

/**
 * The tool a `tools/call` may run, or null when the name is unknown or its
 * capability is declined. A tool with no capability needs no query; a tool with
 * one needs the evidence probes only when its capability carries a stored
 * decline, since evidence still wins over a decline.
 */
async function serveableTool(db: DbClient, name: string | undefined): Promise<McpTool | null> {
  const tool = name ? TOOL_BY_NAME.get(name) : undefined;
  if (!tool || !tool.capability) return tool ?? null;
  if ((await getInstanceDecisions(db))[tool.capability] !== 'declined') return tool;
  return (await resolveInstanceStates(db))[tool.capability] === 'declined' ? null : tool;
}

/**
 * Parse the `?modules=core,healing` narrowing on the MCP URL. Unknown values are
 * ignored; an absent, empty or all-unknown value means no narrowing. Narrowing
 * only hides tools from the list, it never re-enables a declined one.
 */
function parseModules(raw: string | null): Set<CapabilityModule> | null {
  if (!raw) return null;
  const picked = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is CapabilityModule => KNOWN_MODULES.has(s as CapabilityModule));
  return picked.length > 0 ? new Set(picked) : null;
}

// ── MCP Streamable HTTP endpoint ─────────────────────────────────────────────
//
// Implements the MCP Streamable HTTP transport for the protocol versions in
// SUPPORTED_PROTOCOL_VERSIONS.
// A single POST /mcp handles initialize, tools/list, tools/call, and ping.
// Auth: an OAuth access token (the client signs in through this instance's
// authorization server, see utils/mcp-oauth.ts), or the same pd_<key> Bearer
// token and session as the REST API.

export default eventHandler(async (event) => {
  // Authenticate with an OAuth access token or the REST API's key / session,
  // then load the caller's access and project scope once. Every tool honors the
  // scope, so a key reads only the projects its owner holds a role on, and every
  // write tool checks its permission on the project it acts on — the same rules
  // the REST API enforces.
  const user = await requireMcpAuth(event);
  const db = await getDatabase();
  const ctx = await requestMcpContext(event, db, user);

  const contentLength = Number(event.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    setResponseStatus(event, 413);
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: RPC.INVALID_REQUEST, message: 'Request body too large (max 1 MB)' },
    };
  }

  const body = await readBody<JsonRpcRequest | JsonRpcRequest[]>(event);
  const requests = Array.isArray(body) ? body : [body];
  if (requests.length > MAX_BATCH_REQUESTS) {
    setResponseStatus(event, 400);
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: RPC.INVALID_REQUEST, message: `A batch holds at most ${MAX_BATCH_REQUESTS} requests` },
    };
  }

  const responses = await Promise.all(requests.map((req) => handleRequest(ctx, req, event, db)));

  // Notifications (no id) have no response — filter them out.
  const toSend = responses.filter((r) => r !== null);

  setResponseHeader(event, 'Content-Type', 'application/json');
  return Array.isArray(body) ? toSend : (toSend[0] ?? null);
});

async function handleRequest(ctx: McpContext, req: JsonRpcRequest, event: H3Event, db: DbClient) {
  if (!req || req.jsonrpc !== '2.0' || !req.method) {
    return rpcErr(req?.id, RPC.INVALID_REQUEST, 'Invalid JSON-RPC request');
  }

  // Notifications (no id) — fire and forget
  if (req.id === undefined || req.id === null) {
    if (req.method === 'notifications/initialized') return null;
    return null;
  }

  try {
    return await dispatch(ctx, req, event, db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[MCP] error handling', req.method, message);
    return rpcErr(req.id, RPC.INTERNAL_ERROR, message);
  }
}

// ── JSON-RPC dispatcher ───────────────────────────────────────────────────────

async function dispatch(ctx: McpContext, req: JsonRpcRequest, event: H3Event, db: DbClient) {
  const { id, method, params } = req;

  switch (method) {
    // ── Protocol handshake ──────────────────────────────────────────────────
    case 'initialize': {
      const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return ok(id, {
        protocolVersion: negotiateProtocolVersion(requested),
        capabilities: { tools: {}, prompts: {} },
        serverInfo: mcpServerInfo(useRuntimeConfig(event).public.appVersion as string, { desktop: IS_DESKTOP }),
        instructions:
          `${IS_DESKTOP ? 'Piwi desktop app' : 'Piwi Dashboard'} MCP server — query Playwright test results, failure clusters, AI diagnoses, and SCM diffs. ` +
          'Start with list_projects to discover project IDs. ' +
          'Paginated list tools return {items, nextCursor}; pass nextCursor back (when non-null) to page. ' +
          'IDs: testCaseId = stable test identity; executionId/testRunsCaseId = one per-run execution. ' +
          'Errors are truncated; use get_test_run_case for full error text and explain_failure for a one-call evidence bundle. ' +
          'Write/triage tools (set_cluster_status, triage_cluster, move_tests_to_new_cluster, triage_gap, decide_merge_suggestion, set_test_quarantine, dismiss_quarantine_proposal, set_bug_report_status, set_run_incident, rerun_cluster_in_ci, link_issue, unlink_issue, run_cluster_diagnosis, run_execution_diagnosis, record_diagnosis, report_fix_attempt, set_cluster_base_commit, submit_diagnosis_feedback) need, on the project they act on, the permission the same action needs in the dashboard (each description names it and the roles that hold it); tools/list leaves out the ones this key cannot use on any project, and each call is logged with the key that made it. ' +
          'To set the diagnosis of a cluster or of one failure, write it and call record_diagnosis with clusterId or executionId. ' +
          'After fixing a cluster, call report_fix_attempt with the commit or branch, and put the Piwi-Cluster trailer get_fix_plan suggests in the commit message, so Piwi can verify the fix. ' +
          'Tools belong to four modules (core, workflow, healing, agents); declining a capability on this instance drops the tools that depend on it from this list, and appending ?modules=core (a comma-separated set) to the MCP URL narrows the list to those modules. ' +
          'For questions about Piwi itself — what it is, its pieces, setup choices, configuration, its documentation, where to send feedback — call describe_piwi; get_release_notes says what changed in each release. ' +
          'The setup_piwi prompt (prompts/get) generates a ready-to-run setup for a Playwright project not yet reporting here; the other prompts are the Piwi workflow skills.' +
          (IS_DESKTOP
            ? ' This is the local desktop app, running on your machine: it adds tools that reach the disk — import_local_report (pull a local blob/trace .zip into a project), read_local_source (read the current on-disk source) and apply_locator_fix (apply a recommended locator fix to the real file).'
            : ''),
      });
    }

    case 'ping': {
      return ok(id, {});
    }

    // ── Tool listing ─────────────────────────────────────────────────────────
    case 'tools/list': {
      const modules = parseModules(getRequestURL(event).searchParams.get('modules'));
      const tools = narrowToolsByModule(await toolsForCaller(db, ctx.access, { desktop: IS_DESKTOP }), modules);
      return ok(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    // ── Tool execution ───────────────────────────────────────────────────────
    case 'tools/call': {
      const p = params as { name?: string; arguments?: Record<string, unknown> };
      // A tool whose capability is declined is dropped from the served set, so it
      // is "Unknown tool" here too — same answer the list gives. `?modules=` only
      // narrows the advertised list, so it does not block a call.
      const tool = await serveableTool(db, p?.name);
      if (!tool) {
        return rpcErr(id, RPC.INVALID_PARAMS, `Unknown tool: ${p?.name}`);
      }

      const args = p?.arguments ?? {};
      try {
        const data = await tool.handler(db, args, ctx);
        // Write tools are logged with what they acted on; read tools never are.
        await logMcpToolCall(db, ctx, tool.name, args, data === null ? 'not-found' : 'ok', null, data);
        return ok(id, toContent(data));
      } catch (err) {
        // A tool that throws surfaces as a tool result with `isError: true`, not
        // a JSON-RPC protocol error: the latter is a transport-level failure that
        // clients render as a broken connection, while the former is a message the
        // model reads and recovers from (bad argument, missing entity, no access).
        const message = err instanceof Error ? err.message : String(err);
        await logMcpToolCall(db, ctx, tool.name, args, 'error', message);
        return ok(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
      }
    }

    // ── Prompts ──────────────────────────────────────────────────────────────
    case 'prompts/list': {
      return ok(id, {
        prompts: MCP_PROMPT_DEFS.map((p) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments ?? [],
        })),
      });
    }

    case 'prompts/get': {
      const p = params as { name?: string; arguments?: Record<string, string> };
      if (!p?.name || !isKnownPrompt(p.name)) {
        return rpcErr(id, RPC.INVALID_PARAMS, `Unknown prompt: ${p?.name}`);
      }
      // The URL the client used to reach this dashboard is the URL its reporter
      // should point at; PIWI_SITE_URL overrides it when set (reverse proxy).
      const baseUrl = publicBaseUrl(event);
      const result = await getPrompt(p.name, {
        db,
        ctx,
        baseUrl,
        authEnabled: isAuthEnabled(event),
        args: p.arguments ?? {},
        version: String(useRuntimeConfig(event).public.appVersion ?? ''),
      });
      return ok(id, result);
    }

    // ── Resources (not implemented) ──────────────────────────────────────────
    case 'resources/list':
      return ok(id, { resources: [] });

    default:
      return rpcErr(id, RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}
