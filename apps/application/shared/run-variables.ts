import {
  bashQuote,
  powerShellQuote,
  withRunVariables,
  type RunVariable,
  type RunVariableShell,
} from '@piwitests/core/run-variables';
import { ENVIRONMENT_VARIABLE, requiredTagsGrepInvert, type EnvironmentForRun } from '@piwitests/core/environments';

export type { RunVariable, RunVariableShell };

/**
 * A project's stored run variables (`projects.run_variables`), as the API returns them: every `{ name, value }` pair
 * of text, in their order, and an empty list for none. The save checked them with `parseRunVariables`; a reader that
 * applies them to a run checks them again, so a name refused since it was saved runs nothing.
 */
export function storedRunVariables(raw: unknown): RunVariable[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    const { name, value } = (item ?? {}) as { name?: unknown; value?: unknown };
    return typeof name === 'string' && typeof value === 'string' ? [{ name, value }] : [];
  });
}

/**
 * A command Piwi gives to copy, as `withRunVariables` writes it for `shell`. A command of several `&&`-joined commands
 * (one per Playwright project) sets the variables for each of them in bash, where `NAME=value a && b` sets it for `a`
 * alone. The arguments Piwi writes are bare or double-quoted with no `"` inside (`quoteShellArg`), so a `&&` between
 * two double quotes is part of an argument and stays as it is.
 */
export function commandWithRunVariables(
  command: string,
  variables: readonly RunVariable[],
  shell: RunVariableShell,
): string {
  if (variables.length === 0 || command.trim() === '') return command;
  if (shell === 'powershell') return withRunVariables(command, variables, shell);
  return splitAndCommands(command)
    .map((part) => withRunVariables(part, variables, shell))
    .join(' && ');
}

/**
 * Where a protected environment's filter goes in one command, or null for a command that cannot pass it to
 * Playwright: at the end of `npx playwright test …`, and among the Playwright arguments of `npx @piwitests/reporter
 * run …`, after its `--`.
 */
function withRequiredTagsFilter(command: string, filter: string): string | null {
  const trimmed = command.trim();
  if (/^npx playwright test(\s|$)/.test(trimmed)) return `${command}${filter}`;
  if (/^npx @piwitests\/reporter run(\s|$)/.test(trimmed)) {
    return / -- /.test(` ${trimmed} `) ? `${command}${filter}` : `${command} --${filter}`;
  }
  return null;
}

/**
 * A command Piwi gives to copy for a run of an environment: the run variables (the project's and the environment's,
 * merged by the instance) and `PIWI_ENVIRONMENT` set to its key, and for a protected environment a `--grep-invert` that
 * keeps the run to the tests carrying one of its required tags (`requiredTagsGrepInvert`). Each command of an `&&`
 * chain gets them, in either shell. With no environment, the command `commandWithRunVariables` writes. A protected
 * environment and a command that cannot take its filter (a Flake Lab command) give the command as it is, with none of
 * the environment's variables: a protected environment never reaches a run without its filter.
 */
export function commandWithEnvironment(
  command: string,
  variables: readonly RunVariable[],
  environment: EnvironmentForRun | null,
  shell: RunVariableShell,
): string {
  if (!environment || command.trim() === '') return commandWithRunVariables(command, variables, shell);
  const quote = shell === 'bash' ? bashQuote : powerShellQuote;
  const filter = environment.protected
    ? ` --grep-invert ${quote(requiredTagsGrepInvert(environment.requiredTags))}`
    : '';
  const parts = splitAndCommands(command).map((part) => (filter ? withRequiredTagsFilter(part, filter) : part));
  if (parts.some((part) => part === null)) return command;
  const label = { name: ENVIRONMENT_VARIABLE, value: environment.key };
  if (shell === 'powershell') {
    const set = `$env:${label.name}=${powerShellQuote(label.value)};`;
    return withRunVariables(`${set} ${parts.join(' && ')}`, variables, shell);
  }
  return parts
    .map((part) => withRunVariables(`${label.name}=${bashQuote(label.value)} ${part}`, variables, shell))
    .join(' && ');
}

/** The commands of an `&&` chain, split outside double quotes. */
function splitAndCommands(command: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && command.startsWith(' && ', i)) {
      parts.push(command.slice(start, i));
      start = i + 4;
      i += 3;
    }
  }
  parts.push(command.slice(start));
  return parts;
}
