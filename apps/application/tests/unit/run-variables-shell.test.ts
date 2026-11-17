import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  REFUSED_RUN_VARIABLE_NAMES,
  REFUSED_RUN_VARIABLE_PREFIXES,
  RUN_VARIABLE_LIMITS,
} from '@piwitests/core/run-variables';

/**
 * The desktop shell checks a project's run variables again before it sets them on a process
 * (`apps/desktop/src-tauri/src/run_variables.rs`): its refused names, prefixes and limits are core's.
 */

const rust = readFileSync(
  fileURLToPath(new URL('../../../desktop/src-tauri/src/run_variables.rs', import.meta.url)),
  'utf8',
);

/** The string literals of the `&[&str]` constant `name`. */
function rustList(name: string): string[] {
  const block = rust.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`));
  if (!block) throw new Error(`${name} not found in run_variables.rs`);
  return [...block[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

/** The value of the `usize` constant `name`. */
function rustNumber(name: string): number {
  const found = rust.match(new RegExp(`const ${name}: usize = (\\d+);`));
  if (!found) throw new Error(`${name} not found in run_variables.rs`);
  return Number(found[1]);
}

describe('the shell refuses the run variables core refuses', () => {
  test('the same names', () => {
    expect(rustList('REFUSED_NAMES').toSorted()).toEqual([...REFUSED_RUN_VARIABLE_NAMES].toSorted());
  });

  test('the same prefixes', () => {
    expect(rustList('REFUSED_PREFIXES').toSorted()).toEqual([...REFUSED_RUN_VARIABLE_PREFIXES].toSorted());
  });

  test('the same limits', () => {
    expect(rustNumber('MAX_RUN_VARIABLES')).toBe(RUN_VARIABLE_LIMITS.count);
    expect(rustNumber('MAX_NAME_CHARS')).toBe(RUN_VARIABLE_LIMITS.nameChars);
    expect(rustNumber('MAX_VALUE_UNITS')).toBe(RUN_VARIABLE_LIMITS.valueChars);
  });
});
