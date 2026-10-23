#!/usr/bin/env node
/**
 * A fake `claude` (Claude Code CLI) for `tests/assistant-claude-code.spec.ts`,
 * which points `PIWI_CLAUDE_CLI_PATH` at it. It answers the probes the server
 * makes (`--version`, `auth status --json`, `--help`) and, run as an
 * assistant turn (`-p --output-format stream-json --mcp-config <file>`), does
 * what Claude Code does with the one MCP server it is given: it initializes
 * it over HTTP, lists its tools, calls `list_projects` and shows the first
 * project with `show_entity`, writing its text as `stream-json` before and
 * after, then reports its usage. It also tries the turn's token where it must
 * be refused, and writes what it was given and saw to `CLAUDE_FAKE_RECORD`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);
const text = (t) =>
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });

if (args.includes('--version')) {
  process.stdout.write('2.1.30 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write(
    [
      'Usage: claude [options] [command] [prompt]',
      'Options:',
      '  -p, --print',
      '  --output-format <format>',
      '  --verbose',
      '  --include-partial-messages',
      '  --system-prompt <prompt>',
      '  --model <model>',
      '  --tools <tools...>',
      '  --allowedTools, --allowed-tools <tools...>',
      '  --mcp-config <configs...>',
      '  --strict-mcp-config',
      '  --permission-mode <mode>  (choices: "acceptEdits", "bypassPermissions", "default", "dontAsk", "plan")',
      '  --no-session-persistence',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  run().catch((err) => {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(err?.message ?? err) });
    process.exit(1);
  });
});

async function run() {
  const at = args.indexOf('--mcp-config');
  if (at === -1) {
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
    return;
  }
  const config = JSON.parse(readFileSync(args[at + 1], 'utf8'));
  const server = config.mcpServers.piwi;
  let id = 0;
  const post = (url, body, headers = server.headers) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });
  const rpc = async (method, params) => {
    const res = await post(server.url, { jsonrpc: '2.0', id: ++id, method, params });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const raw = await res.text();
    const json = raw.startsWith('event:')
      ? raw
          .split('\n\n')
          .filter(Boolean)
          .map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)))
          .find((message) => message.id === id)
      : JSON.parse(raw);
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  };

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fake-claude', version: '0' },
  });
  await post(server.url, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = (await rpc('tools/list')).tools.map((t) => t.name);
  out({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'piwi', status: 'connected' }] });

  // Where the token must be refused while the turn runs: another route, another conversation's endpoint.
  const origin = new URL(server.url).origin;
  const conversation = Number(/conversations\/(\d+)\/mcp$/.exec(server.url)[1]);
  const probes = {
    otherRoute: (await fetch(`${origin}/api/projects`, { headers: server.headers })).status,
    mcpRoute: (await post(`${origin}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status,
    otherConversation: (
      await post(server.url.replace(`/conversations/${conversation}/`, `/conversations/${conversation + 1}/`), {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      })
    ).status,
  };

  out({ type: 'stream_event', event: { type: 'message_start' } });
  text('Looking at the projects.');
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the projects.' }] } });
  const listed = await rpc('tools/call', { name: 'list_projects', arguments: {} });
  const project = JSON.parse(listed.content[0].text).items[0];
  const card = await rpc('tools/call', {
    name: 'show_entity',
    arguments: { id: 'project-card', entity: { type: 'project', id: project.id } },
  });

  const answer = `The project **${project.name}** reports here [list_projects].`;
  out({ type: 'stream_event', event: { type: 'message_start' } });
  text(answer);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });

  if (process.env.CLAUDE_FAKE_RECORD) {
    writeFileSync(
      process.env.CLAUDE_FAKE_RECORD,
      JSON.stringify({ args, config, prompt, tools, probes, card, noProxy: process.env.NO_PROXY }),
    );
  }
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: answer,
    num_turns: 3,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 30, output_tokens: 45, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0 },
    modelUsage: { 'claude-fake-1': {} },
  });
}
