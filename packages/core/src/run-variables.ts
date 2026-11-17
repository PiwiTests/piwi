/**
 * Run variables: the environment variables a project sets on every run Piwi starts for its tests, and at the start of
 * every command Piwi gives to copy for them (`TENANT=acme npx playwright test`). A project's managers set them on the
 * project; the instance checks them when they are saved, and every target (the editor service, the desktop app) checks
 * them again with the same rules before it runs anything.
 *
 * A run variable is a plain value, never a secret: the commands, the desktop app and a target's confirmation show it.
 * Its name never sets a variable that changes which code runs, which browser starts, which certificates are trusted,
 * or where results and requests go ({@link isRefusedRunVariableName}). Every process gets them as its environment,
 * never through a shell line; the copied commands quote each value ({@link withRunVariables}).
 */
import { HIDDEN_CHARACTER } from './run-request';

/** One run variable: a name and the exact value the process gets. */
export interface RunVariable {
  name: string;
  value: string;
}

/** The bounds of a project's run variables. */
export const RUN_VARIABLE_LIMITS = {
  /** Run variables per project. */
  count: 10,
  /** Characters of a name. */
  nameChars: 64,
  /** Characters of a value. */
  valueChars: 500,
} as const;

/** A name: capital letters, digits and `_`, starting with a letter or `_`. */
const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/**
 * The names a run variable never sets. They pick the code a process loads or the shell it runs (`PATH`,
 * `NODE_OPTIONS`, `BASH_ENV`), the folders programs read their settings from (`HOME`, `APPDATA`), the proxy a request
 * goes through, or the display a browser shows on.
 */
export const REFUSED_RUN_VARIABLE_NAMES: readonly string[] = [
  'APPDATA',
  'ALL_PROXY',
  'BASHOPTS',
  'BROWSER',
  'CDPATH',
  'CLASSPATH',
  'COMSPEC',
  'DISPLAY',
  'EDITOR',
  'ENV',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'IFS',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'LESSCLOSE',
  'LESSOPEN',
  'LOCALAPPDATA',
  'NO_PROXY',
  'PAGER',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROMPT_COMMAND',
  'PS4',
  'PWDEBUG',
  'SHELL',
  'SHELLOPTS',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'VISUAL',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XAUTHORITY',
  'ZDOTDIR',
  '_JAVA_OPTIONS',
];

/**
 * The prefixes of the names a run variable never sets: the variables of a runtime, a package manager or a tool Piwi
 * starts (Node, npm, git, Playwright, Piwi itself), of the dynamic linker, and of TLS trust.
 */
export const REFUSED_RUN_VARIABLE_PREFIXES: readonly string[] = [
  'BASH_',
  'BUN_',
  'COREPACK_',
  'CORECLR_',
  'COR_',
  'DOTNET_',
  'DYLD_',
  'ELECTRON_',
  'GIT_',
  'LD_',
  'NODE_',
  'NPM_',
  'PERL',
  'PIWI_',
  'PLAYWRIGHT_',
  'PNPM_',
  'PW_',
  'PYTHON',
  'RUBY',
  'SSH_',
  'SSL_',
  'XDG_',
  'YARN_',
];

/** Whether a name is one a run variable never sets, whatever its case: Windows reads names without it. */
export function isRefusedRunVariableName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    REFUSED_RUN_VARIABLE_NAMES.includes(upper) ||
    REFUSED_RUN_VARIABLE_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/** Why a name cannot be a run variable's, or null when it can. */
export function runVariableNameProblem(name: string): string | null {
  if (!NAME.test(name)) {
    return `${JSON.stringify(name.slice(0, RUN_VARIABLE_LIMITS.nameChars))} is not a variable name: capital letters, digits and _, starting with a letter or _, ${RUN_VARIABLE_LIMITS.nameChars} characters at most.`;
  }
  if (isRefusedRunVariableName(name)) {
    return `${name} is not a variable a project can set: it changes which code runs, which browser starts or where results go.`;
  }
  return null;
}

/** Why a value cannot be a run variable's, or null when it can: at most 500 characters, with no hidden character. */
export function runVariableValueProblem(name: string, value: string): string | null {
  if (value.length > RUN_VARIABLE_LIMITS.valueChars) {
    return `The value of ${name} is longer than ${RUN_VARIABLE_LIMITS.valueChars} characters.`;
  }
  if (HIDDEN_CHARACTER.test(value)) {
    return `The value of ${name} holds a line break, a control or an invisible character.`;
  }
  return null;
}

export type RunVariablesParse = { ok: true; value: RunVariable[] } | { ok: false; problems: string[] };

/**
 * Reads a project's run variables: a list of `{ name, value }` objects with no other field, at most 10, each name once,
 * each name and value passing {@link runVariableNameProblem} and {@link runVariableValueProblem}. `undefined` and
 * `null` read as none. Any problem refuses the whole list: a target never runs with part of a project's variables.
 */
export function parseRunVariables(value: unknown): RunVariablesParse {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, problems: ['The run variables must be a list.'] };
  if (value.length > RUN_VARIABLE_LIMITS.count) {
    return { ok: false, problems: [`A project has at most ${RUN_VARIABLE_LIMITS.count} run variables.`] };
  }
  const problems: string[] = [];
  const variables: RunVariable[] = [];
  const seen = new Set<string>();
  value.forEach((item: unknown, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`Run variable ${index + 1} must be an object with a name and a value.`);
      return;
    }
    const record = item as Record<string, unknown>;
    const extra = Object.keys(record).filter((key) => key !== 'name' && key !== 'value');
    if (extra.length > 0)
      problems.push(`Run variable ${index + 1} has fields a run variable does not have: ${extra.join(', ')}.`);
    const { name, value: text } = record;
    if (typeof name !== 'string' || typeof text !== 'string') {
      problems.push(`Run variable ${index + 1} must have a text name and a text value.`);
      return;
    }
    const problem = runVariableNameProblem(name) ?? runVariableValueProblem(name, text);
    if (problem) problems.push(problem);
    else if (seen.has(name)) problems.push(`${name} is set twice.`);
    seen.add(name);
    variables.push({ name, value: text });
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: variables };
}

/** The shells a copied command is written for. */
export type RunVariableShell = 'bash' | 'powershell';

/** Characters a POSIX shell keeps as they are outside quotes. */
const BASH_PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A value as one POSIX shell word: bare when it holds only plain characters, else single-quoted. */
export function bashQuote(value: string): string {
  if (BASH_PLAIN.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A value as one PowerShell single-quoted string. PowerShell reads `‘ ’ ‚ ‛` as `'` too, so each of them is doubled
 * like `'`.
 */
export function powerShellQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, '$&$&')}'`;
}

/**
 * The variables as `NAME=value` words, each value quoted for `shell`: `TENANT=acme REGION='eu west'` in bash, and
 * `TENANT='acme' REGION='eu west'` in PowerShell, where a word and the quoted text after it make one argument. What
 * `env` takes before a command (`git bisect run env TENANT=acme npx playwright test`).
 */
export function runVariableAssignments(variables: readonly RunVariable[], shell: RunVariableShell): string {
  const quote = shell === 'bash' ? bashQuote : powerShellQuote;
  return variables.map((variable) => `${variable.name}=${quote(variable.value)}`).join(' ');
}

/**
 * A command that runs `command` with the run variables set: `TENANT=acme npx playwright test` in bash, and
 * `$env:TENANT='acme'; npx playwright test` in PowerShell, where the variables stay set for the rest of the session.
 * Returns `command` unchanged when there is no variable.
 */
export function withRunVariables(command: string, variables: readonly RunVariable[], shell: RunVariableShell): string {
  if (variables.length === 0) return command;
  if (shell === 'bash') return `${runVariableAssignments(variables, 'bash')} ${command}`;
  return `${variables.map((variable) => `$env:${variable.name}=${powerShellQuote(variable.value)};`).join(' ')} ${command}`;
}
