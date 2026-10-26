import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callDeepseekCli,
  deepseekCliEnabled,
  deepseekCliProfile,
  getDeepseekCliStatus,
  runDeepseekCliAgent,
  streamDeepseekCli,
} from '../../server/utils/ai-deepseek-cli';
import type { ResolvedAiRole } from '../../types/api';

const role: ResolvedAiRole = { provider: 'deepseek-cli', apiKey: '', model: '', baseUrl: null, temperature: null };
const opts = { system: 'Use only the supplied evidence.', user: 'Explain this failure.' };
let dir: string;
let binary: string;
const grant = {
  kind: 'grant',
  payload: { version: 1, token: 'deepseek-only-token', issuer: 'https://platform.deepseek.com' },
};

function stub(mode = 'success') {
  writeFileSync(
    binary,
    `
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(mode === 'old' ? '0.1.0' : '0.2.1-rc.2'); process.exit(0); }
const home = process.env.DSH_HOME;
const root = join(home,'profiles','piwi');
const profile = JSON.parse(readFileSync(join(root,'cordis.patch.yml'),'utf8'))[0].insert;
if (args.includes('--dump-config')) { console.log(JSON.stringify(mode === 'bad-profile' ? [...profile,{name:'unrelated'}] : profile)); process.exit(0); }
let input = '';
process.stdin.on('data', (s) => input += s);
process.stdin.on('end', () => {
  const line = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  if (mode === 'timeout') { setTimeout(() => process.exit(0),20000); return; }
  if (mode === 'mount-failure') process.stderr.write('dsh: warning: 1 entry did not activate\\n');
  const credentials = JSON.parse(readFileSync(join(home,'.credentials.yaml'),'utf8'));
  const seen = {args,profile,credentials,env:process.env,cwd:process.cwd(),input};
  const schema = profile.find((p) => p.id === 'system-prompt').config.personaPrefix.includes('Respond ONLY with JSON');
  const text = mode === 'truncated' ? 'x'.repeat(10000) : mode === 'stream' ? 'hello' : schema ? '{"answer":"OK"}' : JSON.stringify(seen);
  if (mode === 'tool' || mode === 'unrelated-tool') line({type:'tool_call',tool:mode === 'tool' ? 'mcp__piwi__list_projects' : 'bash'});
  if (schema) line({type:'text',text:'Checking evidence.'});
  if (mode !== 'final-only') {
    const data = JSON.stringify({type:'text',text:mode === 'truncated' ? text.slice(0,8192) : text,...(mode === 'truncated' ? {truncated:true} : {})});
    process.stdout.write(data.slice(0,9)); process.stdout.write(data.slice(9)+'\\n');
  }
  const usage = {inputTokens:10,outputTokens:2,cacheReadTokens:80,cacheWriteTokens:3};
  line({type:'status',phase:'step_end',turn:1,step:1,usage});
  line({type:'status',phase:'step_end',turn:1,step:1,usage});
  if (mode === 'unknown-usage') line({type:'status',phase:'step_end',turn:1,step:2});
  line({type:'status',phase:'turn_end',reason:{kind:mode === 'failure' ? 'error' : 'completed'}});
  if (mode !== 'incomplete') process.stdout.write(JSON.stringify({type:'final',text}));
  process.exit(mode === 'nonzero' ? 1 : 0);
});
`,
    { mode: 0o700 },
  );
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'piwi-dsh-test-'));
  binary = join(dir, 'dsh.mjs');
  const home = join(dir, 'local-login');
  mkdirSync(home);
  writeFileSync(
    join(home, '.credentials.yaml'),
    JSON.stringify({
      version: 1,
      records: { 'deepseek-account-platform/default': grant, 'llm-pi-ai/openai-codex': { secret: 'unrelated' } },
      refs: { AWS_SECRET_ACCESS_KEY: 'unrelated', OPENAI_API_KEY: 'unrelated' },
    }),
    { mode: 0o600 },
  );
  vi.stubEnv('PIWI_DEEPSEEK_CLI_PATH', binary);
  vi.stubEnv('DSH_HOME', home);
  stub();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('official DeepSeek Harness provider', () => {
  it('reports the official version and saved DeepSeek credential presence without a model call', async () => {
    expect(await getDeepseekCliStatus()).toMatchObject({
      available: true,
      loggedIn: true,
      authMethod: 'account',
      version: '0.2.1-rc.2',
    });
    expect(deepseekCliEnabled()).toBe(true);
  });
  it('composes only official model and agent plugins without built-in tools or inherited bundles', () => {
    const profile = deepseekCliProfile('rules', 'deepseek-flash', 'api-key') as Array<{
      insert: Array<{ name: string }>;
    }>;
    expect(profile[0]!.insert.map((p) => p.name)).toEqual([
      '@deepseek-ai/cordis-plugin-timer',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-agent-loop',
      '@deepseek-ai/dsh-agent-default-model',
      '@deepseek-ai/dsh-headless',
      '@deepseek-ai/dsh-llm-deepseek-api-key',
    ]);
  });
  it('isolates home, credentials and tools and includes cached tokens in total input once', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'not-for-deepseek');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'not-for-deepseek');
    vi.stubEnv('DSH_SYSTEM_PROMPT', 'injected');
    const result = await callDeepseekCli(role, opts);
    const seen = JSON.parse(result.text);
    expect(seen.input).toBe(opts.user);
    expect(seen.credentials).toEqual({ version: 1, records: { 'deepseek-account-platform/default': grant } });
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(seen.env.DSH_SYSTEM_PROMPT).toBeUndefined();
    expect(seen.env.DSH_HOME).not.toBe(process.env.DSH_HOME);
    expect(existsSync(seen.cwd)).toBe(false);
    expect(result).toMatchObject({
      model: 'deepseek-flash',
      inputTokens: 93,
      outputTokens: 2,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 3,
      costUsd: null,
    });
  });
  it('accepts only the DeepSeek API key when no saved account is available', async () => {
    writeFileSync(
      join(process.env.DSH_HOME!, '.credentials.yaml'),
      JSON.stringify({ version: 1, refs: { DEEPSEEK_API_KEY: 'saved-key', OPENAI_API_KEY: 'unrelated' } }),
    );
    vi.stubEnv('DEEPSEEK_API_KEY', 'environment-key');
    expect((await getDeepseekCliStatus()).authMethod).toBe('api-key');
    const seen = JSON.parse((await callDeepseekCli(role, opts)).text);
    expect(seen.env.DEEPSEEK_API_KEY).toBe('saved-key');
    expect(seen.credentials).toEqual({ version: 1 });
    expect(seen.profile.find((p: { id: string }) => p.id === 'llm-deepseek').name).toBe(
      '@deepseek-ai/dsh-llm-deepseek-api-key',
    );
  });
  it('passes JSON Schema as instructions and returns only final structured text', async () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } } };
    expect(JSON.parse((await callDeepseekCli(role, { ...opts, jsonSchema: schema })).text)).toEqual({ answer: 'OK' });
    const chunks = [];
    for await (const chunk of streamDeepseekCli(role, { ...opts, jsonSchema: schema })) chunks.push(chunk);
    expect(chunks[0]).toEqual({ type: 'text', data: '{"answer":"OK"}' });
    expect(chunks).toHaveLength(2);
  });
  it.each(['stream', 'final-only'])('streams messages once with %s output', async (mode) => {
    stub(mode);
    const chunks = [];
    for await (const chunk of streamDeepseekCli(role, opts)) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.type === 'text')).toHaveLength(1);
    expect(chunks.at(-1)?.type).toBe('done');
  });
  it('recovers long answers from the lossless final event', async () => {
    stub('truncated');
    expect((await callDeepseekCli(role, opts)).text).toBe('x'.repeat(10000));
    const chunks = [];
    for await (const chunk of streamDeepseekCli(role, opts)) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', data: 'x'.repeat(10000) }]);
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it.each(['failure', 'nonzero', 'incomplete', 'mount-failure'])('fails closed for %s', async (mode) => {
    stub(mode);
    await expect(callDeepseekCli(role, opts)).rejects.toThrow(/DeepSeek/);
  });
  it.each(['old', 'bad-profile'])('refuses incompatible %s CLI profiles', async (mode) => {
    stub(mode);
    expect((await getDeepseekCliStatus()).available).toBe(false);
    await expect(callDeepseekCli(role, opts)).rejects.toThrow(/isolated DeepSeek profile/);
  });
  it('keeps unknown usage unknown', async () => {
    stub('unknown-usage');
    expect(await callDeepseekCli(role, opts)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
    });
  });
  it('attaches only the turn MCP endpoint and keeps its token out of argv', async () => {
    const run = {
      system: opts.system,
      prompt: opts.user,
      server: { url: 'http://127.0.0.1:3000/api/assistant/conversations/7/mcp', token: 'turn-token' },
      tools: ['list_projects'],
      maxTurns: 3,
      timeoutMs: 3000,
      onText() {},
    };
    const result = await runDeepseekCliAgent(role, run);
    const seen = JSON.parse(result.text);
    const mcp = seen.profile.find((p: { id: string }) => p.id === 'piwi');
    expect(mcp.config).toMatchObject({
      url: run.server.url,
      serverName: 'piwi',
      transport: 'streamable-http',
      failOnStartupError: true,
      headers: { Authorization: 'Bearer turn-token' },
    });
    expect(JSON.stringify(seen.args)).not.toContain('turn-token');
    expect(seen.env.NO_PROXY).toContain('127.0.0.1');
    expect(result.outcome).toBe('answered');
    stub('timeout');
    expect((await runDeepseekCliAgent(role, { ...run, timeoutMs: 100 })).outcome).toBe('timeout');
    stub('tool');
    expect((await runDeepseekCliAgent(role, { ...run, maxTurns: 0 })).outcome).toBe('max-turns');
    stub('unrelated-tool');
    expect((await runDeepseekCliAgent(role, run)).outcome).toBe('failed');
  });
  it('does not use other provider credentials as DeepSeek authentication', async () => {
    rmSync(join(process.env.DSH_HOME!, '.credentials.yaml'));
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'unrelated');
    expect((await getDeepseekCliStatus()).loggedIn).toBe(false);
    await expect(callDeepseekCli(role, opts)).rejects.toThrow(/Sign in/);
    expect(readFileSync(binary, 'utf8')).toContain('0.2.1-rc.2');
  });
});
