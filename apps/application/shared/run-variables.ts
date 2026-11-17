import { withRunVariables, type RunVariable, type RunVariableShell } from '@piwitests/core/run-variables';

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
