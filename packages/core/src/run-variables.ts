/**
 * Run variables: the environment variables a project sets on every run Piwi starts for its tests, and at the start of
 * every command Piwi gives to copy for them (`TENANT=acme npx playwright test`). A project's managers set them on the
 * project; the instance checks them when they are saved, and every target (the editor service, the desktop app) checks
 * them again with the same rules before it runs anything.
 *
 * A run variable is a plain value, never a secret: the commands, the desktop app, a target's confirmation and an
 * editor's question show it before it applies. Its value is plain text ({@link runVariableValueProblem}), and its name
 * never sets a variable that changes which code runs, which browser starts, which certificates are trusted, where
 * results and requests go or the CI a run reports ({@link isRefusedRunVariableName}). Every process gets them as its
 * environment, never through a shell line; the copied commands quote each value ({@link withRunVariables}).
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
 * The names a run variable never sets. They pick the code a process loads or the shell it runs (`PATH`, `PATHEXT`),
 * what a shell runs as it starts (`STTY` in zsh, `PS4`) or keeps to itself (`UID`, `_`), the folders programs read
 * their settings from (`HOME`, `APPDATA`), how a host name resolves and the proxy a request goes through, the display a
 * browser shows on, the colors Piwi sets on a run's output, or the CI a run reports it ran in (`CI`, `JENKINS_URL`,
 * `BUILD_NUMBER`), which the reporter reads.
 */
export const REFUSED_RUN_VARIABLE_NAMES: readonly string[] = [
  'AGENT_JOBNAME',
  'ALL_PROXY',
  'APPDATA',
  'AUTO_PROXY',
  'BASHOPTS',
  'BROWSER',
  'BUILD_BUILDID',
  'BUILD_BUILDNUMBER',
  'BUILD_ID',
  'BUILD_NUMBER',
  'BUILD_URL',
  'CDPATH',
  'CHANGE_ID',
  'CHANGE_TARGET',
  'CI',
  'CIRCLECI',
  'CLASSPATH',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMW6432',
  'COMSPEC',
  'DEBUG_FILE',
  'DESTDIR',
  'DISPLAY',
  'EDITOR',
  'EGID',
  'EUID',
  'FORCE_COLOR',
  'GCONV_PATH',
  'GID',
  'GLIBC_TUNABLES',
  'GRADLE_OPTS',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOSTALIASES',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'IFS',
  'JAVA_OPTS',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'JENKINS_URL',
  'JOB_NAME',
  'LESSCLOSE',
  'LESSOPEN',
  'LOCALAPPDATA',
  'LOCALDOMAIN',
  'LOCPATH',
  'MAVEN_OPTS',
  'NLSPATH',
  'NO_COLOR',
  'NO_PROXY',
  'PAGER',
  'PATH',
  'PATHEXT',
  'PPID',
  'PREFIX',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMW6432',
  'PROMPT_COMMAND',
  'PS0',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'PSEXECUTIONPOLICYPREFERENCE',
  'PSMODULEPATH',
  'PWDEBUG',
  'RESOLV_HOST_CONF',
  'RES_OPTIONS',
  'RUSTC_WRAPPER',
  'SHELL',
  'SHELLOPTS',
  'SOCKS_SERVER',
  'SSLKEYLOGFILE',
  'STTY',
  'SYSTEMROOT',
  'SYSTEM_JOBID',
  'SYSTEM_PULLREQUEST_PULLREQUESTNUMBER',
  'SYSTEM_PULLREQUEST_TARGETBRANCH',
  'SYSTEM_TEAMFOUNDATIONSERVERURI',
  'SYSTEM_TEAMPROJECT',
  'TEMP',
  'TF_BUILD',
  'TMP',
  'TMPDIR',
  'UID',
  'USERNAME',
  'USERPROFILE',
  'VISUAL',
  'WAYLAND_DISPLAY',
  'WINDIR',
  'XAUTHORITY',
  'ZDOTDIR',
  '_',
  '_JAVA_OPTIONS',
];

/**
 * The prefixes of the names a run variable never sets: the variables of a runtime, a package manager or a tool Piwi
 * starts (Node, npm, git, Playwright, Piwi itself), of the dynamic linker and the libraries a browser loads (OpenSSL,
 * GTK, Vulkan, Mesa, D-Bus), of TLS trust, and of the CI services the reporter recognizes (`GITHUB_`, `CI_`).
 */
export const REFUSED_RUN_VARIABLE_PREFIXES: readonly string[] = [
  'APPVEYOR_',
  'BASH_',
  'BITBUCKET_',
  'BUILDKITE_',
  'BUN_',
  'CIRCLE_',
  'CI_',
  'CODEBUILD_',
  'COMPLUS_',
  'CORECLR_',
  'COREPACK_',
  'COR_',
  'DBUS_',
  'DOTNET_',
  'DRONE_',
  'DYLD_',
  'ELECTRON_',
  'ESBUILD_',
  'GIO_',
  'GITHUB_',
  'GITLAB_',
  'GIT_',
  'GST_',
  'GTK_',
  'LD_',
  'LIBGL_',
  'MESA_',
  'NAPI_RS_',
  'NODE_',
  'NPM_',
  'OPENSSL_',
  'PERL',
  'PIWI_',
  'PLAYWRIGHT_',
  'PNPM_',
  'PWTEST_',
  'PW_',
  'PYTHON',
  'QT_',
  'RUBY',
  'RUNNER_',
  'SEMAPHORE_',
  'SSH_',
  'SSL_',
  'TEAMCITY_',
  'TRAVIS',
  'VK_',
  'XDG_',
  'YARN_',
  '__',
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

/**
 * The characters a value is made of: letters, combining marks and digits of any script, spaces and `_ - . , : / @ + =`.
 * Enough for a tenant, a region, a brand or an address (`https://acme.example.com:8443/app`); nothing a shell, an
 * editor's task or a loader reads as more than text: no `$` (`${env:…}` in an editor's task), no `\\` (a Windows or
 * UNC path), no quote, backtick or shell operator.
 */
const PLAIN_VALUE = /^[\p{L}\p{M}\p{N} _.,:/@+=-]+$/u;

/**
 * Why a value cannot be a run variable's, or null when it can: 1 to 500 characters of {@link PLAIN_VALUE}, with no
 * space at either end, no hidden character, and not starting with `//`, which Windows reads as a share on another
 * machine. An empty value is refused too: Windows PowerShell removes a variable it sets to `''`.
 */
export function runVariableValueProblem(name: string, value: string): string | null {
  if (value === '') return `The value of ${name} is empty: remove the variable instead.`;
  if (value.length > RUN_VARIABLE_LIMITS.valueChars) {
    return `The value of ${name} is longer than ${RUN_VARIABLE_LIMITS.valueChars} characters.`;
  }
  if (HIDDEN_CHARACTER.test(value)) {
    return `The value of ${name} holds a line break, a control or an invisible character.`;
  }
  if (!PLAIN_VALUE.test(value) || value.trim() !== value || value.startsWith('//')) {
    return `The value of ${name} must be letters, digits, spaces and _ - . , : / @ + = only, not starting with // nor with a space at either end.`;
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
  // An index loop, not `forEach`: a hole of a sparse list is a missing variable, not none.
  for (let index = 0; index < value.length; index++) {
    const item: unknown = value[index];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`Run variable ${index + 1} must be an object with a name and a value.`);
      continue;
    }
    const record = item as Record<string, unknown>;
    const extra = Object.keys(record).filter((key) => key !== 'name' && key !== 'value');
    if (extra.length > 0) {
      const named = extra.slice(0, 3).map((key) => JSON.stringify(key.slice(0, 40)));
      problems.push(`Run variable ${index + 1} has fields a run variable does not have: ${named.join(', ')}.`);
    }
    const own = (key: string) => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);
    const name = own('name');
    const text = own('value');
    if (typeof name !== 'string' || typeof text !== 'string') {
      problems.push(`Run variable ${index + 1} must have a text name and a text value.`);
      continue;
    }
    const problem = runVariableNameProblem(name) ?? runVariableValueProblem(name, text);
    if (problem) problems.push(problem);
    else if (seen.has(name)) problems.push(`${name} is set twice.`);
    seen.add(name);
    variables.push({ name, value: text });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: variables };
}

/** The shells a copied command is written for. */
export type RunVariableShell = 'bash' | 'powershell';

/** Characters bash and zsh keep as they are outside quotes, `=` aside: zsh expands a word that starts with it. */
const BASH_PLAIN = /^[A-Za-z0-9_@+:,./-]+$/;

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
  return writable(variables)
    .map((variable) => `${variable.name}=${quote(variable.value)}`)
    .join(' ');
}

/**
 * The variables a command may be written with: those whose name and value pass the checks. A stored name the rules
 * refuse since, or one typed and not checked yet, never reaches a command someone pastes.
 */
function writable(variables: readonly RunVariable[]): RunVariable[] {
  return variables.filter(
    (variable) =>
      runVariableNameProblem(variable.name) === null && runVariableValueProblem(variable.name, variable.value) === null,
  );
}

/**
 * A command that runs `command` with the run variables set: `TENANT=acme npx playwright test` in bash, and
 * `$env:TENANT='acme'; npx playwright test` in PowerShell, where the variables stay set for the rest of the session.
 * Returns `command` unchanged when there is no variable. A variable the checks refuse is left out.
 */
export function withRunVariables(command: string, variables: readonly RunVariable[], shell: RunVariableShell): string {
  const set = writable(variables);
  if (set.length === 0) return command;
  if (shell === 'bash') return `${runVariableAssignments(set, 'bash')} ${command}`;
  return `${set.map((variable) => `$env:${variable.name}=${powerShellQuote(variable.value)};`).join(' ')} ${command}`;
}
