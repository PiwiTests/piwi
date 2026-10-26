import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isDesktopRuntime, withLoopbackNoProxy } from './ai-claude-cli';
import { codexCliEnv } from './ai-codex-cli';
import { runCliProcess } from './ai-cli-process';
import type { ClaudeCliAgentRun, ClaudeCliAgentResult } from './ai-claude-cli';
import type { AiCallOptions, AiCallResult, StreamChunk } from './ai-provider';
import type { CodexCliStatus, ResolvedAiRole } from '~~/types/api';

const DEFAULT_MODEL = 'deepseek-flash';
const ACCOUNT_KEY = 'deepseek-account-platform/default';
const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, since: null as string | null };

export function deepseekCliEnabled(): boolean {
  return isDesktopRuntime() || Boolean(process.env.PIWI_DEEPSEEK_CLI_PATH?.trim());
}

function resolveBinary(): string | null {
  const override = process.env.PIWI_DEEPSEEK_CLI_PATH?.trim();
  if (override) return isAbsolute(override) && existsSync(override) ? override : null;
  const names = process.platform === 'win32' ? ['dsh.exe', 'dsh.cmd', 'dsh'] : ['dsh'];
  for (const dir of [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm'),
  ]) {
    for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

interface DeepseekAuth {
  method: 'account' | 'api-key' | null;
  document: object;
  apiKey?: string;
}

/** Select only DeepSeek's account grant or API key from the official CLI's credential store. */
function readAuth(): DeepseekAuth {
  const path = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml');
  let stored;
  try {
    stored = existsSync(path) ? parseYaml(readFileSync(path, 'utf8'), { maxAliasCount: 0 }) : null;
  } catch {
    throw new Error('The DeepSeek credential store could not be read.');
  }
  const grant = stored?.records?.[ACCOUNT_KEY];
  if (
    grant?.kind === 'grant' &&
    grant.payload?.version === 1 &&
    typeof grant.payload.token === 'string' &&
    grant.payload.token &&
    grant.payload.issuer === 'https://platform.deepseek.com'
  ) {
    return {
      method: 'account',
      document: {
        version: 1,
        records: {
          [ACCOUNT_KEY]: {
            kind: 'grant',
            payload: { version: 1, token: grant.payload.token, issuer: grant.payload.issuer },
          },
        },
      },
    };
  }
  const key = stored?.refs?.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (typeof key === 'string' && key.trim()) return { method: 'api-key', document: { version: 1 }, apiKey: key };
  return { method: null, document: { version: 1 } };
}

interface Entry {
  id: string;
  name: string;
  config?: object;
}

/** An empty profile with an explicit roster of official plugins; no inherited bundle or user overlay. */
export function deepseekCliProfile(
  system: string,
  model: string,
  authMethod: DeepseekAuth['method'],
  server?: ClaudeCliAgentRun['server'],
): object[] {
  const plugin = (id: string, name: string, config?: object): Entry => ({
    id,
    name: `@deepseek-ai/${name}`,
    ...(config ? { config } : {}),
  });
  const entries: Entry[] = [
    plugin('timer', 'cordis-plugin-timer'),
    plugin('llm', 'dsh-llm'),
    plugin('session', 'dsh-session'),
    plugin('session-projection', 'dsh-session-projection'),
    plugin('agent', 'dsh-agent'),
    plugin('system-prompt', 'dsh-system-prompt', {
      personaPrefix: system,
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
    }),
    plugin('tools', 'dsh-tools'),
    plugin('agent-loop', 'dsh-agent-loop', { agents: [] }),
    plugin('agent-default-model', 'dsh-agent-default-model', {
      provider: authMethod === 'account' ? 'deepseek-account' : 'deepseek-official',
      model,
    }),
    plugin('headless-runner', 'dsh-headless', { json: true }),
    plugin('llm-deepseek', authMethod === 'account' ? 'dsh-llm-deepseek-account' : 'dsh-llm-deepseek-api-key'),
  ];
  if (authMethod === 'account')
    entries.push(
      plugin('credentials', 'dsh-credentials-local', { watch: false }),
      plugin('authorization', 'dsh-authorization'),
      plugin('deepseek-account', 'dsh-deepseek-account-platform'),
    );
  if (server)
    entries.push(
      plugin('piwi', 'dsh-mcp-client', {
        serverName: 'piwi',
        transport: 'streamable-http',
        url: server.url,
        headers: { Authorization: `Bearer ${server.token}` },
        failOnStartupError: true,
        reconnect: { enabled: false },
      }),
    );
  return [{ insert: entries }];
}

async function withRuntime<T>(
  binary: string,
  auth: DeepseekAuth,
  profile: object[],
  run: (runtime: { dir: string; env: NodeJS.ProcessEnv }) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'piwi-deepseek-'));
  try {
    const home = join(dir, 'home');
    const dshHome = join(home, '.dsh');
    const profileDir = join(dshHome, 'profiles', 'piwi');
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }),
      { mode: 0o600 },
    );
    writeFileSync(join(profileDir, 'cordis.patch.yml'), JSON.stringify(profile), { mode: 0o600 });
    writeFileSync(join(dshHome, '.credentials.yaml'), JSON.stringify(auth.document), { mode: 0o600 });
    const env = withLoopbackNoProxy({
      ...codexCliEnv(),
      PATH: [dirname(process.execPath), dirname(binary), process.env.PATH ?? ''].join(delimiter),
      HOME: home,
      USERPROFILE: home,
      DSH_HOME: dshHome,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      ...(auth.apiKey ? { DEEPSEEK_API_KEY: auth.apiKey } : {}),
    });
    return await run({ dir, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function getDeepseekCliStatus(): Promise<CodexCliStatus> {
  const binary = deepseekCliEnabled() ? resolveBinary() : null;
  const status: CodexCliStatus = {
    available: false,
    binaryPath: binary,
    version: null,
    loggedIn: false,
    authMethod: null,
    error: null,
    usage: { ...usage },
  };
  if (!binary)
    return {
      ...status,
      error: 'Install the official @deepseek-ai/dsh CLI, or set PIWI_DEEPSEEK_CLI_PATH to its absolute launcher path.',
    };
  try {
    const auth = readAuth();
    await withRuntime(
      binary,
      auth,
      deepseekCliProfile('You are an assistant.', DEFAULT_MODEL, auth.method),
      async ({ dir, env }) => {
        const version = await runCliProcess(binary, ['--version'], { cwd: dir, env, timeoutMs: 15_000 });
        const dump = await runCliProcess(binary, ['--profile', 'piwi', '--dump-config'], {
          cwd: dir,
          env,
          timeoutMs: 15_000,
        });
        if (version.code !== 0 || !/(?:^|\s|\/)0\.2\.1-rc\.2(?:\s|$)/.test(version.stdout) || dump.code !== 0)
          throw new Error('incompatible');
        const entries = parseYaml(dump.stdout);
        const expected = deepseekCliProfile('You are an assistant.', DEFAULT_MODEL, auth.method)[0] as {
          insert: Entry[];
        };
        if (
          !Array.isArray(entries) ||
          entries.length !== expected.insert.length ||
          entries.some((entry, index) => entry.name !== expected.insert[index]?.name)
        )
          throw new Error('incompatible');
        status.available = true;
        status.version = version.stdout.trim();
        status.loggedIn = auth.method !== null;
        status.authMethod = auth.method;
        if (!status.loggedIn)
          status.error =
            'Sign in with the official DeepSeek Harness UI, or configure DEEPSEEK_API_KEY for the CLI. Credential presence is checked locally; validity is checked on use.';
      },
    );
  } catch {
    status.error =
      'Could not load the isolated DeepSeek profile. Update the official @deepseek-ai/dsh CLI and check its credential store.';
  }
  return status;
}

interface DeepseekEvent {
  type?: string;
  text?: string;
  phase?: string;
  turn?: number;
  step?: number;
  tool?: string;
  truncated?: boolean;
  reason?: { kind?: string };
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

async function execute(
  config: ResolvedAiRole,
  opts: {
    system: string;
    prompt: string;
    timeoutMs: number;
    onText: (text: string) => void;
    jsonSchema?: object;
    agent?: ClaudeCliAgentRun;
  },
): Promise<ClaudeCliAgentResult> {
  const status = await getDeepseekCliStatus();
  if (!status.available || !status.loggedIn) throw new Error(status.error ?? 'DeepSeek is unavailable.');
  const binary = status.binaryPath;
  if (!binary)
    throw new Error(
      'The official DeepSeek CLI is unavailable. Set PIWI_DEEPSEEK_CLI_PATH or install @deepseek-ai/dsh.',
    );
  const auth = readAuth();
  if (!auth.method) throw new Error('Sign in to DeepSeek Harness or configure DEEPSEEK_API_KEY.');
  const model = config.model || DEFAULT_MODEL;
  const system = opts.jsonSchema
    ? `${opts.system}\n\nRespond ONLY with JSON matching this schema, without prose or markdown fences:\n${JSON.stringify(opts.jsonSchema)}`
    : opts.system;
  const result: ClaudeCliAgentResult = {
    text: '',
    model,
    inputTokens: null,
    outputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    costUsd: null,
    outcome: 'failed',
    error: null,
  };
  let final: DeepseekEvent | null = null;
  let lastStepEmitted = false;
  let stepText = '';
  let stepTruncated = false;
  let turnEnd: DeepseekEvent['reason'];
  let calls = 0;
  const steps = new Map<string, DeepseekEvent['usage']>();
  const stop = new AbortController();
  const proc = await withRuntime(
    binary,
    auth,
    deepseekCliProfile(system, model, auth.method, opts.agent?.server),
    async ({ dir, env }) =>
      runCliProcess(binary, ['--profile', 'piwi'], {
        cwd: dir,
        env,
        input: opts.prompt,
        timeoutMs: opts.timeoutMs,
        signal: stop.signal,
        onLine(line) {
          let event: DeepseekEvent;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type === 'text' && !opts.jsonSchema) {
            stepText += event.text ?? '';
            stepTruncated ||= event.truncated === true;
          }
          if (event.type === 'status' && event.phase === 'step_end') {
            steps.set(`${event.turn}:${event.step}`, event.usage);
            if (stepText || stepTruncated) {
              lastStepEmitted = !stepTruncated;
              if (lastStepEmitted) opts.onText(stepText);
            }
            stepText = '';
            stepTruncated = false;
          }
          if (
            event.type === 'tool_call' &&
            (++calls > (opts.agent?.maxTurns ?? 0) ||
              !opts.agent?.tools.some((tool) => event.tool === `mcp__piwi__${tool}`))
          ) {
            result.error = 'DeepSeek attempted a tool outside this turn’s allowance.';
            stop.abort();
          }
          if (event.type === 'status' && event.phase === 'turn_end') turnEnd = event.reason;
          if (event.type === 'final') final = event;
        },
      }),
  );
  const terminal = final as DeepseekEvent | null;
  const sum = (key: keyof NonNullable<DeepseekEvent['usage']>) =>
    steps.size && [...steps.values()].every((step) => typeof step?.[key] === 'number')
      ? [...steps.values()].reduce((total, step) => total + (step?.[key] ?? 0), 0)
      : null;
  const input = sum('inputTokens');
  result.inputTokens = input === null ? null : input + (sum('cacheReadTokens') ?? 0) + (sum('cacheWriteTokens') ?? 0);
  result.outputTokens = sum('outputTokens');
  result.cacheReadInputTokens = sum('cacheReadTokens');
  result.cacheCreationInputTokens = sum('cacheWriteTokens');
  if (steps.size) {
    usage.calls++;
    usage.since ??= new Date().toISOString();
    usage.inputTokens += result.inputTokens ?? 0;
    usage.outputTokens += result.outputTokens ?? 0;
    usage.cacheReadInputTokens += result.cacheReadInputTokens ?? 0;
  }
  if (proc.timedOut) return { ...result, outcome: 'timeout', error: 'The DeepSeek CLI timed out.' };
  if (calls > (opts.agent?.maxTurns ?? 0)) return { ...result, outcome: 'max-turns' };
  if (
    /entry did not activate|entries did not activate/.test(proc.stderr) ||
    proc.code !== 0 ||
    (terminal?.reason ?? turnEnd)?.kind !== 'completed' ||
    result.error ||
    typeof terminal?.text !== 'string'
  )
    return {
      ...result,
      error: result.error ?? 'DeepSeek did not complete the turn. Check the CLI, credential and model access.',
    };
  result.text = terminal.text;
  if (!lastStepEmitted || opts.jsonSchema) opts.onText(result.text);
  return { ...result, outcome: 'answered' };
}

export async function runDeepseekCliAgent(
  config: ResolvedAiRole,
  run: ClaudeCliAgentRun,
): Promise<ClaudeCliAgentResult> {
  return execute(config, { ...run, agent: run });
}
export async function callDeepseekCli(config: ResolvedAiRole, opts: AiCallOptions): Promise<AiCallResult> {
  const result = await execute(config, {
    system: opts.system,
    prompt: opts.user,
    jsonSchema: opts.jsonSchema,
    timeoutMs: 180_000,
    onText() {},
  });
  if (result.outcome !== 'answered') throw new Error(result.error ?? 'DeepSeek failed.');
  return result;
}
export async function* streamDeepseekCli(config: ResolvedAiRole, opts: AiCallOptions): AsyncGenerator<StreamChunk> {
  const queue: StreamChunk[] = [];
  const done = execute(config, {
    system: opts.system,
    prompt: opts.user,
    jsonSchema: opts.jsonSchema,
    timeoutMs: 180_000,
    onText: (text) => queue.push({ type: 'text', data: text }),
  });
  let settled = false;
  void done.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    while (!settled || queue.length) {
      if (queue.length) yield queue.shift()!;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = await done;
    yield result.outcome === 'answered'
      ? { type: 'done', data: result }
      : { type: 'error', data: result.error ?? 'DeepSeek failed.' };
  } catch (err) {
    yield { type: 'error', data: err instanceof Error ? err.message : String(err) };
  }
}
