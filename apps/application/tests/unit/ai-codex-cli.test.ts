import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callCodexCli,
  codexCliEnabled,
  codexCliEnv,
  getCodexCliStatus,
  runCodexCliAgent,
  streamCodexCli,
} from '../../server/utils/ai-codex-cli';
import type { ResolvedAiRole } from '../../types/api';

const role: ResolvedAiRole = {
  provider: 'codex-cli',
  apiKey: '',
  baseUrl: null,
  model: 'test-model',
  temperature: null,
};
const opts = { system: 'Use only the supplied evidence.', user: 'Explain this failure.' };
let dir: string;
let binary: string;

function stub(mode = 'success') {
  writeFileSync(
    binary,
    `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (args.includes('--help')) { console.log(mode === 'old' ? '--json' : '--json --ephemeral --output-schema --ignore-user-config --ignore-rules --output-last-message'); process.exit(0); }
if (args[0] === 'features') { console.log('shell_tool stable true\\napps stable true\\nfuture_tool experimental true'); process.exit(0); }
if (args[0] === 'login') process.exit(existsSync(join(process.env.CODEX_HOME, 'auth.json')) ? 0 : 1);
const settings = args.flatMap((v, i) => v === '--config' ? [args[i + 1]] : []);
const file = (key) => JSON.parse(settings.find((v) => v.startsWith(key + '=' )).slice(key.length + 1));
const schema = args.includes('--output-schema') ? JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')) : null;
let prompt = '';
process.stdin.on('data', (s) => prompt += s);
process.stdin.on('end', () => {
  const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (mode === 'timeout') { setTimeout(() => process.exit(0), 20000); return; }
  if (mode === 'failure') { line({type:'turn.failed', error:{message:'failure'}}); process.exit(1); }
  if (mode === 'exit') process.exit(1);
  if (mode === 'refresh') writeFileSync(join(process.env.CODEX_HOME,'auth.json'), JSON.stringify({tokens:{access_token:'refreshed'}}));
  const snapshot = { args, settings, cwd:process.cwd(), home:process.env.HOME, codexHome:process.env.CODEX_HOME,
    configExists:existsSync(join(process.env.CODEX_HOME,'config.toml')), schema, prompt,
    catalog:JSON.parse(readFileSync(file('model_catalog_json'),'utf8')),
    instructions:readFileSync(file('model_instructions_file'),'utf8'), env:process.env };
  if (mode === 'tool') line({ type:'item.started', item:{id:'t',type:'mcp_tool_call',server:'piwi',tool:'list_projects'} });
  if (mode === 'commentary') line({type:'item.completed',item:{id:'c',type:'agent_message',text:'Checking the evidence.'}});
  if (mode === 'retry') line({type:'error',message:'Reconnecting... 1/5'});
  const message = {type:'item.completed',item:{id:'m',type:'agent_message',text:mode === 'stream' ? 'hello' : JSON.stringify(snapshot)}};
  writeFileSync(args[args.indexOf('--output-last-message') + 1], message.item.text);
  const serialized = JSON.stringify(message);
  process.stdout.write('diagnostic noise\\n' + serialized.slice(0,17));
  process.stdout.write(serialized.slice(17) + '\\n');
  line(message);
  if (mode === 'incomplete') process.exit(0);
  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:80,output_tokens:7}}));
});
`,
    { mode: 0o700 },
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'piwi-codex-test-'));
  binary = join(dir, 'codex.mjs');
  const home = join(dir, 'login');
  mkdirSync(home);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fake-login' } }));
  writeFileSync(join(home, 'config.toml'), 'unrelated user tools and secrets');
  vi.stubEnv('PIWI_CODEX_CLI_PATH', binary);
  vi.stubEnv('CODEX_HOME', home);
  stub();
  await getCodexCliStatus({ force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('local Codex provider', () => {
  it('reuses a ChatGPT login without an API key and reports status', async () => {
    expect(await getCodexCliStatus({ force: true })).toMatchObject({
      available: true,
      loggedIn: true,
      authMethod: 'chatgpt',
      version: 'codex-cli 0.163.0',
    });
    expect(codexCliEnabled()).toBe(true);
    vi.stubEnv('PIWI_CODEX_CLI_PATH', '');
    vi.stubEnv('PIWI_DESKTOP_TOKEN', '');
    vi.stubEnv('NUXT_PUBLIC_DESKTOP', 'false');
    expect(codexCliEnabled()).toBe(false);
  });

  it('excludes unrelated credentials, hooks and runtime overrides', () => {
    expect(
      codexCliEnv({
        PATH: '/bin',
        HTTPS_PROXY: 'http://proxy',
        LANG: 'en_US',
        OPENAI_API_KEY: 'key',
        AWS_SECRET_ACCESS_KEY: 'aws',
        PIWI_SECRET_KEY: 'piwi',
        CLAUDE_CODE_OAUTH_TOKEN: 'claude',
        NODE_OPTIONS: '--require injected',
        CODEX_HOME: '/secret',
        CODEX_API_KEY: 'key',
      }),
    ).toEqual({ PATH: '/bin', HTTPS_PROXY: 'http://proxy', LANG: 'en_US' });
  });

  it('passes schema files and disables built-in tools in a private home', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unrelated');
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    const result = await callCodexCli(role, { ...opts, jsonSchema: schema });
    const seen = JSON.parse(result.text);
    expect(seen.schema).toEqual(schema);
    expect(seen.prompt).toBe(opts.user);
    expect(seen.instructions).toBe(opts.system);
    expect(seen.catalog.models[0]).toMatchObject({
      slug: role.model,
      apply_patch_tool_type: null,
      experimental_supported_tools: [],
    });
    expect(seen.args).toEqual(
      expect.arrayContaining([
        '--ignore-user-config',
        '--ignore-rules',
        '--sandbox',
        'read-only',
        '--disable',
        'future_tool',
      ]),
    );
    expect(seen.settings).toEqual(expect.arrayContaining(['approval_policy="never"', 'web_search="disabled"']));
    expect(seen.settings.filter((s: string) => s.startsWith('mcp_servers'))).toEqual(['mcp_servers={}']);
    expect(seen.configExists).toBe(false);
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.CODEX_HOME).not.toBe(process.env.CODEX_HOME);
    expect(existsSync(seen.cwd)).toBe(false);
    expect(result).toMatchObject({ inputTokens: 100, cacheReadInputTokens: 80, outputTokens: 7, costUsd: null });
  });

  it('streams split JSONL messages once and accepts an unterminated usage event', async () => {
    stub('stream');
    const chunks = [];
    for await (const chunk of streamCodexCli(role, opts)) chunks.push(chunk);
    expect(chunks).toEqual([
      { type: 'text', data: 'hello' },
      { type: 'done', data: expect.objectContaining({ inputTokens: 100, cacheReadInputTokens: 80, outputTokens: 7 }) },
    ]);
    expect((await getCodexCliStatus()).usage.cacheReadInputTokens).toBeGreaterThanOrEqual(80);
  });

  it.each(['failure', 'exit', 'incomplete'])('fails closed for %s', async (mode) => {
    stub(mode);
    await expect(callCodexCli(role, opts)).rejects.toThrow(/Codex/);
    const chunks = [];
    for await (const chunk of streamCodexCli(role, opts)) chunks.push(chunk);
    expect(chunks.at(-1)?.type).toBe('error');
  });

  it('rejects API-key-only, missing and incompatible logins', async () => {
    writeFileSync(join(process.env.CODEX_HOME!, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'not-used' }));
    expect((await getCodexCliStatus({ force: true })).loggedIn).toBe(false);
    await expect(callCodexCli(role, opts)).rejects.toThrow(/codex login/);
    rmSync(join(process.env.CODEX_HOME!, 'auth.json'));
    expect((await getCodexCliStatus({ force: true })).loggedIn).toBe(false);
    stub('old');
    expect(await getCodexCliStatus({ force: true })).toMatchObject({
      available: false,
      loggedIn: false,
      error: expect.stringContaining('Update'),
    });
  });

  it('gives the assistant only its turn MCP tools and keeps its token out of argv', async () => {
    const result = await runCodexCliAgent(role, {
      system: opts.system,
      prompt: opts.user,
      tools: ['list_projects'],
      server: { url: 'http://127.0.0.1:3000/api/assistant/conversations/7/mcp', token: 'turn-token' },
      maxTurns: 5,
      timeoutMs: 3000,
      onText() {},
    });
    const seen = JSON.parse(result.text);
    expect(JSON.stringify(seen.args)).not.toContain('turn-token');
    expect(seen.env.CODEX_PIWI_TURN_TOKEN).toBe('turn-token');
    expect(seen.settings.find((s: string) => s.startsWith('mcp_servers={piwi='))).toContain(
      'enabled_tools=["list_projects"]',
    );
    expect(seen.settings.find((s: string) => s.startsWith('mcp_servers={piwi='))).toContain('required=true');
    expect(seen.env.NO_PROXY).toContain('127.0.0.1');
    expect(result.outcome).toBe('answered');
  });

  it('kills a timed-out or stopped assistant run and enforces the tool-call bound', async () => {
    const run = {
      system: opts.system,
      prompt: opts.user,
      tools: [],
      server: { url: 'http://127.0.0.1/mcp', token: 'token' },
      maxTurns: 0,
      timeoutMs: 100,
      onText() {},
    };
    stub('timeout');
    expect((await runCodexCliAgent(role, run)).outcome).toBe('timeout');
    // The user's Stop kills the run before its time limit.
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    expect((await runCodexCliAgent(role, { ...run, timeoutMs: 10_000, signal: stop.signal })).outcome).toBe('stopped');
    stub('tool');
    expect((await runCodexCliAgent(role, { ...run, timeoutMs: 3000 })).outcome).toBe('max-turns');
  });

  it('uses the final response alone for schema calls and schema streams', async () => {
    stub('commentary');
    const schema = { type: 'object' };
    const result = await callCodexCli(role, { ...opts, jsonSchema: schema });
    expect(JSON.parse(result.text).schema).toEqual(schema);
    const chunks = [];
    for await (const chunk of streamCodexCli(role, { ...opts, jsonSchema: schema })) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.type === 'text')).toHaveLength(1);
    expect(JSON.parse(chunks.find((chunk) => chunk.type === 'text')!.data as string).schema).toEqual(schema);
  });

  it('accepts a successful turn after a recoverable connection error', async () => {
    stub('retry');
    expect((await callCodexCli(role, opts)).outputTokens).toBe(7);
  });

  it('saves a refreshed login for subsequent isolated runs', async () => {
    stub('refresh');
    await callCodexCli(role, opts);
    expect(JSON.parse(readFileSync(join(process.env.CODEX_HOME!, 'auth.json'), 'utf8')).tokens.access_token).toBe(
      'refreshed',
    );
  });
});
