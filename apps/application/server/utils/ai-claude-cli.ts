import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, win32 } from 'node:path';
import type { AiCallOptions, AiCallResult, StreamChunk } from './ai-provider';
import type { ClaudeCliStatus, ClaudeCliUsageTotals, ResolvedAiRole } from '~~/types/api';

/**
 * Backend for the `claude-cli` AI provider: the locally-installed `claude`
 * binary (Claude Code) driven headlessly via `claude -p --output-format json`.
 * Every generation runs with its tools off; an assistant turn runs in one
 * `claude -p` with only that turn's tools attached (`runClaudeCliAgent`).
 *
 * Only usable inside the desktop app, where the bundled Nitro server runs as a
 * local Node process on the user's machine and a `claude` install is expected.
 * Authentication is the CLI's own (subscription OAuth or a setup token), so no
 * API key is ever stored by Piwi. A self-hoster running the server directly can
 * opt in by pointing `PIWI_CLAUDE_CLI_PATH` at the binary.
 */

/** How long a single generation may run before it is killed. Cold start + a model turn. */
const GENERATION_TIMEOUT_MS = 180_000;
/** Quick metadata probes (version, auth status) get a short leash. */
const PROBE_TIMEOUT_MS = 15_000;
/** Interactive sign-in waits on a human completing a browser flow. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Status is polled by the settings UI; cache the (cheap but non-zero) probes briefly. */
const STATUS_CACHE_MS = 4_000;

/** True inside the desktop shell (which sets the guard token) or a desktop-mode preview. */
export function isDesktopRuntime(): boolean {
  return Boolean(process.env.PIWI_DESKTOP_TOKEN) || process.env.NUXT_PUBLIC_DESKTOP === 'true';
}

/** The CLI provider is offered when running as the desktop app, or when a binary path is pinned. */
export function claudeCliEnabled(): boolean {
  return isDesktopRuntime() || Boolean(process.env.PIWI_CLAUDE_CLI_PATH);
}

const isWindows = process.platform === 'win32';

/** Executable names to try, in order: on Windows the native `claude.exe` before npm's `claude.cmd` shim. */
function binaryNames(): string[] {
  return isWindows ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
}

/**
 * The script an npm `.cmd` shim runs (`"%dp0%\node_modules\…\cli.js" %*`),
 * resolved against the shim's folder; null when the shim names none.
 */
export function cmdShimTarget(shim: string, shimDir: string): string | null {
  const match = /"%~?dp0%?\\?([^"]+\.(?:js|mjs|cjs|exe))"/i.exec(shim);
  return match ? win32.join(shimDir, match[1]!) : null;
}

/**
 * The command and arguments that run `binary` without a shell. A script runs
 * with this process's Node; npm's `claude.cmd` shim, which Node cannot spawn
 * without a shell, runs the script (or executable) it points at.
 */
export function cliCommand(binary: string, args: string[]): { command: string; args: string[] } {
  if (/\.cmd$/i.test(binary)) {
    let target: string | null = null;
    try {
      target = cmdShimTarget(readFileSync(binary, 'utf8'), win32.dirname(binary));
    } catch {
      target = null;
    }
    if (!target) {
      throw new Error(
        `Could not read the Claude Code launcher ${binary}. Set PIWI_CLAUDE_CLI_PATH to claude.exe or to the package's cli.js.`,
      );
    }
    return cliCommand(target, args);
  }
  if (/\.(?:js|mjs|cjs)$/i.test(binary)) return { command: process.execPath, args: [binary, ...args] };
  return { command: binary, args };
}

/**
 * Directories a GUI-launched desktop app won't have on `PATH` but where the CLI
 * commonly installs. Searched after `PATH` so an explicit install still wins.
 * This is a fast pre-check; the login-shell lookup below covers version managers
 * (nvm/fnm/asdf/…) and any other location a user's shell knows about.
 */
function fallbackDirs(): string[] {
  const home = homedir();
  if (isWindows) {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(localAppData, 'Microsoft', 'WinGet', 'Links'), // winget shims
      join(appData, 'npm'), // npm global
      join(localAppData, 'Programs', 'claude'),
      join(home, '.claude', 'local'),
      join(home, '.claude', 'bin'),
    ];
  }
  const dirs = [
    join(home, '.claude', 'local'),
    join(home, '.claude', 'bin'),
    join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, '.asdf', 'shims'),
    '/usr/bin',
  ];
  const npmPrefix = process.env.npm_config_prefix || process.env.PREFIX;
  if (npmPrefix) dirs.push(join(npmPrefix, 'bin'));
  // Each nvm-managed Node version has its own bin dir.
  dirs.push(...globNodeVersionBins(join(home, '.nvm', 'versions', 'node')));
  return dirs;
}

/** Expand `<root>/<version>/bin` for every installed version under an nvm-style root. */
function globNodeVersionBins(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name, 'bin'));
  } catch {
    return [];
  }
}

// Only a positive resolution is memoized — a "not found" is never cached, so a
// later Recheck re-resolves after the user installs the CLI or sets the path.
let cachedBinary: string | undefined;
// The user's real PATH as reported by their login shell — captured once so a
// GUI-launched app can both find `claude` and give it a working environment.
let cachedShellPath: string | null | undefined;

/**
 * Resolve the `claude` binary synchronously: explicit override → `PATH` →
 * common install dirs. Returns null (uncached) when not found, so a follow-up
 * `resolveClaudeBinaryDeep` or Recheck can try the login shell.
 */
export function resolveClaudeBinary(): string | null {
  if (cachedBinary) return cachedBinary;

  const override = process.env.PIWI_CLAUDE_CLI_PATH?.trim();
  if (override) {
    if (existsSync(override)) {
      cachedBinary = override;
      return override;
    }
    return null;
  }

  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  return searchDirs([...pathDirs, ...fallbackDirs()]);
}

/** Find the first `claude` executable across `dirs`, memoizing a hit. */
function searchDirs(dirs: string[]): string | null {
  for (const dir of dirs) {
    for (const name of binaryNames()) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        cachedBinary = candidate;
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Ask the user's login shell for its `PATH` — the reliable way to find a CLI a
 * GUI-launched app can't see, since the app never sources the shell's rc files.
 * Captured once (positive or negative) for the process. Not attempted on Windows,
 * where GUI processes inherit a full `PATH`.
 */
async function loginShellPath(): Promise<string | null> {
  if (isWindows) return null;
  if (cachedShellPath !== undefined) return cachedShellPath;

  const shell = process.env.SHELL || '/bin/bash';
  // A login + interactive shell sources both profile and rc files (where PATH is
  // usually set). stdin is closed immediately, so it cannot hang on input.
  const res = await runClaude(shell, ['-lic', 'printf %s "$PATH"'], { timeoutMs: PROBE_TIMEOUT_MS });
  const line =
    res.code === 0
      ? res.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .pop()
      : '';
  cachedShellPath = line && line.includes('/') ? line : null;
  return cachedShellPath;
}

/**
 * Resolve the binary, falling back to the login shell's `PATH` when the quick
 * scan misses (the common desktop case where the app has a bare `PATH`).
 */
export async function resolveClaudeBinaryDeep(): Promise<string | null> {
  const quick = resolveClaudeBinary();
  if (quick) return quick;
  if (process.env.PIWI_CLAUDE_CLI_PATH) return null; // an explicit path was set but is missing

  const shellPath = await loginShellPath();
  if (!shellPath) return null;
  return searchDirs(shellPath.split(delimiter).filter(Boolean));
}

/** Testing/refresh hook: drop memoized resolution so the next call re-resolves. */
export function resetClaudeCliCache(): void {
  cachedBinary = undefined;
  cachedShellPath = undefined;
  cachedStatus = null;
  cliHelp = undefined;
}

/** Variables the CLI runs with besides `PATH`: the user's home, temp and locale, the network, and Windows' own. */
const ENV_ALLOWLIST = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'USERNAME',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'LANG',
  'LANGUAGE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
]);
/** Prefixes of the locale and of Claude Code's own settings and sign-in (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`). */
const ENV_PREFIXES = ['LC_', 'CLAUDE_', 'ANTHROPIC_'];
/** API credentials that would bill pay-as-you-go API credits instead of the user's Claude Code sign-in. */
const ENV_DROPPED = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
/** The cloud credentials Claude Code reads when it is set to Bedrock or Vertex, and only then. */
const BEDROCK_PREFIXES = ['AWS_'];
const VERTEX_PREFIXES = ['GOOGLE_', 'CLOUD_ML_', 'VERTEX_'];

/**
 * The environment the CLI runs with: the allowlisted variables of `source`
 * (never the server's own secrets, such as `PIWI_SECRET_KEY` or database and
 * SMTP credentials), and a `PATH` broad enough for the CLI to run (the process
 * PATH, the login shell's PATH when captured, the fallback dirs and the
 * resolved binary's own dir, deduped), since `claude` may itself need `node`
 * or other tools a bare GUI PATH lacks.
 */
export function cliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const prefixes = [...ENV_PREFIXES];
  if (source.CLAUDE_CODE_USE_BEDROCK) prefixes.push(...BEDROCK_PREFIXES);
  if (source.CLAUDE_CODE_USE_VERTEX) prefixes.push(...VERTEX_PREFIXES);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (value === undefined || ENV_DROPPED.has(upper)) continue;
    if (ENV_ALLOWLIST.has(upper) || prefixes.some((prefix) => upper.startsWith(prefix))) env[name] = value;
  }

  const parts = [source.PATH || source.Path || '', cachedShellPath || '', fallbackDirs().join(delimiter)];
  if (cachedBinary) parts.push(dirname(cachedBinary));
  const seen = new Set<string>();
  env.PATH = parts
    .flatMap((p) => p.split(delimiter))
    .filter((d) => d && !seen.has(d) && seen.add(d))
    .join(delimiter);
  return env;
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run the CLI with `args`, feeding `input` on stdin and streaming stdout lines
 * to `onLine` as they arrive. Always resolves (never rejects) with the captured
 * output and exit code so callers can build a clear error from it. Runs in its
 * own private temp dir, removed afterwards, so no project `CLAUDE.md` or files
 * leak into the prompt and no other local user can plant settings there.
 */
function runClaude(
  binary: string,
  args: string[],
  opts: {
    input?: string;
    timeoutMs: number;
    onLine?: (line: string) => void;
    /** The environment instead of {@link cliEnv}'s. */
    env?: NodeJS.ProcessEnv;
    /** Kills the CLI when it aborts. */
    signal?: AbortSignal;
  },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const cwd = mkdtempSync(join(tmpdir(), 'piwi-claude-'));
    const removeCwd = () => {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // A Windows handle still closing; the OS temp cleanup takes it.
      }
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      const command = cliCommand(binary, args);
      child = spawn(command.command, command.args, {
        cwd,
        env: opts.env ?? cliEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      removeCwd();
      resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      removeCwd();
      if (lineBuffer && opts.onLine) opts.onLine(lineBuffer);
      resolve({ code, stdout, stderr, timedOut });
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!opts.onLine) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) opts.onLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      stderr += `\n${err instanceof Error ? err.message : String(err)}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));

    if (opts.input != null) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

// ── Status / auth detection ────────────────────────────────────────────────

let cachedStatus: { at: number; value: ClaudeCliStatus } | null = null;

interface AuthStatusJson {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
}

/** Health + auth of the local CLI, for the settings UI. Probes are token-free (no model call). */
export async function getClaudeCliStatus(opts: { force?: boolean } = {}): Promise<ClaudeCliStatus> {
  const now = Date.now();
  if (!opts.force && cachedStatus && now - cachedStatus.at < STATUS_CACHE_MS) {
    // Refresh the live usage tally on the cached snapshot — it moves between probes.
    return { ...cachedStatus.value, usage: getUsageTotals() };
  }

  const status = await probeClaudeCli();
  cachedStatus = { at: now, value: status };
  return status;
}

async function probeClaudeCli(): Promise<ClaudeCliStatus> {
  const desktop = isDesktopRuntime();
  const base: ClaudeCliStatus = {
    desktop,
    available: false,
    binaryPath: null,
    version: null,
    loggedIn: false,
    authMethod: null,
    apiProvider: null,
    error: null,
    usage: getUsageTotals(),
  };

  if (!claudeCliEnabled()) {
    return { ...base, error: 'The local Claude CLI is only available in the Piwi desktop app.' };
  }

  const binary = await resolveClaudeBinaryDeep();
  if (!binary) {
    const override = process.env.PIWI_CLAUDE_CLI_PATH?.trim();
    return {
      ...base,
      error: override
        ? `PIWI_CLAUDE_CLI_PATH is set to "${override}" but no file is there. Point it at the \`claude\` binary.`
        : 'The `claude` command was not found. Install Claude Code (or set PIWI_CLAUDE_CLI_PATH to its path), then re-check.',
    };
  }
  base.binaryPath = binary;

  const versionRes = await runClaude(binary, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (versionRes.code !== 0) {
    return {
      ...base,
      error: versionRes.timedOut ? 'The `claude` command timed out.' : cleanErr(versionRes.stderr || versionRes.stdout),
    };
  }
  base.available = true;
  base.version = versionRes.stdout.trim().split(/\s+/)[0] || null;

  const authRes = await runClaude(binary, ['auth', 'status', '--json'], { timeoutMs: PROBE_TIMEOUT_MS });
  const auth = parseJsonObject<AuthStatusJson>(authRes.stdout);
  if (auth) {
    base.loggedIn = Boolean(auth.loggedIn);
    base.authMethod = auth.authMethod ?? null;
    base.apiProvider = auth.apiProvider ?? null;
  }
  if (!base.loggedIn) {
    base.error = 'Claude Code is installed but not signed in. Sign in to use it for AI features.';
  }
  return base;
}

function cleanErr(raw: string): string {
  return raw.trim().split('\n').slice(0, 3).join(' ').slice(0, 300) || 'Unknown error';
}

// ── Usage tally (in-memory, resets on restart) ─────────────────────────────

const usageTotals: ClaudeCliUsageTotals = {
  calls: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  since: null,
};

export function getUsageTotals(): ClaudeCliUsageTotals {
  return { ...usageTotals };
}

function recordUsage(result: ClaudeCallOutcome): void {
  usageTotals.calls += 1;
  usageTotals.costUsd += result.costUsd ?? 0;
  usageTotals.inputTokens += result.inputTokens ?? 0;
  usageTotals.outputTokens += result.outputTokens ?? 0;
  usageTotals.cacheReadInputTokens += result.cacheReadInputTokens ?? 0;
  usageTotals.since ??= new Date().toISOString();
}

// ── Generation ─────────────────────────────────────────────────────────────

/** Shape of the `--output-format json` result object (fields we read). */
interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

interface ClaudeCallOutcome extends AiCallResult {
  costUsd: number | null;
}

// Generation runs with every tool turned off (`--tools ""`), no MCP server
// (`--strict-mcp-config`) and one turn (`--max-turns 1`), so text in a prompt
// (a test's error message) cannot make the CLI run a command or fetch a page.
// `--tools` and `--strict-mcp-config` are read from `claude --help`, cached once
// the probe succeeds; `--max-turns` is a print-mode option `--help` does not
// list, which every CLI with `--tools` accepts. `--restricted` is added when the
// CLI has it. A CLI without the required flags is refused.
export interface CliHelp {
  /** The options `--help` lists. */
  flags: Set<string>;
  /** The whole text, for the values an option takes. */
  text: string;
}

let cliHelp: CliHelp | undefined;

const REQUIRED_FLAGS = ['--tools', '--strict-mcp-config'];

async function getCliHelp(binary: string): Promise<CliHelp> {
  if (cliHelp) return cliHelp;
  const res = await runClaude(binary, ['--help'], { timeoutMs: PROBE_TIMEOUT_MS });
  const flags = new Set<string>();
  for (const match of res.stdout.matchAll(/--[a-zA-Z][a-zA-Z0-9-]+/g)) flags.add(match[0]);
  if (res.code !== 0 || flags.size === 0) {
    throw new Error(
      `Could not read the options of the Claude CLI (\`claude --help\`: ${
        res.timedOut ? 'timed out' : cleanErr(res.stderr || res.stdout)
      }), so it cannot be run with its tools turned off.`,
    );
  }
  cliHelp = { flags, text: res.stdout };
  return cliHelp;
}

/**
 * CLI args for a generation. The system prompt fully replaces Claude Code's
 * default (so the model behaves like the API providers' plain assistant); the
 * temp cwd keeps project files out of context; the JSON schema is inlined into
 * the system prompt (as the OpenAI path does) since the CLI has no
 * structured-output flag. Tools, MCP servers and extra turns are always off;
 * streaming flags are added only when the installed CLI advertises them.
 */
async function buildArgs(
  binary: string,
  config: ResolvedAiRole,
  opts: AiCallOptions,
  stream: boolean,
): Promise<string[]> {
  const { flags } = await getCliHelp(binary);
  const has = (flag: string) => flags.has(flag);
  const missing = REQUIRED_FLAGS.filter((flag) => !has(flag));
  if (missing.length > 0) {
    throw new Error(
      `This Claude Code version cannot run with its tools turned off (no ${missing.join(' or ')} option). Update Claude Code (\`claude update\`) to use it for AI features.`,
    );
  }

  const system = opts.jsonSchema
    ? `${opts.system}\n\nRespond ONLY with a JSON object matching this schema, with no prose and no markdown fences:\n${JSON.stringify(opts.jsonSchema)}`
    : opts.system;

  const args = ['-p', '--output-format', stream ? 'stream-json' : 'json'];
  if (stream) {
    // Partial messages give token-by-token deltas; a CLI without the flag still
    // emits the final result line, which the stream parser falls back to.
    if (has('--verbose')) args.push('--verbose');
    if (has('--include-partial-messages')) args.push('--include-partial-messages');
  }
  args.push('--system-prompt', system);
  if (config.model) args.push('--model', config.model);
  args.push('--tools', '', '--strict-mcp-config', '--max-turns', '1');
  if (has('--restricted')) args.push('--restricted');
  return args;
}

/** Map the CLI usage block onto Piwi's token fields and the model name from `modelUsage`. */
function outcomeFromJson(json: ClaudeJsonResult, fallbackModel: string): ClaudeCallOutcome {
  const modelName = json.modelUsage ? Object.keys(json.modelUsage)[0] : undefined;
  const u = json.usage;
  // Claude Code caches its system prompt and tool definitions, so `input_tokens`
  // is only the uncached delta. Input tokens are the full prompt size: the sum
  // of the plain, cache-write and cache-read counts. Cost comes from
  // total_cost_usd, which the CLI prices across the cache tiers.
  const inputTokens =
    u == null ? null : (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return {
    text: json.result ?? '',
    model: modelName || fallbackModel || 'claude',
    inputTokens,
    outputTokens: u?.output_tokens ?? null,
    cacheCreationInputTokens: u?.cache_creation_input_tokens ?? null,
    cacheReadInputTokens: u?.cache_read_input_tokens ?? null,
    costUsd: json.total_cost_usd ?? null,
  };
}

/** Throw a clear, user-actionable error when the CLI can't run or isn't signed in. */
async function assertReady(): Promise<string> {
  const status = await getClaudeCliStatus();
  if (!status.available) {
    throw new Error(status.error || 'The local Claude CLI is unavailable.');
  }
  if (!status.loggedIn) {
    throw new Error('Claude Code is not signed in. Open Settings → AI to sign in.');
  }
  return status.binaryPath!;
}

/** Non-streaming generation. */
export async function callClaudeCli(config: ResolvedAiRole, opts: AiCallOptions): Promise<AiCallResult> {
  const binary = await assertReady();
  const args = await buildArgs(binary, config, opts, false);

  const res = await runClaude(binary, args, { input: opts.user, timeoutMs: GENERATION_TIMEOUT_MS });
  if (res.timedOut) throw new Error('The Claude CLI timed out.');

  const json = parseJsonObject<ClaudeJsonResult>(res.stdout);
  if (!json) {
    throw new Error(cleanErr(res.stderr || res.stdout) || `Claude CLI exited with code ${res.code}`);
  }
  if (json.is_error || json.subtype === 'error_during_execution') {
    throw new Error(json.result?.slice(0, 500) || `Claude CLI reported an error (${json.subtype ?? 'unknown'})`);
  }

  const outcome = outcomeFromJson(json, config.model);
  recordUsage(outcome);
  return outcome;
}

/** One model message as a `stream-json` line carries it: its id, its model and its usage so far. */
interface StreamJsonMessage {
  id?: string;
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: ClaudeJsonResult['usage'];
}

/** Shape of one `--output-format stream-json` line we care about. */
interface StreamJsonLine {
  type?: string;
  subtype?: string;
  /** A partial message's event: `message_start` carries the message, `message_delta` its usage as it grows. */
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
    message?: StreamJsonMessage;
    usage?: ClaudeJsonResult['usage'];
  };
  /** An `assistant` line's message, whole. */
  message?: StreamJsonMessage;
  /** The `system` `init` line's MCP servers and how their connection went. */
  mcp_servers?: Array<{ name?: string; status?: string }>;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: ClaudeJsonResult['usage'];
  modelUsage?: Record<string, unknown>;
}

/**
 * Streaming generation. Parses the NDJSON `stream-json` output, yielding text
 * deltas as they arrive and a final `done` chunk with token usage. If the CLI
 * build emits no partial deltas, the final `result` text is yielded once so the
 * caller still receives the full answer.
 */
export async function* streamClaudeCli(config: ResolvedAiRole, opts: AiCallOptions): AsyncGenerator<StreamChunk> {
  const binary = await assertReady();
  const args = await buildArgs(binary, config, opts, true);

  const queue: StreamChunk[] = [];
  let final: StreamJsonLine | null = null;
  let emittedText = false;

  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const obj = safeParse<StreamJsonLine>(trimmed);
    if (!obj) return;
    if (
      obj.type === 'stream_event' &&
      obj.event?.type === 'content_block_delta' &&
      obj.event.delta?.type === 'text_delta'
    ) {
      const text = obj.event.delta.text ?? '';
      if (text) {
        emittedText = true;
        queue.push({ type: 'text', data: text });
      }
    } else if (obj.type === 'result') {
      final = obj;
    }
  };

  const done = runClaude(binary, args, { input: opts.user, timeoutMs: GENERATION_TIMEOUT_MS, onLine });

  // Drain deltas as the process runs; poll the queue between microtasks.
  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    const settled = await Promise.race([done.then(() => true), tick().then(() => false)]);
    if (queue.length > 0) continue;
    if (settled) break;
  }

  const res = await done;
  if (res.timedOut) {
    yield { type: 'error', data: 'The Claude CLI timed out.' };
    return;
  }

  const result = final as StreamJsonLine | null;
  if (!result) {
    yield { type: 'error', data: cleanErr(res.stderr || res.stdout) || `Claude CLI exited with code ${res.code}` };
    return;
  }
  if (result.is_error) {
    yield { type: 'error', data: result.result?.slice(0, 500) || 'Claude CLI reported an error' };
    return;
  }
  if (!emittedText && result.result) {
    yield { type: 'text', data: result.result };
  }

  const outcome = outcomeFromJson(result, config.model);
  recordUsage(outcome);
  yield {
    type: 'done',
    data: {
      model: outcome.model,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      cacheCreationInputTokens: outcome.cacheCreationInputTokens,
      cacheReadInputTokens: outcome.cacheReadInputTokens,
      costUsd: outcome.costUsd,
    },
  };
}

// ── Assistant turns ────────────────────────────────────────────────────────

/** The one MCP server an assistant turn's run is given: the turn's own tools. */
export const CLAUDE_CLI_MCP_SERVER = 'piwi';

/** A tool of that server as Claude Code names it, the form `--allowedTools` takes. */
export function claudeCliToolName(name: string): string {
  return `mcp__${CLAUDE_CLI_MCP_SERVER}__${name}`;
}

/** The options an assistant turn's run needs besides {@link REQUIRED_FLAGS}. */
const AGENT_FLAGS = ['--mcp-config'];

/** How the CLI spells its allowed-tools option, or null when it has none. */
function allowedToolsFlag(flags: Set<string>): string | null {
  if (flags.has('--allowedTools')) return '--allowedTools';
  return flags.has('--allowed-tools') ? '--allowed-tools' : null;
}

function runsAgents(help: CliHelp): boolean {
  return [...REQUIRED_FLAGS, ...AGENT_FLAGS].every((flag) => help.flags.has(flag)) && !!allowedToolsFlag(help.flags);
}

/**
 * Whether the installed CLI can run a whole assistant turn itself, with the
 * turn's tools attached as its MCP server; false when it is off here, missing
 * or its options cannot be read.
 */
export async function claudeCliRunsAgents(): Promise<boolean> {
  if (!claudeCliEnabled()) return false;
  try {
    const binary = await resolveClaudeBinaryDeep();
    return !!binary && runsAgents(await getCliHelp(binary));
  } catch {
    return false;
  }
}

export interface ClaudeCliAgentRun {
  system: string;
  /** The question, after the conversation so far. */
  prompt: string;
  /** The turn's MCP endpoint and the token it takes. */
  server: { url: string; token: string };
  /** The tools of that server the run may call, by their own names. */
  tools: readonly string[];
  maxTurns: number;
  timeoutMs: number;
  /** Each piece of the answer's text, as it is written. */
  onText: (text: string) => void;
}

export interface ClaudeCliAgentResult extends ClaudeCallOutcome {
  /** How the run ended: answered, out of turns, out of time, or failed with `error`. */
  outcome: 'answered' | 'max-turns' | 'timeout' | 'failed';
  error: string | null;
}

/** The `--mcp-config` of a run: the turn's endpoint as the one server, with its token. */
export function agentMcpConfig(server: ClaudeCliAgentRun['server']): string {
  return JSON.stringify({
    mcpServers: {
      [CLAUDE_CLI_MCP_SERVER]: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } },
    },
  });
}

/**
 * CLI args for an assistant turn. The system prompt replaces Claude Code's;
 * every built-in tool is off (`--tools ""`); the turn's endpoint is the one
 * MCP server (`--strict-mcp-config --mcp-config <file>`, a file so its token
 * stays out of the process list) and its tools the only ones allowed
 * (`--allowedTools`, with `--permission-mode dontAsk` refusing the rest when
 * the CLI has it); `--max-turns` bounds the model turns; the output is
 * `stream-json`, with partial messages when the CLI has them; and the session
 * is not kept on disk when the CLI can say so.
 */
export function buildAgentArgs(
  help: CliHelp,
  config: ResolvedAiRole,
  run: Pick<ClaudeCliAgentRun, 'system' | 'tools' | 'maxTurns'>,
  mcpConfigPath: string,
): string[] {
  const has = (flag: string) => help.flags.has(flag);
  const allowed = allowedToolsFlag(help.flags);
  if (!runsAgents(help) || !allowed) {
    throw new Error(
      'This Claude Code version cannot run the assistant with only its tools attached. Update Claude Code (`claude update`).',
    );
  }
  const args = ['-p', '--output-format', 'stream-json'];
  if (has('--verbose')) args.push('--verbose');
  if (has('--include-partial-messages')) args.push('--include-partial-messages');
  args.push('--system-prompt', run.system);
  if (config.model) args.push('--model', config.model);
  args.push('--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfigPath);
  args.push(allowed, run.tools.map(claudeCliToolName).join(','));
  if (has('--permission-mode') && help.text.includes('dontAsk')) args.push('--permission-mode', 'dontAsk');
  args.push('--max-turns', String(run.maxTurns));
  if (has('--no-session-persistence')) args.push('--no-session-persistence');
  if (has('--restricted')) args.push('--restricted');
  return args;
}

/** `env` with the loopback hosts in `NO_PROXY`, so a proxy the CLI is set to never carries its calls to this server. */
export function withLoopbackNoProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const hosts = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  const value = [...new Set([...hosts, '127.0.0.1', 'localhost', '::1'])].join(',');
  return { ...env, NO_PROXY: value, no_proxy: value };
}

/** MCP server states of the `init` line that mean the run has no tools. */
const UNREACHABLE_SERVER = new Set(['failed', 'needs-auth']);

type TokenCounts = Required<NonNullable<ClaudeJsonResult['usage']>>;

/**
 * The tokens a run's messages reported as they streamed, which is what it
 * spent when it ends without its `result` line (killed past its time limit).
 * A message is reported more than once as it grows (its `message_start` and
 * `message_delta` events, an `assistant` line per content block), so each
 * count is the highest one a message reported, summed over the messages.
 */
function createStreamUsage() {
  const messages = new Map<string, TokenCounts>();
  let current: string | null = null;
  let model = '';
  const note = (id: string | null | undefined, usage: ClaudeJsonResult['usage']) => {
    if (!id || !usage) return;
    const seen = messages.get(id) ?? {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    for (const key of Object.keys(seen) as Array<keyof TokenCounts>) seen[key] = Math.max(seen[key], usage[key] ?? 0);
    messages.set(id, seen);
  };
  const noteMessage = (message: StreamJsonMessage | undefined) => {
    if (message?.model) model = message.model;
    note(message?.id, message?.usage);
  };
  return {
    read(obj: StreamJsonLine) {
      if (obj.type === 'assistant') noteMessage(obj.message);
      else if (obj.type === 'stream_event' && obj.event?.type === 'message_start') {
        current = obj.event.message?.id ?? null;
        noteMessage(obj.event.message);
      } else if (obj.type === 'stream_event' && obj.event?.type === 'message_delta') note(current, obj.event.usage);
    },
    /** What the messages spent, or null when none reported its usage. */
    outcome(fallbackModel: string): ClaudeCallOutcome | null {
      if (messages.size === 0) return null;
      const total = (key: keyof TokenCounts) => [...messages.values()].reduce((n, counts) => n + counts[key], 0);
      const cacheCreationInputTokens = total('cache_creation_input_tokens');
      const cacheReadInputTokens = total('cache_read_input_tokens');
      return {
        text: '',
        model: model || fallbackModel || 'claude',
        inputTokens: total('input_tokens') + cacheCreationInputTokens + cacheReadInputTokens,
        outputTokens: total('output_tokens'),
        cacheCreationInputTokens,
        cacheReadInputTokens,
        costUsd: null,
      };
    },
  };
}

/**
 * Run one assistant turn in the CLI: it calls the model and the turn's tools
 * itself, until it answers or `maxTurns` or `timeoutMs` stops it. The answer's
 * text streams to `onText` (token by token with partial messages, else each
 * message whole); the result carries the model, the tokens and the cost the
 * CLI reported, and a run killed before its result line the model and the
 * tokens its messages reported. A run whose MCP server did not connect is
 * stopped at once.
 */
export async function runClaudeCliAgent(config: ResolvedAiRole, run: ClaudeCliAgentRun): Promise<ClaudeCliAgentResult> {
  const binary = await assertReady();
  const help = await getCliHelp(binary);
  const dir = mkdtempSync(join(tmpdir(), 'piwi-claude-mcp-'));
  try {
    const configPath = join(dir, 'mcp.json');
    writeFileSync(configPath, agentMcpConfig(run.server), { mode: 0o600 });
    const args = buildAgentArgs(help, config, run, configPath);

    const stop = new AbortController();
    let final: StreamJsonLine | null = null;
    let failure: string | null = null;
    let wrote = false;
    let deltaSinceMessage = false;
    const streamed = createStreamUsage();
    const write = (text: string | undefined) => {
      if (!text) return;
      wrote = true;
      run.onText(text);
    };
    const onLine = (line: string) => {
      const obj = safeParse<StreamJsonLine>(line.trim());
      if (!obj) return;
      streamed.read(obj);
      if (
        obj.type === 'stream_event' &&
        obj.event?.type === 'content_block_delta' &&
        obj.event.delta?.type === 'text_delta'
      ) {
        deltaSinceMessage = true;
        write(obj.event.delta.text);
      } else if (obj.type === 'assistant') {
        // Without partial messages, a message's text arrives here whole.
        if (!deltaSinceMessage)
          for (const block of obj.message?.content ?? []) if (block.type === 'text') write(block.text);
        deltaSinceMessage = false;
      } else if (obj.type === 'system' && obj.subtype === 'init' && Array.isArray(obj.mcp_servers)) {
        const server = obj.mcp_servers.find((s) => s.name === CLAUDE_CLI_MCP_SERVER);
        if (!server || UNREACHABLE_SERVER.has(server.status ?? '')) {
          failure = `Claude Code could not reach this server's assistant tools (${server?.status ?? 'not loaded'}).`;
          stop.abort();
        }
      } else if (obj.type === 'result') {
        final = obj;
      }
    };

    const res = await runClaude(binary, args, {
      input: run.prompt,
      timeoutMs: run.timeoutMs,
      onLine,
      env: withLoopbackNoProxy(cliEnv()),
      signal: stop.signal,
    });

    const result = final as StreamJsonLine | null;
    // The `result` line's totals and cost when the run wrote one, else what its messages reported.
    const spent = result ? outcomeFromJson(result, config.model) : streamed.outcome(config.model);
    const usage: ClaudeCallOutcome = spent ?? {
      text: '',
      model: '',
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      costUsd: null,
    };
    if (spent) recordUsage(usage);
    const ended = (outcome: ClaudeCliAgentResult['outcome'], error: string | null = null): ClaudeCliAgentResult => ({
      ...usage,
      outcome,
      error,
    });
    if (failure) return ended('failed', failure);
    if (res.timedOut) return ended('timeout', 'The Claude CLI timed out.');
    if (!result)
      return ended('failed', cleanErr(res.stderr || res.stdout) || `Claude CLI exited with code ${res.code}`);
    if (result.subtype === 'error_max_turns') return ended('max-turns');
    if (result.is_error || result.subtype?.startsWith('error')) {
      return ended('failed', result.result?.slice(0, 500) || `Claude CLI reported an error (${result.subtype})`);
    }
    if (!wrote) write(result.result);
    return ended('answered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Interactive auth (desktop only) ────────────────────────────────────────

/**
 * Run `claude auth login`, streaming the CLI's progress lines to `onLine` (the
 * URL it prints, and status). The CLI opens the browser and runs its own
 * loopback callback; this resolves when the user completes it (or it times out).
 */
export async function runClaudeLogin(
  onLine: (line: string) => void,
): Promise<{ success: boolean; error: string | null }> {
  const binary = await resolveClaudeBinaryDeep();
  if (!binary) return { success: false, error: 'The `claude` command was not found.' };

  const res = await runClaude(binary, ['auth', 'login', '--claudeai'], {
    timeoutMs: LOGIN_TIMEOUT_MS,
    onLine: (line) => {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    },
  });
  cachedStatus = null; // force a fresh status probe after a login attempt
  if (res.timedOut) return { success: false, error: 'Sign-in timed out. Try again.' };
  if (res.code !== 0) return { success: false, error: cleanErr(res.stderr || res.stdout) };
  return { success: true, error: null };
}

/** Sign the CLI out (`claude auth logout`). */
export async function runClaudeLogout(): Promise<{ success: boolean; error: string | null }> {
  const binary = await resolveClaudeBinaryDeep();
  if (!binary) return { success: false, error: 'The `claude` command was not found.' };
  const res = await runClaude(binary, ['auth', 'logout'], { timeoutMs: PROBE_TIMEOUT_MS });
  cachedStatus = null;
  if (res.code !== 0) return { success: false, error: cleanErr(res.stderr || res.stdout) };
  return { success: true, error: null };
}

// ── small helpers ──────────────────────────────────────────────────────────

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Parse a JSON object from CLI stdout: whole-string first, else the last object-looking line. */
function parseJsonObject<T>(stdout: string): T | null {
  const whole = safeParse<T>(stdout.trim());
  if (whole && typeof whole === 'object') return whole;
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line && line.startsWith('{') && line.endsWith('}')) {
      const obj = safeParse<T>(line);
      if (obj) return obj;
    }
  }
  return null;
}
