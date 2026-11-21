/**
 * The JSON-RPC pieces Piwi's MCP servers share: the era each message is served in, the refusals, and the shape of a
 * served answer for its era.
 */
import { describe, expect, test } from 'vitest';
import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  checkMcpRequest,
  decodeMcpHeaderValue,
  discoverResult,
  negotiateProtocolVersion,
  ok,
  postAnswer,
  rpcErr,
  servedResponse,
  type JsonRpcRequest,
  type McpAnswer,
} from '../src/mcp-protocol';

const MODERN = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };
const request = (method: string, params?: unknown, id: number | null = 1): JsonRpcRequest => ({
  jsonrpc: '2.0',
  ...(id === null ? {} : { id }),
  method,
  ...(params === undefined ? {} : { params }),
});
const refusal = (checked: ReturnType<typeof checkMcpRequest>) => (checked as McpAnswer).response.error;

describe('the protocol versions', () => {
  test('serve the modern revision and the legacy ones, and answer initialize with a legacy one', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    expect(MCP_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(negotiateProtocolVersion('2025-03-26')).toBe('2025-03-26');
    expect(negotiateProtocolVersion('2025-11-25')).toBe('2025-11-25');
    expect(negotiateProtocolVersion(MODERN)).toBe('2025-11-25');
    expect(negotiateProtocolVersion(42)).toBe('2025-11-25');
  });
});

describe('checkMcpRequest', () => {
  test('serves a legacy request in the version its header names, or 2025-03-26 with none', () => {
    expect(checkMcpRequest(request('tools/list'), { protocolVersion: '2025-06-18' })).toEqual({
      version: '2025-06-18',
      modern: false,
    });
    expect(checkMcpRequest(request('tools/list'), {})).toEqual({ version: '2025-03-26', modern: false });
    expect(checkMcpRequest(request('tools/list'), null)).toEqual({ version: '2025-03-26', modern: false });
  });

  test('refuses a version it does not serve with a 400 listing those it does, a notification too', () => {
    const refused = checkMcpRequest(request('tools/list'), { protocolVersion: '1900-01-01' }) as McpAnswer;
    expect(refused.status).toBe(400);
    expect(refused.response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32022,
        message: 'Unsupported protocol version',
        data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: '1900-01-01' },
      },
    });
    const notice = checkMcpRequest(request('notifications/initialized', undefined, null), { protocolVersion: 'x' });
    expect(notice).toMatchObject({ status: 400, response: { id: null, error: { code: -32022 } } });
  });

  test('lets initialize negotiate in its body, whatever its header names', () => {
    expect(
      checkMcpRequest(request('initialize', { protocolVersion: '2025-06-18' }), { protocolVersion: '1900-01-01' }),
    ).toEqual({ version: '2025-06-18', modern: false });
  });

  test('serves a modern request whose headers mirror its body', () => {
    const call = request('tools/call', { name: 'list_projects', _meta: meta });
    const headers = { protocolVersion: MODERN, method: 'tools/call', name: 'list_projects' };
    expect(checkMcpRequest(call, headers)).toEqual({ version: MODERN, modern: true });
    expect(checkMcpRequest(call, null)).toEqual({ version: MODERN, modern: true });
    const prompt = request('prompts/get', { name: 'set up', _meta: meta });
    expect(
      checkMcpRequest(prompt, { protocolVersion: MODERN, method: 'prompts/get', name: '=?base64?c2V0IHVw?=' }),
    ).toEqual({ version: MODERN, modern: true });
  });

  test('refuses a modern request whose headers are missing or do not match, with HeaderMismatch', () => {
    const call = request('tools/call', { name: 'list_projects', _meta: meta });
    const full = { protocolVersion: MODERN, method: 'tools/call', name: 'list_projects' };
    for (const headers of [
      { ...full, protocolVersion: undefined },
      { ...full, protocolVersion: '2025-06-18' },
      { ...full, method: undefined },
      { ...full, method: 'tools/list' },
      { ...full, name: undefined },
      { ...full, name: 'other' },
      { ...full, name: '=?base64?!!!?=' },
      { ...full, name: 'list_projectsé' },
    ]) {
      const refused = checkMcpRequest(call, headers) as McpAnswer;
      expect(refused.status, JSON.stringify(headers)).toBe(400);
      expect(refused.response.error?.code, JSON.stringify(headers)).toBe(-32020);
    }
  });

  test('refuses a modern request without its version or its capabilities in _meta, with Invalid params', () => {
    expect(
      refusal(checkMcpRequest(request('tools/list'), { protocolVersion: MODERN, method: 'tools/list' })),
    ).toMatchObject({
      code: -32602,
    });
    const noCapabilities = request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } });
    expect(refusal(checkMcpRequest(noCapabilities, null))).toMatchObject({ code: -32602 });
    const notString = request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': 2026 } });
    expect(refusal(checkMcpRequest(notString, null))).toMatchObject({ code: -32602 });
    const unsupported = request('tools/list', {
      _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' },
    });
    expect(refusal(checkMcpRequest(unsupported, null))).toMatchObject({ code: -32022 });
  });

  test('asks nothing more of a modern notification than a version it serves', () => {
    expect(
      checkMcpRequest(request('notifications/cancelled', { requestId: 1 }, null), { protocolVersion: MODERN }),
    ).toEqual({ version: MODERN, modern: true });
  });
});

describe('decodeMcpHeaderValue', () => {
  test('reads a plain value as it is and decodes the base64 form, refusing what a header cannot carry', () => {
    expect(decodeMcpHeaderValue('list_projects')).toBe('list_projects');
    expect(decodeMcpHeaderValue(`=?base64?${Buffer.from('Hello, 世界').toString('base64')}?=`)).toBe('Hello, 世界');
    expect(decodeMcpHeaderValue('=?base64?not base64?=')).toBeNull();
    expect(decodeMcpHeaderValue(`=?base64?${Buffer.from([0xff, 0xfe]).toString('base64')}?=`)).toBeNull();
    expect(decodeMcpHeaderValue('line\nbreak')).toBeNull();
  });
});

describe('servedResponse', () => {
  const server = { name: 'piwi-test', version: '1.2.3' };

  test('leaves a legacy answer as it is', () => {
    const answer = ok(1, { tools: [] });
    expect(servedResponse({ version: '2025-06-18', modern: false }, 'tools/list', answer, server)).toEqual({
      status: 200,
      response: answer,
    });
    expect(
      servedResponse({ version: '2025-06-18', modern: false }, 'x', rpcErr(1, -32601, 'Method not found'), server)
        .status,
    ).toBe(200);
  });

  test('gives a modern result its resultType and the server, and a list its caching hints', () => {
    const era = { version: MODERN, modern: true };
    expect(servedResponse(era, 'tools/list', ok(1, { tools: [] }), server).response.result).toEqual({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      tools: [],
      _meta: { 'io.modelcontextprotocol/serverInfo': server },
    });
    expect(servedResponse(era, 'tools/call', ok(1, { content: [] }), server).response.result).toEqual({
      resultType: 'complete',
      content: [],
      _meta: { 'io.modelcontextprotocol/serverInfo': server },
    });
    expect(servedResponse(era, 'nope', rpcErr(1, -32601, 'Method not found'), server).status).toBe(404);
    expect(servedResponse(era, 'tools/call', rpcErr(1, -32602, 'Unknown tool'), server).status).toBe(200);
  });

  test('discovers every version served, the capabilities and the instructions', () => {
    expect(discoverResult({ tools: {} }, 'Use it well.')).toEqual({
      supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
      capabilities: { tools: {} },
      instructions: 'Use it well.',
    });
  });
});

describe('postAnswer', () => {
  test('answers notifications alone with nothing, one request with its own status, and a batch as a list', () => {
    expect(postAnswer(false, [null])).toBeNull();
    expect(postAnswer(true, [null, null])).toBeNull();
    const refused: McpAnswer = { status: 400, response: rpcErr(2, -32022, 'Unsupported protocol version') };
    expect(postAnswer(false, [refused])).toEqual({ status: 400, body: refused.response });
    const served: McpAnswer = { status: 200, response: ok(1, {}) };
    expect(postAnswer(true, [served, null, refused])).toEqual({
      status: 400,
      body: [served.response, refused.response],
    });
  });
});
