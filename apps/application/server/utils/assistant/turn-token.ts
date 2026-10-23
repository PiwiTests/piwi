/**
 * The token an assistant turn run by the Claude Code CLI calls its tools with.
 * The CLI gets one MCP server, the turn's endpoint
 * (`POST /api/assistant/conversations/:id/mcp`), and one token for it, minted
 * for the asking user, that conversation and that turn. This process keeps
 * only its hash, with the turn it opens, and forgets both when the turn ends;
 * a token past the turn's time limit is refused even before that.
 *
 * A token opens that one endpoint, for that conversation, from this machine:
 * the request must name a loopback host, carry no origin but a loopback one,
 * and come from a loopback address when the socket knows one. No other route
 * accepts it: it is not an API key or a session, and the desktop guard lets it
 * through on that route only (`presentsAssistantTurnToken`).
 */
import { randomBytes } from 'node:crypto';
import { getRequestHeader, type H3Event } from 'h3';
import type { AiToolCall, AiToolDef, AiToolResult } from '../ai-tool-calls';
import { bearerToken } from '../bearer';
import { hashToken } from '../token-hash';

const TURN_TOKEN_PREFIX = 'pwt_';

/** What a turn's endpoint serves: the turn's tools, and its calls run through the turn's answer. */
export interface AssistantTurnTools {
  /** The tools offered now, as `tools/list` lists them. */
  definitions(): AiToolDef[];
  call(call: AiToolCall): Promise<AiToolResult>;
}

/** One live turn, as its token opens it. */
export interface AssistantTurnSession extends AssistantTurnTools {
  conversationId: number;
  /** The asking user's id; null with authentication off. */
  ownerId: number | null;
  expiresAt: number;
}

const turns = new Map<string, AssistantTurnSession>();

/**
 * Mint the token of one turn: valid for `ttlMs` at most, and until `revoke`,
 * which the turn calls when it ends, whatever way it ends.
 */
export function mintAssistantTurnToken(
  turn: { conversationId: number; ownerId: number | null; tools: AssistantTurnTools },
  ttlMs: number,
  now = Date.now(),
): { token: string; revoke: () => void } {
  const token = `${TURN_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const key = hashToken(token);
  turns.set(key, {
    conversationId: turn.conversationId,
    ownerId: turn.ownerId,
    expiresAt: now + ttlMs,
    definitions: () => turn.tools.definitions(),
    call: (call) => turn.tools.call(call),
  });
  return { token, revoke: () => turns.delete(key) };
}

/** The live turn `token` opens for `conversationId`, or null: unknown, ended, expired, or another conversation's. */
export function liveAssistantTurn(
  token: string | null,
  conversationId: number,
  now = Date.now(),
): AssistantTurnSession | null {
  if (!token?.startsWith(TURN_TOKEN_PREFIX)) return null;
  const key = hashToken(token);
  const turn = turns.get(key);
  if (!turn) return null;
  if (turn.expiresAt <= now) {
    turns.delete(key);
    return null;
  }
  return turn.conversationId === conversationId ? turn : null;
}

/** The conversation of a request to a turn's MCP endpoint, or null for any other request. */
export function assistantTurnRouteConversation(method: string, path: string): number | null {
  if (method !== 'POST') return null;
  const match = /^\/api\/assistant\/conversations\/([1-9]\d{0,15})\/mcp$/.exec(path.split('?')[0]!);
  return match ? Number(match[1]) : null;
}

const LOOPBACK_HOST = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(?::\d{1,5})?$/i;
const LOOPBACK_ADDRESS = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

/** Whether a request comes from this machine: a loopback host, no origin but a loopback one, a loopback peer when known. */
export function isLoopbackRequest(event: H3Event): boolean {
  const host = getRequestHeader(event, 'host') ?? '';
  if (!LOOPBACK_HOST.test(host)) return false;
  const origin = getRequestHeader(event, 'origin');
  if (origin !== undefined) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    if (!LOOPBACK_HOST.test(originHost)) return false;
  }
  const peer = event.node.req.socket?.remoteAddress;
  return peer === undefined || LOOPBACK_ADDRESS.test(peer);
}

/** The live turn a request to its endpoint is for: its token, for this conversation, from this machine; else null. */
export function assistantTurnOfRequest(event: H3Event, conversationId: number): AssistantTurnSession | null {
  if (!isLoopbackRequest(event)) return null;
  return liveAssistantTurn(bearerToken(event), conversationId);
}

/**
 * Whether a request is a call to a live turn's endpoint with that turn's
 * token: the one request the desktop guard lets through without the desktop
 * token, since the CLI is never given that one.
 */
export function presentsAssistantTurnToken(event: H3Event): boolean {
  const conversationId = assistantTurnRouteConversation(event.method, event.path || '');
  return conversationId !== null && assistantTurnOfRequest(event, conversationId) !== null;
}

/**
 * Where the CLI calls a turn's endpoint: this server on the loopback address,
 * at the port the request arrived on (its socket's local port; else
 * `NITRO_PORT` or `PORT`, for a socket that has none), under the app's base
 * path (`app.baseURL`). Never a host a request named.
 */
export function assistantLoopbackBaseUrl(event: H3Event): string {
  const port = event.node.req.socket?.localPort || process.env.NITRO_PORT || process.env.PORT || 3000;
  const base = (useRuntimeConfig(event).app?.baseURL || '/').replace(/\/+$/, '');
  return `http://127.0.0.1:${port}${base}`;
}
