import { z } from 'zod';
import {
  ENVIRONMENT_LIMITS,
  envFileProblem,
  environmentAliasProblem,
  environmentKeyProblem,
  environmentMatchesPattern,
  environmentNameProblem,
  requiredTagProblem,
} from '@piwitests/core/environments';
import { globMatcher } from '@piwitests/core/glob';
import { parseRunVariables, type RunVariable } from '@piwitests/core/run-variables';

/**
 * A project's environment as the API returns it. `runVariables` are the environment's own, set over the project's on
 * the runs Piwi starts for it; a protected environment's are listed only to the project's managers.
 */
export interface EnvironmentRecord {
  id: number;
  key: string;
  name: string;
  description: string | null;
  aliases: string[];
  runVariables: RunVariable[];
  appFromCheckout: boolean;
  protected: boolean;
  requiredTags: string[];
  envFile: string | null;
  position: number;
  /** Created by a run's label, until a manager saves it. */
  discovered: boolean;
  archived: boolean;
}

/** The label of a run with no environment in a filter's choices (`?environment=`). */
export const NO_ENVIRONMENT_FILTER = '(none)';

/** What `POST /api/projects/:id/environments` takes; `PATCH` takes any part of it, and `archived`. */
export const environmentInputSchema = z
  .object({
    key: z.string().trim(),
    name: z.string().trim(),
    description: z.string().trim().max(ENVIRONMENT_LIMITS.descriptionChars).nullish(),
    aliases: z.array(z.string().trim()).max(ENVIRONMENT_LIMITS.aliases).optional(),
    runVariables: z.unknown().optional(),
    appFromCheckout: z.boolean().optional(),
    protected: z.boolean().optional(),
    requiredTags: z.array(z.string().trim()).max(ENVIRONMENT_LIMITS.requiredTags).optional(),
    envFile: z.string().trim().nullish(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const environmentPatchSchema = environmentInputSchema
  .partial()
  .extend({ archived: z.boolean().optional() })
  .strict();

export type EnvironmentPatch = z.infer<typeof environmentPatchSchema>;

/** The fields of an environment once its input is checked. */
export interface EnvironmentFields {
  key: string;
  name: string;
  description: string | null;
  aliases: string[];
  runVariables: RunVariable[];
  appFromCheckout: boolean;
  protected: boolean;
  requiredTags: string[];
  envFile: string | null;
}

export type EnvironmentFieldsCheck = { ok: true; value: EnvironmentFields } | { ok: false; problems: string[] };

/**
 * Checks an environment's fields one by one with the rules of `@piwitests/core/environments` and
 * `@piwitests/core/run-variables`: a protected environment needs a required tag, an alias equal to the key is dropped,
 * and an empty description or env file reads as none.
 */
export function checkEnvironmentFields(input: {
  key: string;
  name: string;
  description?: string | null;
  aliases?: string[];
  runVariables?: unknown;
  appFromCheckout?: boolean;
  protected?: boolean;
  requiredTags?: string[];
  envFile?: string | null;
}): EnvironmentFieldsCheck {
  const problems: string[] = [];
  const keyProblem = environmentKeyProblem(input.key);
  if (keyProblem) problems.push(keyProblem);
  const nameProblem = environmentNameProblem(input.name);
  if (nameProblem) problems.push(nameProblem);
  const aliases = [
    ...new Set((input.aliases ?? []).filter((alias) => alias.toLowerCase() !== input.key.toLowerCase())),
  ];
  for (const alias of aliases) {
    const problem = environmentAliasProblem(alias);
    if (problem) problems.push(problem);
  }
  if (aliases.length > ENVIRONMENT_LIMITS.aliases) {
    problems.push(
      `An environment has at most ${ENVIRONMENT_LIMITS.aliases} aliases; a renamed key becomes one: remove one first.`,
    );
  }
  const requiredTags = [...new Set(input.requiredTags ?? [])];
  for (const tag of requiredTags) {
    const problem = requiredTagProblem(tag);
    if (problem) problems.push(problem);
  }
  const isProtected = input.protected === true;
  if (isProtected && requiredTags.length === 0) {
    problems.push('A protected environment needs a required tag: its runs are limited to the tests carrying one.');
  }
  const envFile = input.envFile ? input.envFile : null;
  if (envFile) {
    const problem = envFileProblem(envFile);
    if (problem) problems.push(problem);
  }
  const runVariables = parseRunVariables(input.runVariables);
  if (!runVariables.ok) problems.push(...runVariables.problems);
  if (problems.length > 0 || !runVariables.ok) return { ok: false, problems };
  return {
    ok: true,
    value: {
      key: input.key,
      name: input.name,
      description: input.description ? input.description : null,
      aliases,
      runVariables: runVariables.value,
      appFromCheckout: input.appFromCheckout !== false,
      protected: isProtected,
      requiredTags,
      envFile,
    },
  };
}

/**
 * A run's environment as a filter-like setting reads it (a notification filter, an issue automation or test
 * management scope): its label, and the key and aliases of the environment the label resolved to, when it has one.
 */
export interface RunEnvironmentSelectable {
  environment?: string | null;
  environmentKey?: string | null;
  environmentAliases?: readonly string[] | null;
}

/**
 * Whether a run is in a setting's environments (`selectors`: keys, labels and `*` patterns). A selector names the run
 * when it equals, or `*`-matches, the key or an exact alias of the run's environment, ignoring case
 * (`environmentMatchesPattern`); for a run whose label resolved to no environment, when it equals or matches the label,
 * ignoring case. A run with no label is in none.
 */
export function runEnvironmentMatches(run: RunEnvironmentSelectable, selectors: readonly string[]): boolean {
  if (run.environmentKey) {
    const environment = { key: run.environmentKey, aliases: run.environmentAliases ?? [] };
    return selectors.some((selector) => environmentMatchesPattern(environment, selector));
  }
  const label = run.environment?.trim();
  if (!label) return false;
  return selectors.some((selector) =>
    selector.includes('*')
      ? globMatcher(selector, { ignoreCase: true })(label)
      : selector.toLowerCase() === label.toLowerCase(),
  );
}
