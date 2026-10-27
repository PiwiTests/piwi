import { runCliProcess, type CliProcessResult } from './ai-cli-process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { isDesktopRuntime, withLoopbackNoProxy } from './ai-claude-cli';
import type { ClaudeCliAgentResult, ClaudeCliAgentRun } from './ai-claude-cli';
import type { AiCallOptions, AiCallResult, StreamChunk } from './ai-provider';
import type { CodexCliStatus, ResolvedAiRole } from '~~/types/api';

const DEFAULT_MODEL = 'gpt-5.4';
const PROBE_TIMEOUT_MS = 15_000;
const GENERATION_TIMEOUT_MS = 180_000;
const REQUIRED_FLAGS = [
  '--json',
  '--ephemeral',
  '--output-schema',
  '--ignore-user-config',
  '--ignore-rules',
  '--output-last-message',
];
const usage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, since: null as string | null };

export function codexCliEnabled(): boolean {
  return isDesktopRuntime() || Boolean(process.env.PIWI_CODEX_CLI_PATH?.trim());
}

function resolveBinary(): string | null {
  const override = process.env.PIWI_CODEX_CLI_PATH?.trim();
  if (override) return isAbsolute(override) && existsSync(override) ? override : null;
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm'),
  ];
  for (const dir of dirs) for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name);
  return null;
}

/** Only transport, locale and OS variables reach the CLI; credentials and execution hooks are excluded. */
export function codexCliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed =
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|LANG|LANGUAGE|LC_[A-Z_]+|TZ|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE)$/i;
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && allowed.test(key)));
}

/** Each process has a private home, config, working directory and file-backed login snapshot. */
async function isolatedRun(
  binary: string,
  args: string[],
  opts: {
    timeoutMs: number;
    input?: string;
    setup?: (dir: string) => string[];
    onLine?: (line: string) => void;
    token?: string;
    signal?: AbortSignal;
    onExit?: (dir: string) => void;
  },
): Promise<CliProcessResult> {
  const dir = mkdtempSync(join(tmpdir(), 'piwi-codex-'));
  const home = join(dir, 'home');
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const originalAuth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  const authPath = join(codexHome, 'auth.json');
  let auth: string | null = null;
  try {
    if (existsSync(originalAuth)) {
      const snapshot = readFileSync(originalAuth, 'utf8');
      const parsed = JSON.parse(snapshot);
      if (parsed.tokens?.access_token && !parsed.OPENAI_API_KEY) {
        auth = snapshot;
        writeFileSync(authPath, auth, { mode: 0o600 });
      }
    }
    const extraArgs = opts.setup?.(dir) ?? [];
    const env = withLoopbackNoProxy({
      ...codexCliEnv(),
      PATH: [dirname(process.execPath), dirname(binary), process.env.PATH ?? ''].join(delimiter),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      CODEX_HOME: codexHome,
      ...(opts.token ? { CODEX_PIWI_TURN_TOKEN: opts.token } : {}),
    });
    const result = await runCliProcess(binary, [...args, ...extraArgs], { ...opts, cwd: dir, env });
    opts.onExit?.(dir);
    return result;
  } finally {
    // Persist refreshed login tokens only if another login or run has not changed the source snapshot.
    try {
      if (auth !== null && readFileSync(originalAuth, 'utf8') === auth) {
        const refreshed = readFileSync(authPath, 'utf8');
        if (refreshed !== auth) writeFileSync(originalAuth, refreshed, { mode: 0o600 });
      }
    } catch {
      // A read-only login remains usable until the account requires a refresh.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Capabilities {
  binary: string;
  version: string;
  features: string[];
}
let cached: { at: number; status: CodexCliStatus; capabilities: Capabilities | null } | null = null;

export async function getCodexCliStatus(opts: { force?: boolean } = {}): Promise<CodexCliStatus> {
  if (!opts.force && cached && Date.now() - cached.at < 4_000) return { ...cached.status, usage: { ...usage } };
  const status: CodexCliStatus = {
    available: false,
    binaryPath: null,
    version: null,
    loggedIn: false,
    authMethod: null,
    error: null,
    usage: { ...usage },
  };
  let capabilities: Capabilities | null = null;
  const binary = codexCliEnabled() ? resolveBinary() : null;
  if (!binary) {
    status.error = 'Install Codex locally, or set PIWI_CODEX_CLI_PATH to its absolute executable path on the server.';
  } else {
    try {
      const version = await isolatedRun(binary, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
      const help = await isolatedRun(binary, ['exec', '--help'], { timeoutMs: PROBE_TIMEOUT_MS });
      const features = await isolatedRun(binary, ['features', 'list'], { timeoutMs: PROBE_TIMEOUT_MS });
      const featureNames = [...features.stdout.matchAll(/^([a-z][a-z0-9_]+)\s+.+\s+(?:true|false)\s*$/gm)].map(
        (m) => m[1]!,
      );
      if (
        version.code !== 0 ||
        help.code !== 0 ||
        features.code !== 0 ||
        !featureNames.includes('shell_tool') ||
        REQUIRED_FLAGS.some((flag) => !help.stdout.includes(flag))
      ) {
        status.error = 'Update Codex CLI: this version cannot provide the required isolated execution controls.';
      } else {
        status.available = true;
        status.binaryPath = binary;
        status.version = version.stdout.trim();
        capabilities = { binary, version: status.version, features: featureNames };
        const login = await isolatedRun(binary, ['login', 'status'], { timeoutMs: PROBE_TIMEOUT_MS });
        // Only file-backed ChatGPT logins may authenticate an isolated run.
        status.loggedIn = login.code === 0 && hasChatGptLogin();
        status.authMethod = status.loggedIn ? 'chatgpt' : null;
        if (!status.loggedIn)
          status.error =
            'Run `codex login` on this machine with cli_auth_credentials_store="file". Piwi reuses the ChatGPT login in CODEX_HOME/auth.json; API keys and keyring-only logins are not used.';
      }
    } catch {
      status.error = 'Could not run the local Codex CLI.';
    }
  }
  cached = { at: Date.now(), status, capabilities };
  return { ...status, usage: { ...usage } };
}

function hasChatGptLogin(): boolean {
  try {
    const auth = JSON.parse(
      readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), 'utf8'),
    );
    return Boolean(auth.tokens?.access_token) && !auth.OPENAI_API_KEY;
  } catch {
    return false;
  }
}

/** Minimal model metadata exposes no model-specific filesystem or execution tools. */
function modelCatalog(model: string, system: string): string {
  return JSON.stringify({
    models: [
      {
        slug: model,
        display_name: model,
        description: null,
        default_reasoning_level: null,
        supported_reasoning_levels: [],
        shell_type: 'shell_command',
        visibility: 'list',
        supported_in_api: true,
        priority: 0,
        upgrade: null,
        model_messages: { instructions_template: system },
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: null,
        truncation_policy: { mode: 'bytes', limit: 10000 },
        context_window: 272000,
        max_context_window: 272000,
        experimental_supported_tools: [],
      },
    ],
  });
}

interface CodexEvent {
  type?: string;
  item?: { id?: string; type?: string; text?: string; server?: string; tool?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    cache_write_input_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
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
  const status = await getCodexCliStatus();
  if (!status.available || !status.loggedIn || !cached?.capabilities)
    throw new Error(status.error ?? 'Codex is unavailable.');
  const { binary, features } = cached.capabilities;
  const model = config.model || DEFAULT_MODEL;
  const outcome: ClaudeCliAgentResult = {
    text: '',
    model,
    inputTokens: null,
    outputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: null,
    outcome: 'failed',
    error: null,
  };
  let completed = false;
  let calls = 0;
  let maxTurns = false;
  const stop = new AbortController();
  // The user's Stop on an assistant turn kills the run.
  const onStop = () => stop.abort();
  opts.agent?.signal?.addEventListener('abort', onStop, { once: true });
  if (opts.agent?.signal?.aborted) onStop();
  const seen = new Set<string>();
  const result = await isolatedRun(
    binary,
    [
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '--model',
      model,
    ],
    {
      timeoutMs: opts.timeoutMs,
      signal: stop.signal,
      input: opts.prompt,
      token: opts.agent?.server.token,
      setup(dir) {
        const catalogPath = join(dir, 'models.json');
        const instructionsPath = join(dir, 'instructions.txt');
        writeFileSync(catalogPath, modelCatalog(model, opts.system), { mode: 0o600 });
        writeFileSync(instructionsPath, opts.system, { mode: 0o600 });
        const settings = [
          'mcp_servers={}',
          `model_catalog_json=${JSON.stringify(catalogPath)}`,
          `model_instructions_file=${JSON.stringify(instructionsPath)}`,
          'model_provider="openai"',
          'approval_policy="never"',
          'web_search="disabled"',
          'project_doc_max_bytes=0',
          'cli_auth_credentials_store="file"',
          'shell_environment_policy.inherit="none"',
          'tools.update_plan.enabled=false',
          'tools.experimental_request_user_input.enabled=false',
        ];
        if (opts.jsonSchema) {
          const schemaPath = join(dir, 'schema.json');
          writeFileSync(schemaPath, JSON.stringify(opts.jsonSchema), { mode: 0o600 });
        }
        if (opts.agent) {
          settings.push(
            `mcp_servers={piwi={url=${JSON.stringify(opts.agent.server.url)},bearer_token_env_var="CODEX_PIWI_TURN_TOKEN",enabled_tools=${JSON.stringify(opts.agent.tools)},required=true}}`,
          );
        }
        return [
          ...features.flatMap((feature) => [
            feature === 'skip_host_skill_discovery' ? '--enable' : '--disable',
            feature,
          ]),
          ...settings.flatMap((setting) => ['--config', setting]),
          '--output-last-message',
          join(dir, 'final.txt'),
          ...(opts.jsonSchema ? ['--output-schema', join(dir, 'schema.json')] : []),
          '-',
        ];
      },
      onExit(dir) {
        if (!opts.agent && existsSync(join(dir, 'final.txt')))
          outcome.text = readFileSync(join(dir, 'final.txt'), 'utf8');
      },
      onLine(line) {
        let event: CodexEvent;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === 'item.started' && event.item?.type === 'mcp_tool_call') {
          if (
            ++calls > (opts.agent?.maxTurns ?? 0) ||
            event.item.server !== 'piwi' ||
            !opts.agent?.tools.includes(event.item.tool ?? '')
          ) {
            maxTurns = calls > (opts.agent?.maxTurns ?? 0);
            outcome.error = 'Codex attempted a tool call outside this turn’s allowance.';
            stop.abort();
          }
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          const id = event.item.id;
          if (id && seen.has(id)) return;
          if (id) seen.add(id);
          outcome.text += event.item.text;
          if (!opts.jsonSchema) opts.onText(event.item.text);
        } else if (event.type === 'turn.completed') {
          completed = true;
          outcome.inputTokens = event.usage?.input_tokens ?? null;
          outcome.outputTokens = event.usage?.output_tokens ?? null;
          outcome.cacheReadInputTokens = event.usage?.cached_input_tokens ?? null;
          outcome.cacheCreationInputTokens = event.usage?.cache_write_input_tokens ?? null;
        } else if (event.type === 'turn.failed') {
          outcome.error = 'Codex reported a failed turn. Check the local Codex login and model access.';
        }
      },
    },
  );
  if (completed) {
    usage.calls++;
    usage.inputTokens += outcome.inputTokens ?? 0;
    usage.outputTokens += outcome.outputTokens ?? 0;
    usage.cacheReadInputTokens += outcome.cacheReadInputTokens ?? 0;
    usage.since ??= new Date().toISOString();
  }
  opts.agent?.signal?.removeEventListener('abort', onStop);
  if (opts.agent?.signal?.aborted) return { ...outcome, outcome: 'stopped' };
  if (maxTurns) return { ...outcome, outcome: 'max-turns' };
  if (result.timedOut) return { ...outcome, outcome: 'timeout', error: 'The Codex CLI timed out.' };
  if (result.code !== 0 || !completed || outcome.error)
    return {
      ...outcome,
      error: outcome.error ?? 'Codex exited without completing the turn. Check the local CLI and model access.',
    };
  if (opts.jsonSchema && outcome.text) opts.onText(outcome.text);
  return { ...outcome, outcome: 'answered' };
}

export async function runCodexCliAgent(config: ResolvedAiRole, run: ClaudeCliAgentRun): Promise<ClaudeCliAgentResult> {
  return execute(config, { ...run, agent: run });
}

export async function callCodexCli(config: ResolvedAiRole, opts: AiCallOptions): Promise<AiCallResult> {
  const result = await execute(config, {
    system: opts.system,
    prompt: opts.user,
    jsonSchema: opts.jsonSchema,
    timeoutMs: GENERATION_TIMEOUT_MS,
    onText() {},
  });
  if (result.outcome !== 'answered') throw new Error(result.error ?? 'Codex failed.');
  return result;
}

export async function* streamCodexCli(config: ResolvedAiRole, opts: AiCallOptions): AsyncGenerator<StreamChunk> {
  const queue: StreamChunk[] = [];
  const done = execute(config, {
    system: opts.system,
    prompt: opts.user,
    jsonSchema: opts.jsonSchema,
    timeoutMs: GENERATION_TIMEOUT_MS,
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
    if (result.outcome !== 'answered') yield { type: 'error', data: result.error ?? 'Codex failed.' };
    else yield { type: 'done', data: result };
  } catch (err) {
    yield { type: 'error', data: err instanceof Error ? err.message : String(err) };
  }
}
