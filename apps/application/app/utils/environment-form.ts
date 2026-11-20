/**
 * The form of one environment in Project → Settings → Environments: the draft it edits, each field's problem as typed
 * (the rules of `@piwitests/core/environments` and `@piwitests/core/run-variables`, which the instance checks again),
 * and the body `POST` and `PATCH /api/projects/:id/environments` take.
 */
import {
  ENVIRONMENT_LIMITS,
  envFileProblem,
  environmentAliasProblem,
  environmentKeyProblem,
  environmentListProblems,
  environmentNameProblem,
  requiredTagProblem,
  resolveEnvironment,
} from '@piwitests/core/environments';
import { runVariableNameProblem, runVariableValueProblem, type RunVariable } from '@piwitests/core/run-variables';
import type { EnvironmentRecord } from '#shared/environments';

/** An environment as its form edits it: every text as typed. */
export interface EnvironmentDraft {
  key: string;
  name: string;
  description: string;
  aliases: string[];
  runVariables: RunVariable[];
  appFromCheckout: boolean;
  protected: boolean;
  requiredTags: string[];
  envFile: string;
}

/** The problem of each field of a draft, as the form shows it under the field; none when the field is right. */
export interface EnvironmentDraftProblems {
  key?: string;
  name?: string;
  description?: string;
  aliases?: string;
  /** The problem of each run variable row, by its place in the form. */
  runVariables: (string | undefined)[];
  requiredTags?: string;
  envFile?: string;
  /** A key or an alias another environment of the project already names. */
  list?: string;
}

/** The form of an environment, or of a new one (`null`) with every field empty. */
export function environmentDraft(record: EnvironmentRecord | null): EnvironmentDraft {
  return {
    key: record?.key ?? '',
    name: record?.name ?? '',
    description: record?.description ?? '',
    aliases: [...(record?.aliases ?? [])],
    runVariables: (record?.runVariables ?? []).map((variable) => ({ name: variable.name, value: variable.value })),
    appFromCheckout: record?.appFromCheckout ?? true,
    protected: record?.protected ?? false,
    requiredTags: [...(record?.requiredTags ?? [])],
    envFile: record?.envFile ?? '',
  };
}

/**
 * The aliases a draft saves: trimmed, each once, and none equal to the key ignoring case, which the instance drops too,
 * so an alias promoted to the key leaves the list.
 */
function writtenAliases(draft: EnvironmentDraft): string[] {
  const key = draft.key.trim().toLowerCase();
  return [
    ...new Set(
      draft.aliases.map((alias) => alias.trim()).filter((alias) => alias !== '' && alias.toLowerCase() !== key),
    ),
  ];
}

/** The required tags a draft saves: trimmed and each once for a protected environment, none for another. */
function writtenRequiredTags(draft: EnvironmentDraft): string[] {
  return draft.protected ? [...new Set(draft.requiredTags.map((tag) => tag.trim()).filter((tag) => tag !== ''))] : [];
}

/** The run variable rows a draft saves: those with a name or a value, the name without spaces around it. */
function writtenRunVariables(draft: EnvironmentDraft): RunVariable[] {
  return draft.runVariables
    .map((row) => ({ name: row.name.trim(), value: row.value }))
    .filter((row) => row.name !== '' || row.value !== '');
}

function firstProblem(values: readonly string[], problemOf: (value: string) => string | null): string | undefined {
  for (const value of values) {
    const problem = problemOf(value);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * Each field's problem in a draft, read as the instance saves it: an alias equal to the key is left out, and the
 * required tags count for a protected environment only. `others` are the project's other environments: a key or an
 * exact alias one of them names already is a problem, except a discovered environment the draft takes over (its key
 * is the draft's key or alias), which the instance merges into it on save.
 */
export function environmentDraftProblems(
  draft: EnvironmentDraft,
  others: readonly EnvironmentRecord[] = [],
): EnvironmentDraftProblems {
  const key = draft.key.trim();
  const aliases = writtenAliases(draft);
  const tags = writtenRequiredTags(draft);
  const envFile = draft.envFile.trim();

  const seen = new Set<string>();
  const runVariables = draft.runVariables.map((row) => {
    const name = row.name.trim();
    if (name === '' && row.value === '') return undefined;
    const problem = runVariableNameProblem(name) ?? runVariableValueProblem(name, row.value);
    if (problem) return problem;
    if (seen.has(name)) return `${name} is set twice.`;
    seen.add(name);
    return undefined;
  });

  const problems: EnvironmentDraftProblems = { runVariables };
  const keyProblem = environmentKeyProblem(key);
  if (keyProblem) problems.key = keyProblem;
  const nameProblem = environmentNameProblem(draft.name);
  if (nameProblem) problems.name = nameProblem;
  if (draft.description.trim().length > ENVIRONMENT_LIMITS.descriptionChars) {
    problems.description = `A description holds at most ${ENVIRONMENT_LIMITS.descriptionChars} characters.`;
  }
  problems.aliases =
    aliases.length > ENVIRONMENT_LIMITS.aliases
      ? `An environment has at most ${ENVIRONMENT_LIMITS.aliases} aliases.`
      : firstProblem(aliases, environmentAliasProblem);
  if (!problems.aliases) delete problems.aliases;
  problems.requiredTags =
    tags.length > ENVIRONMENT_LIMITS.requiredTags
      ? `A protected environment has at most ${ENVIRONMENT_LIMITS.requiredTags} required tags.`
      : (firstProblem(tags, requiredTagProblem) ??
        (draft.protected && tags.length === 0
          ? 'A protected environment needs a required tag: its runs are limited to the tests carrying one.'
          : undefined));
  if (!problems.requiredTags) delete problems.requiredTags;
  if (envFile) {
    const problem = envFileProblem(envFile);
    if (problem) problems.envFile = problem;
  }

  if (!keyProblem) {
    const saved = { id: -1, key, aliases, position: 0 };
    const kept = others.filter((other) => !(other.discovered && resolveEnvironment(other.key, [saved]) === saved.id));
    const before = new Set(environmentListProblems(kept));
    const clash = environmentListProblems([...kept, saved]).find((problem) => !before.has(problem));
    if (clash) problems.list = clash;
  }
  return problems;
}

/** Every problem of a draft, in the order of the form's fields. */
export function environmentDraftProblemList(problems: EnvironmentDraftProblems): string[] {
  const fields = [problems.key, problems.name, problems.description, problems.aliases, problems.list];
  return [...fields, ...problems.runVariables, problems.envFile, problems.requiredTags].filter(
    (problem): problem is string => !!problem,
  );
}

/** Whether any field of a draft has a problem. */
export function environmentDraftHasProblem(problems: EnvironmentDraftProblems): boolean {
  return environmentDraftProblemList(problems).length > 0;
}

/** What `POST /api/projects/:id/environments` takes for a draft, and `PATCH` for a change of one. */
export function environmentDraftBody(draft: EnvironmentDraft) {
  return {
    key: draft.key.trim(),
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    aliases: writtenAliases(draft),
    runVariables: writtenRunVariables(draft),
    appFromCheckout: draft.appFromCheckout,
    protected: draft.protected,
    requiredTags: writtenRequiredTags(draft),
    envFile: draft.envFile.trim() || null,
  };
}

/**
 * The `PATCH` bodies, by environment id, that move `moved` one place up (`-1`) or down (`1`) in `list` (the
 * environments it moves among, in any order): it swaps positions with its neighbor, or, when the two share a position,
 * the list is numbered again from 0 in its new order and each environment whose position changes is listed. Empty
 * when it is already first or last.
 */
export function environmentMoves(
  list: readonly Pick<EnvironmentRecord, 'id' | 'position'>[],
  moved: number,
  step: -1 | 1,
): { id: number; position: number }[] {
  const ordered = [...list].sort((a, b) => a.position - b.position || a.id - b.id);
  const at = ordered.findIndex((environment) => environment.id === moved);
  const to = at + step;
  if (at < 0 || to < 0 || to >= ordered.length) return [];
  const self = ordered[at]!;
  const neighbor = ordered[to]!;
  if (self.position !== neighbor.position) {
    return [
      { id: self.id, position: neighbor.position },
      { id: neighbor.id, position: self.position },
    ];
  }
  [ordered[at], ordered[to]] = [neighbor, self];
  return ordered.flatMap((environment, position) =>
    environment.position === position ? [] : [{ id: environment.id, position }],
  );
}
