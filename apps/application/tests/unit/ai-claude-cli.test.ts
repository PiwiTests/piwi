import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  callClaudeCli,
  claudeCliEnabled,
  cliCommand,
  cliEnv,
  cmdShimTarget,
  getClaudeCliStatus,
  claudeCliRunsAgents,
  getUsageTotals,
  isDesktopRuntime,
  resetClaudeCliCache,
  resolveClaudeBinary,
  resolveClaudeBinaryDeep,
  runClaudeCliAgent,
  streamClaudeCli,
} from '../../server/utils/ai-claude-cli';
import type { ClaudeCliAgentRun } from '../../server/utils/ai-claude-cli';
import type { ResolvedAiRole } from '../../types/api';
import type { StreamChunk } from '../../server/utils/ai-provider';

// A stub standing in for the real `claude` binary. It answers the metadata
// probes (`--version`, `auth status`) and echoes a canned generation result so
// the spawn → parse → usage-tally path can be exercised without a real CLI.
const STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
const outFmt = args[args.indexOf('--output-format') + 1];
if (args.includes('--version')) { process.stdout.write('9.9.9 (stub)\\n'); process.exit(0); }
if (args.includes('--help')) {
  // CLAUDE_STUB_OLD models a CLI without --restricted; CLAUDE_STUB_ANCIENT one without --tools;
  // CLAUDE_STUB_HELP_FAIL a --help that fails.
  if (process.env.CLAUDE_STUB_HELP_FAIL) { process.stderr.write('help exploded\\n'); process.exit(1); }
  const base = ['--print', '--output-format', '--system-prompt', '--model', '--verbose', '--include-partial-messages'];
  const hardening = process.env.CLAUDE_STUB_ANCIENT ? [] : ['--tools', '--strict-mcp-config'];
  const extra = process.env.CLAUDE_STUB_OLD || process.env.CLAUDE_STUB_ANCIENT ? [] : ['--restricted'];
  // CLAUDE_STUB_AGENT models a CLI that can run an assistant turn with an MCP server attached.
  const agent = process.env.CLAUDE_STUB_AGENT
    ? ['--mcp-config <configs...>', '--allowedTools, --allowed-tools <tools...>', '--permission-mode <mode> (choices: "default", "dontAsk")']
    : [];
  process.stdout.write('Usage: claude [options]\\nOptions:\\n  ' + base.concat(hardening, extra, agent).join('\\n  ') + '\\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = process.env.CLAUDE_STUB_LOGGED_IN !== '0';
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: 'oauth_token', apiProvider: 'firstParty' }));
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'login') { process.stdout.write('Open https://claude.ai/oauth/stub to continue\\n'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'logout') { process.exit(0); }
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (outFmt === 'stream-json' && args.includes('--mcp-config')) {
    // An assistant turn: report what the run was given as its text, as Claude Code streams it.
    const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    const configPath = args[args.indexOf('--mcp-config') + 1];
    const config = JSON.parse(require('node:fs').readFileSync(configPath, 'utf8'));
    const status = process.env.CLAUDE_STUB_MCP_STATUS || 'connected';
    line({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'piwi', status }] });
    if (status !== 'connected') { setTimeout(() => process.exit(0), 20000); return; }
    const seen = JSON.stringify({ args, config, configPath, prompt: input, noProxy: process.env.NO_PROXY });
    if (process.env.CLAUDE_STUB_NO_PARTIAL) {
      line({ type: 'assistant', message: { content: [{ type: 'text', text: seen }, { type: 'tool_use', name: 'x' }] } });
    } else {
      line({ type: 'stream_event', event: { type: 'message_start' } });
      line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: seen } } });
      line({ type: 'assistant', message: { content: [{ type: 'text', text: seen }] } });
    }
    const subtype = process.env.CLAUDE_STUB_SUBTYPE || 'success';
    line({ type: 'result', subtype, is_error: subtype !== 'success', result: 'final', total_cost_usd: 0.03,
      usage: { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      modelUsage: { 'claude-sonnet-5': {} } });
  } else if (outFmt === 'stream-json') {
    const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } });
    line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } });
    line({ type: 'result', subtype: 'success', is_error: false, result: 'Hello world', total_cost_usd: 0.01,
      usage: { input_tokens: 11, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      modelUsage: { 'claude-sonnet-5': {} } });
  } else {
    if (process.env.CLAUDE_STUB_OLD && args.includes('--restricted')) {
      process.stderr.write("error: unknown option '--restricted'\\n");
      process.exit(1);
    }
    const env = (name) => process.env[name] || 'unset';
    const body =
      input.trim() === 'ENVCHECK'
        ? ['ANTHROPIC_API_KEY', 'PIWI_SECRET_KEY', 'CLAUDE_CONFIG_DIR', 'HOME'].map((n) => n + '=' + env(n)).join(';')
        : input.trim() === 'ARGS'
          ? JSON.stringify(args)
          : 'ECHO:' + input.trim();
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      result: body, total_cost_usd: 0.02,
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
      modelUsage: { 'claude-opus-5': {} } }));
  }
  process.exit(0);
});
`;

const role: ResolvedAiRole = { provider: 'claude-cli', apiKey: '', model: 'opus', baseUrl: null, temperature: null };

let dir: string;
let stubPath: string;
const savedEnv = { ...process.env };

describe.skipIf(process.platform === 'win32')('ai-claude-cli', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-stub-'));
    stubPath = join(dir, 'claude');
    writeFileSync(stubPath, STUB);
    chmodSync(stubPath, 0o755);
    process.env.PIWI_CLAUDE_CLI_PATH = stubPath;
    delete process.env.CLAUDE_STUB_LOGGED_IN;
    delete process.env.CLAUDE_STUB_OLD;
    delete process.env.CLAUDE_STUB_ANCIENT;
    delete process.env.CLAUDE_STUB_HELP_FAIL;
    delete process.env.CLAUDE_STUB_AGENT;
    delete process.env.CLAUDE_STUB_MCP_STATUS;
    delete process.env.CLAUDE_STUB_NO_PARTIAL;
    delete process.env.CLAUDE_STUB_SUBTYPE;
    delete process.env.PIWI_DESKTOP_TOKEN;
    delete process.env.NUXT_PUBLIC_DESKTOP;
    resetClaudeCliCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetClaudeCliCache();
  });

  afterAll(() => {
    process.env = { ...savedEnv };
  });

  it('is enabled when a binary path is pinned, even outside desktop', () => {
    expect(isDesktopRuntime()).toBe(false);
    expect(claudeCliEnabled()).toBe(true);
  });

  it('resolves the pinned binary, and null when the path is missing', () => {
    expect(resolveClaudeBinary()).toBe(stubPath);
    process.env.PIWI_CLAUDE_CLI_PATH = join(dir, 'does-not-exist');
    resetClaudeCliCache();
    expect(resolveClaudeBinary()).toBeNull();
  });

  // Blank out every source the quick scan reads so it genuinely finds nothing,
  // then restore them. (The test runner sets npm_config_prefix to the Node
  // install, whose bin holds the real `claude`.)
  function withNoQuickScanHit(run: () => void | Promise<void>): () => Promise<void> {
    return async () => {
      const saved = {
        PATH: process.env.PATH,
        npm_config_prefix: process.env.npm_config_prefix,
        PREFIX: process.env.PREFIX,
        SHELL: process.env.SHELL,
      };
      try {
        delete process.env.PIWI_CLAUDE_CLI_PATH;
        process.env.PATH = '';
        delete process.env.npm_config_prefix;
        delete process.env.PREFIX;
        resetClaudeCliCache();
        await run();
      } finally {
        Object.assign(process.env, saved);
        delete process.env.CLAUDE_STUB_PATH;
      }
    };
  }

  it(
    'does not cache a not-found result, so a later resolve can recover',
    withNoQuickScanHit(() => {
      expect(resolveClaudeBinary()).toBeNull();
      // The user pins the path; the next resolve must not be stuck on the null.
      process.env.PIWI_CLAUDE_CLI_PATH = stubPath;
      expect(resolveClaudeBinary()).toBe(stubPath);
    }),
  );

  it(
    'falls back to the login shell PATH when the quick scan misses',
    withNoQuickScanHit(async () => {
      // A POSIX-sh stub that ignores its args and prints CLAUDE_STUB_PATH as the shell PATH.
      const shellStub = join(dir, 'shell');
      writeFileSync(shellStub, '#!/bin/sh\nprintf %s "$CLAUDE_STUB_PATH"\n');
      chmodSync(shellStub, 0o755);
      process.env.SHELL = shellStub; // the login shell "knows" where claude is
      process.env.CLAUDE_STUB_PATH = dir;

      expect(resolveClaudeBinary()).toBeNull();
      expect(await resolveClaudeBinaryDeep()).toBe(stubPath);
    }),
  );

  it('reports version and signed-in status without spending tokens', async () => {
    const status = await getClaudeCliStatus({ force: true });
    expect(status.available).toBe(true);
    expect(status.version).toBe('9.9.9');
    expect(status.loggedIn).toBe(true);
    expect(status.authMethod).toBe('oauth_token');
    expect(status.error).toBeNull();
  });

  it('reports not-signed-in when the CLI has no account', async () => {
    process.env.CLAUDE_STUB_LOGGED_IN = '0';
    const status = await getClaudeCliStatus({ force: true });
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.error).toMatch(/sign/i);
  });

  it('runs a non-streaming generation and maps usage + cost', async () => {
    const before = getUsageTotals().calls;
    const res = await callClaudeCli(role, { system: 'be brief', user: 'ping' });
    expect(res.text).toBe('ECHO:ping');
    expect(res.model).toBe('claude-opus-5');
    // input_tokens (5) + cache_creation (2) + cache_read (1) — the full prompt size.
    expect(res.inputTokens).toBe(8);
    expect(res.outputTokens).toBe(7);
    expect(res.cacheReadInputTokens).toBe(1);
    expect(res.costUsd).toBe(0.02);
    expect(getUsageTotals().calls).toBe(before + 1);
    expect(getUsageTotals().costUsd).toBeCloseTo(0.02, 5);
  });

  it('counts cache tokens as input, so Claude Code cached context is not undercounted', async () => {
    // Claude Code reports almost the entire prompt under cache_creation/cache_read
    // and only a tiny `input_tokens` delta; the mapped input must be their sum.
    const before = getUsageTotals().inputTokens;
    const res = await callClaudeCli(role, { system: 'x', user: 'ping' });
    expect(res.inputTokens).toBe(8); // 5 + 2 + 1
    expect(getUsageTotals().inputTokens).toBe(before + 8);
  });

  it('streams text deltas then a done chunk with usage', async () => {
    const chunks: StreamChunk[] = [];
    for await (const chunk of streamClaudeCli(role, { system: 'be brief', user: 'ping' })) {
      chunks.push(chunk);
    }
    const text = chunks
      .filter((c) => c.type === 'text')
      .map((c) => c.data)
      .join('');
    expect(text).toBe('Hello world');
    const done = chunks.find((c) => c.type === 'done');
    expect(done).toBeDefined();
    const data = done!.data as { model: string; inputTokens: number; outputTokens: number; costUsd: number };
    expect(data.model).toBe('claude-sonnet-5');
    // input_tokens (11) + cache_creation (4) + cache_read (3).
    expect(data.inputTokens).toBe(18);
    expect(data.outputTokens).toBe(2);
    expect(data.costUsd).toBe(0.01);
  });

  it('omits version-gated flags an older CLI does not advertise (no --restricted)', async () => {
    // The stub errors on --restricted in this mode; the call must still succeed
    // because buildArgs only passes flags the CLI's --help lists.
    process.env.CLAUDE_STUB_OLD = '1';
    try {
      const res = await callClaudeCli(role, { system: 'x', user: 'ping' });
      expect(res.text).toBe('ECHO:ping');
    } finally {
      delete process.env.CLAUDE_STUB_OLD;
    }
  });

  it('passes the CLI its own settings and none of the server secrets or ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-be-stripped';
    process.env.PIWI_SECRET_KEY = 'server-secret';
    process.env.CLAUDE_CONFIG_DIR = '/home/ada/.claude-work';
    try {
      const res = await callClaudeCli(role, { system: 'x', user: 'ENVCHECK' });
      expect(res.text).toBe(
        `ANTHROPIC_API_KEY=unset;PIWI_SECRET_KEY=unset;CLAUDE_CONFIG_DIR=/home/ada/.claude-work;HOME=${process.env.HOME}`,
      );
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.PIWI_SECRET_KEY;
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('turns every tool and MCP server off and allows one turn', async () => {
    const args = JSON.parse((await callClaudeCli(role, { system: 'x', user: 'ARGS' })).text) as string[];
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('1');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--restricted');
  });

  it('refuses to run a CLI that cannot turn its tools off', async () => {
    process.env.CLAUDE_STUB_ANCIENT = '1';
    await expect(callClaudeCli(role, { system: 'x', user: 'ping' })).rejects.toThrow(/Update Claude Code/);
  });

  it('refuses to run when --help fails, and reads it again on the next call', async () => {
    process.env.CLAUDE_STUB_HELP_FAIL = '1';
    await expect(callClaudeCli(role, { system: 'x', user: 'ping' })).rejects.toThrow(/tools turned off/);
    delete process.env.CLAUDE_STUB_HELP_FAIL;
    expect((await callClaudeCli(role, { system: 'x', user: 'ping' })).text).toBe('ECHO:ping');
  });

  it('refuses to generate when the CLI is not signed in', async () => {
    process.env.CLAUDE_STUB_LOGGED_IN = '0';
    resetClaudeCliCache();
    await expect(callClaudeCli(role, { system: 'x', user: 'y' })).rejects.toThrow(/sign/i);
  });
  describe('an assistant turn', () => {
    const TOKEN = 'pwt_turn_token';
    const URL = 'http://127.0.0.1:3000/api/assistant/conversations/7/mcp';
    function agentRun(text: string[]): ClaudeCliAgentRun {
      return {
        system: 'rules',
        prompt: 'Which projects report here?',
        server: { url: URL, token: TOKEN },
        tools: ['list_projects', 'ask'],
        maxTurns: 12,
        timeoutMs: 15_000,
        onText: (t) => text.push(t),
      };
    }

    it('runs only when the CLI can attach an MCP server and allow its tools', async () => {
      expect(await claudeCliRunsAgents()).toBe(false);
      process.env.CLAUDE_STUB_AGENT = '1';
      resetClaudeCliCache();
      expect(await claudeCliRunsAgents()).toBe(true);
      process.env.PIWI_CLAUDE_CLI_PATH = join(dir, 'does-not-exist');
      resetClaudeCliCache();
      expect(await claudeCliRunsAgents()).toBe(false);
    });

    it('attaches the turn endpoint alone through a private file, streams the text and reports usage', async () => {
      process.env.CLAUDE_STUB_AGENT = '1';
      const text: string[] = [];
      const result = await runClaudeCliAgent(role, agentRun(text));
      expect(result).toMatchObject({
        outcome: 'answered',
        error: null,
        model: 'claude-sonnet-5',
        inputTokens: 120,
        outputTokens: 9,
        costUsd: 0.03,
      });
      // Streamed once, by its deltas: the whole message that follows them is not written again.
      expect(text).toHaveLength(1);
      const seen = JSON.parse(text[0]!) as {
        args: string[];
        config: unknown;
        configPath: string;
        prompt: string;
        noProxy: string;
      };
      expect(seen.config).toEqual({
        mcpServers: { piwi: { type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN}` } } },
      });
      expect(seen.args.join(' ')).not.toContain(TOKEN);
      expect(seen.args[seen.args.indexOf('--tools') + 1]).toBe('');
      expect(seen.args).toContain('--strict-mcp-config');
      expect(seen.args[seen.args.indexOf('--allowedTools') + 1]).toBe('mcp__piwi__list_projects,mcp__piwi__ask');
      expect(seen.args[seen.args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
      expect(seen.args[seen.args.indexOf('--max-turns') + 1]).toBe('12');
      expect(seen.prompt).toBe('Which projects report here?');
      expect(seen.noProxy).toContain('127.0.0.1');
      // The config, and its token, are gone once the run ends.
      expect(existsSync(seen.configPath)).toBe(false);
    });

    it('writes each message whole when the CLI streams no partial messages', async () => {
      process.env.CLAUDE_STUB_AGENT = '1';
      process.env.CLAUDE_STUB_NO_PARTIAL = '1';
      const text: string[] = [];
      expect((await runClaudeCliAgent(role, agentRun(text))).outcome).toBe('answered');
      expect(JSON.parse(text.join('')).prompt).toBe('Which projects report here?');
    });

    it('stops at once a run whose MCP server did not connect', async () => {
      process.env.CLAUDE_STUB_AGENT = '1';
      process.env.CLAUDE_STUB_MCP_STATUS = 'failed';
      const started = Date.now();
      const result = await runClaudeCliAgent(role, agentRun([]));
      expect(result).toMatchObject({ outcome: 'failed', model: '', inputTokens: null });
      expect(result.error).toMatch(/could not reach this server's assistant tools \(failed\)/);
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('reports a run out of turns, and a failed one, with what they spent', async () => {
      process.env.CLAUDE_STUB_AGENT = '1';
      process.env.CLAUDE_STUB_SUBTYPE = 'error_max_turns';
      expect(await runClaudeCliAgent(role, agentRun([]))).toMatchObject({ outcome: 'max-turns', outputTokens: 9 });
      process.env.CLAUDE_STUB_SUBTYPE = 'error_during_execution';
      expect(await runClaudeCliAgent(role, agentRun([]))).toMatchObject({ outcome: 'failed', error: 'final' });
    });

    it('refuses a CLI that cannot attach only the turn server', async () => {
      await expect(runClaudeCliAgent(role, agentRun([]))).rejects.toThrow(/Update Claude Code/);
    });
  });
});

describe('launching the CLI without a shell', () => {
  const NPM_SHIM = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n');

  it("reads the script npm's claude.cmd shim runs", () => {
    expect(cmdShimTarget(NPM_SHIM, 'C:\\Users\\ada\\AppData\\Roaming\\npm')).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    );
    expect(cmdShimTarget('@ECHO off\r\nclaude %*', 'C:\\npm')).toBeNull();
  });

  it('runs the shim target with Node, and a script with Node', () => {
    const shimDir = mkdtempSync(join(tmpdir(), 'claude-shim-'));
    try {
      const shim = join(shimDir, 'claude.cmd');
      writeFileSync(shim, NPM_SHIM);
      const { command, args } = cliCommand(shim, ['--version']);
      expect(command).toBe(process.execPath);
      expect(args[0]).toMatch(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js$/);
      expect(args.slice(1)).toEqual(['--version']);

      writeFileSync(join(shimDir, 'broken.cmd'), '@ECHO off');
      expect(() => cliCommand(join(shimDir, 'broken.cmd'), [])).toThrow(/PIWI_CLAUDE_CLI_PATH/);
    } finally {
      rmSync(shimDir, { recursive: true, force: true });
    }
    expect(cliCommand('/opt/claude/cli.js', ['-p'])).toEqual({
      command: process.execPath,
      args: ['/opt/claude/cli.js', '-p'],
    });
    expect(cliCommand('/usr/local/bin/claude', ['-p'])).toEqual({ command: '/usr/local/bin/claude', args: ['-p'] });
  });
});

describe('the CLI environment', () => {
  it('keeps the allowlist, the locale and the cloud credentials only of the provider Claude Code is set to', () => {
    const env = cliEnv({
      HOME: '/home/ada',
      LC_ALL: 'fr_FR.UTF-8',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-1',
      ANTHROPIC_API_KEY: 'sk-ant-api',
      PIWI_SECRET_KEY: 'secret',
      PIWI_DATABASE_URL: 'postgres://u:p@db/piwi',
      PIWI_SMTP_PASSWORD: 'smtp',
      AWS_SECRET_ACCESS_KEY: 'aws',
      PATH: '/usr/bin',
    });
    expect(env).toMatchObject({ HOME: '/home/ada', LC_ALL: 'fr_FR.UTF-8', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-1' });
    for (const name of [
      'ANTHROPIC_API_KEY',
      'PIWI_SECRET_KEY',
      'PIWI_DATABASE_URL',
      'PIWI_SMTP_PASSWORD',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
    expect(env.PATH?.split(delimiter)).toContain('/usr/bin');
    expect(cliEnv({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: 'aws' }).AWS_SECRET_ACCESS_KEY).toBe('aws');
  });
});
