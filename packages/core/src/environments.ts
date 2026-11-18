/**
 * Environments: the deployments of the application a project's tests run against (Local, Integration, Staging,
 * Production), kept as records of the project. A run reports a label (the reporter's `environment` option or
 * `PIWI_ENVIRONMENT`); the instance resolves it to one of the project's environments by its key or one of its aliases
 * ({@link resolveEnvironment}). A run Piwi starts for an environment gets the project's run variables and the
 * environment's ({@link mergeRunVariables}), and `PIWI_ENVIRONMENT` set to its key.
 *
 * The instance checks these rules when an environment is saved; every target (the editor service, the desktop app)
 * checks what it is about to apply again with {@link parseEnvironmentForRun} and runs nothing when one fails.
 */
import { globMatcher } from './glob';
import { HIDDEN_CHARACTER } from './run-request';
import { runVariableValueProblem } from './run-variables';

/** The bounds of a project's environments. */
export const ENVIRONMENT_LIMITS = {
  /** Environments per project, discovered ones included. */
  perProject: 100,
  /** Environments a run's label may create in a project (`discovered`). */
  discovered: 50,
  /** Characters of a key, an alias, and a name. */
  keyChars: 80,
  nameChars: 80,
  /** Characters of a description. */
  descriptionChars: 500,
  /** Aliases per environment. */
  aliases: 20,
  /** Required tags of a protected environment. */
  requiredTags: 10,
  /** Characters of a stored run label: a longer one is cut there. */
  labelChars: 200,
} as const;

/** The variable a run Piwi starts for an environment gets, holding its key: the reporter reports it as the run's label. */
export const ENVIRONMENT_VARIABLE = 'PIWI_ENVIRONMENT';

/** A required tag: `@` then 1 to 63 ASCII letters, digits, `_` or `-` (`@smoke`). */
const TAG = /^@[A-Za-z0-9_-]{1,63}$/;

/** An env file's name: `.env`, then `.`-separated parts of ASCII letters, digits, `_` or `-` (`.env.staging`). */
const ENV_FILE = /^\.env(\.[A-Za-z0-9_-]+)*$/;
const ENV_FILE_CHARS = 64;

/**
 * A run's label as it is stored: trimmed, cut at {@link ENVIRONMENT_LIMITS.labelChars}, and null when nothing is left
 * or it is not text.
 */
export function normalizeEnvironmentLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.length > ENVIRONMENT_LIMITS.labelChars
    ? trimmed.slice(0, ENVIRONMENT_LIMITS.labelChars).trim()
    : trimmed;
}

/**
 * Why a text cannot be an environment's key, or null when it can: 1 to 80 characters a run variable's value may hold
 * (letters, digits, spaces and `_ - . , : / @ + =`, no space at either end), since `PIWI_ENVIRONMENT` carries it to the
 * runs Piwi starts and the copied commands show it.
 */
export function environmentKeyProblem(key: string): string | null {
  if (key.length === 0) return 'An environment needs a key: the label its runs report.';
  if (key.length > ENVIRONMENT_LIMITS.keyChars) {
    return `An environment key holds at most ${ENVIRONMENT_LIMITS.keyChars} characters.`;
  }
  if (runVariableValueProblem(ENVIRONMENT_VARIABLE, key) !== null) {
    return `${JSON.stringify(key)} is not an environment key: letters, digits, spaces and _ - . , : / @ + = only, with no space at either end.`;
  }
  return null;
}

/**
 * Why a text cannot be an alias, or null when it can: what a key may hold, plus `*`, which matches any run of
 * characters (`pr-*`).
 */
export function environmentAliasProblem(alias: string): string | null {
  const literal = alias.replaceAll('*', 'x');
  if (alias.length === 0 || alias.length > ENVIRONMENT_LIMITS.keyChars || environmentKeyProblem(literal) !== null) {
    return `${JSON.stringify(alias.slice(0, ENVIRONMENT_LIMITS.keyChars))} is not an alias: what a key holds, and * for any run of characters.`;
  }
  if (alias.replaceAll('*', '') === '') return 'An alias needs more than *: it would take every label.';
  return null;
}

/** Why a text cannot be an environment's name, or null when it can: 1 to 80 characters, no hidden character. */
export function environmentNameProblem(name: string): string | null {
  if (name.trim() === '') return 'An environment needs a name.';
  if (name.length > ENVIRONMENT_LIMITS.nameChars) {
    return `An environment name holds at most ${ENVIRONMENT_LIMITS.nameChars} characters.`;
  }
  if (HIDDEN_CHARACTER.test(name))
    return 'An environment name holds a line break, a control or an invisible character.';
  return null;
}

/** Why a text cannot be a required tag, or null when it can (`@smoke`). */
export function requiredTagProblem(tag: string): string | null {
  return TAG.test(tag)
    ? null
    : `${JSON.stringify(tag.slice(0, 64))} is not a tag: @ then letters, digits, _ or -, 64 characters at most.`;
}

/** Why a text cannot be an env file's name, or null when it can (`.env.staging`): a name, never a folder. */
export function envFileProblem(name: string): string | null {
  return name.length <= ENV_FILE_CHARS && ENV_FILE.test(name)
    ? null
    : `${JSON.stringify(name.slice(0, ENV_FILE_CHARS))} is not an env file name: .env, then parts of letters, digits, _ or - after a dot (.env.staging).`;
}

/** What resolving a label reads of an environment. */
export interface EnvironmentMatchSource {
  id: number;
  key: string;
  aliases: readonly string[];
  position: number;
}

function byPosition(a: EnvironmentMatchSource, b: EnvironmentMatchSource): number {
  return a.position - b.position || a.id - b.id;
}

/**
 * The environment a run's label resolves to, or null: the one whose key equals it ignoring case, else whose exact alias
 * does, else whose `*` alias matches it, the first in position order. The label is normalized first
 * ({@link normalizeEnvironmentLabel}); no label resolves to none.
 */
export function resolveEnvironment(label: unknown, environments: readonly EnvironmentMatchSource[]): number | null {
  const normalized = normalizeEnvironmentLabel(label);
  if (normalized === null) return null;
  const lower = normalized.toLowerCase();
  const ordered = [...environments].sort(byPosition);
  const byKey = ordered.find((environment) => environment.key.toLowerCase() === lower);
  if (byKey) return byKey.id;
  const byAlias = ordered.find((environment) =>
    environment.aliases.some((alias) => !alias.includes('*') && alias.toLowerCase() === lower),
  );
  if (byAlias) return byAlias.id;
  const byPattern = ordered.find((environment) =>
    environment.aliases.some((alias) => alias.includes('*') && globMatcher(alias, { ignoreCase: true })(normalized)),
  );
  return byPattern?.id ?? null;
}

/**
 * Whether a text names an environment in a filter: it equals the key or an exact alias ignoring case, or a `*` pattern
 * of the filter matches the key or an alias.
 */
export function environmentMatchesPattern(
  environment: Pick<EnvironmentMatchSource, 'key' | 'aliases'>,
  pattern: string,
): boolean {
  const names = [environment.key, ...environment.aliases.filter((alias) => !alias.includes('*'))];
  if (!pattern.includes('*')) return names.some((name) => name.toLowerCase() === pattern.toLowerCase());
  const matches = globMatcher(pattern, { ignoreCase: true });
  return names.some(matches);
}

/**
 * The problems of a project's list of environments taken together: two keys equal ignoring case, an exact alias equal
 * to a key or to another exact alias.
 */
export function environmentListProblems(
  environments: readonly Pick<EnvironmentMatchSource, 'key' | 'aliases'>[],
): string[] {
  const problems: string[] = [];
  const owners = new Map<string, number>();
  environments.forEach((environment, index) => {
    const own = new Set<string>();
    const names = [environment.key, ...environment.aliases.filter((alias) => !alias.includes('*'))];
    for (const name of names) {
      const lower = name.toLowerCase();
      const owner = owners.get(lower);
      if (own.has(lower)) problems.push(`${JSON.stringify(name)} is listed twice for ${environment.key}.`);
      else if (owner !== undefined && owner !== index) {
        problems.push(
          `${JSON.stringify(name)} names two environments: ${environments[owner]!.key} and ${environment.key}.`,
        );
      }
      own.add(lower);
      if (owner === undefined) owners.set(lower, index);
    }
  });
  return problems;
}

/**
 * The `--grep-invert` that keeps a run to the tests carrying one of `tags`: it leaves out every test whose title and
 * tags (as Playwright matches a grep: the title path and the tags, joined by spaces) hold none of them as a word.
 * `own` is the run's own `--grep-invert`, kept: a test either pattern matches is left out. Tags are checked by
 * {@link requiredTagProblem}, so none needs escaping.
 */
export function requiredTagsGrepInvert(tags: readonly string[], own?: string | null): string {
  const required = `^(?!.*(?:^|\\s)(?:${tags.join('|')})(?:\\s|$))`;
  return own ? `(?:${own})|${required}` : required;
}

/** What a target reads of the environment a run is started for, beside the run variables it gets. */
export interface EnvironmentForRun {
  id: number;
  key: string;
  name: string;
  protected: boolean;
  /** The tags a protected environment's runs are limited to; empty for another environment. */
  requiredTags: string[];
  /** The file the config loads for this environment, which the desktop app checks for and copies into a worktree. */
  envFile: string | null;
}

export type EnvironmentForRunParse = { ok: true; value: EnvironmentForRun | null } | { ok: false; problems: string[] };

/**
 * Reads the environment a target is told a run is for: `null` and `undefined` for none, else an object with a numeric
 * `id`, a key ({@link environmentKeyProblem}), a name, `protected`, the required tags (at least one when protected) and
 * an env file name or null. Any problem refuses it: a target never runs for an environment it cannot apply whole.
 */
export function parseEnvironmentForRun(value: unknown): EnvironmentForRunParse {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['The environment must be an object.'] };
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  const id = record.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) problems.push('The environment has no id.');
  const key = typeof record.key === 'string' ? record.key : '';
  const keyProblem = environmentKeyProblem(key);
  if (keyProblem) problems.push(keyProblem);
  const name = typeof record.name === 'string' ? record.name : '';
  const nameProblem = environmentNameProblem(name);
  if (nameProblem) problems.push(nameProblem);
  const isProtected = record.protected === true;
  if (record.protected !== true && record.protected !== false)
    problems.push('The environment does not say whether it is protected.');
  const tags = Array.isArray(record.requiredTags) ? record.requiredTags : null;
  if (!tags || tags.length > ENVIRONMENT_LIMITS.requiredTags || tags.some((tag) => typeof tag !== 'string')) {
    problems.push(`The required tags must be a list of at most ${ENVIRONMENT_LIMITS.requiredTags} texts.`);
  } else {
    for (const tag of tags as string[]) {
      const problem = requiredTagProblem(tag);
      if (problem) problems.push(problem);
    }
    if (isProtected && tags.length === 0) problems.push('A protected environment needs a required tag.');
  }
  const envFile = record.envFile ?? null;
  if (envFile !== null) {
    if (typeof envFile !== 'string') problems.push('The env file must be a name.');
    else {
      const problem = envFileProblem(envFile);
      if (problem) problems.push(problem);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      id: id as number,
      key,
      name,
      protected: isProtected,
      requiredTags: isProtected ? [...(tags as string[])] : [],
      envFile: envFile as string | null,
    },
  };
}
