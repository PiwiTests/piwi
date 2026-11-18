import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  ENVIRONMENT_LIMITS,
  ENVIRONMENT_VARIABLE,
  envFileProblem,
  requiredTagProblem,
  requiredTagsGrepInvert,
} from '@piwitests/core/environments';
import { RUN_VARIABLE_LIMITS } from '@piwitests/core/run-variables';

/**
 * The desktop shell checks the environment a run is for again before it applies it
 * (`apps/desktop/src-tauri/src/environments.rs`): its limits, its env file rule and the `--grep-invert` it adds for a
 * protected environment are core's, and so is the size of the merged list of run variables
 * (`apps/desktop/src-tauri/src/run_variables.rs`).
 */

function rustSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../desktop/src-tauri/src/${file}`, import.meta.url)), 'utf8');
}

const environments = rustSource('environments.rs');
const runVariables = rustSource('run_variables.rs');

/** The value of the `usize` constant `name`. */
function rustNumber(source: string, name: string): number {
  const found = source.match(new RegExp(`const ${name}: usize = (\\d+);`));
  if (!found) throw new Error(`${name} not found`);
  return Number(found[1]);
}

/** The value of the `&str` constant `name`, written as a raw string or a plain one without escapes. */
function rustText(source: string, name: string): string {
  const found = source.match(new RegExp(`const ${name}: &str = r?"([^"]*)";`));
  if (!found) throw new Error(`${name} not found`);
  return found[1]!;
}

/** The string literals of the first array after `marker` in the Rust source, unescaped. */
function rustStrings(source: string, marker: string): string[] {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`${marker} not found`);
  const open = source.indexOf('[', at);
  const close = source.indexOf(']', open);
  return [...source.slice(open + 1, close).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replaceAll('\\\\', '\\'));
}

describe('the shell applies an environment as core describes it', () => {
  test('the same variable and limits', () => {
    expect(rustText(environments, 'ENVIRONMENT_VARIABLE')).toBe(ENVIRONMENT_VARIABLE);
    expect(rustNumber(environments, 'MAX_KEY_UNITS')).toBe(ENVIRONMENT_LIMITS.keyChars);
    expect(rustNumber(environments, 'MAX_ENVIRONMENT_NAME_UNITS')).toBe(ENVIRONMENT_LIMITS.nameChars);
    expect(rustNumber(environments, 'MAX_REQUIRED_TAGS')).toBe(ENVIRONMENT_LIMITS.requiredTags);
    expect(rustNumber(runVariables, 'MAX_MERGED_RUN_VARIABLES')).toBe(RUN_VARIABLE_LIMITS.merged);
  });

  test('the same length of a required tag and of an env file name', () => {
    const tagChars = rustNumber(environments, 'MAX_TAG_CHARS');
    expect(requiredTagProblem(`@${'a'.repeat(tagChars)}`)).toBeNull();
    expect(requiredTagProblem(`@${'a'.repeat(tagChars + 1)}`)).not.toBeNull();
    const fileChars = rustNumber(environments, 'MAX_ENV_FILE_CHARS');
    expect(envFileProblem(`.env.${'a'.repeat(fileChars - 5)}`)).toBeNull();
    expect(envFileProblem(`.env.${'a'.repeat(fileChars - 4)}`)).not.toBeNull();
  });

  test('the env file names the shell takes and refuses are those core takes and refuses', () => {
    const taken = rustStrings(environments, 'for ok in [');
    const refused = rustStrings(environments, 'for refused in [');
    expect(taken.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    for (const name of taken) expect(envFileProblem(name), name).toBeNull();
    for (const name of refused) expect(envFileProblem(name), name).not.toBeNull();
  });

  test('the same --grep-invert for a protected environment', () => {
    const start = rustText(environments, 'GREP_INVERT_START');
    const end = rustText(environments, 'GREP_INVERT_END');
    for (const tags of [['@smoke'], ['@smoke', '@read-only'], ['@a_b', '@C-9']]) {
      expect(`${start}${tags.join('|')}${end}`).toBe(requiredTagsGrepInvert(tags));
    }
  });
});
