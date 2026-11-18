import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { APP_DIR } from './run-backfill';

/** The TypeScript files of the code that writes runs: the server, the shared handlers and the demo. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|vue)$/.test(name) ? [path] : [];
  });
}

/** An `environment` property (`environment:`, or shorthand) in an object literal. */
const environmentProperty = /(^|[{,\s])environment\s*[:,}]/m;

describe('the environment column', () => {
  test('every write of test_runs sets the label through resolveRunEnvironment, never on its own', () => {
    const missing: string[] = [];
    for (const file of ['server', 'shared', 'app/demo'].flatMap((dir) => sourceFiles(join(APP_DIR, dir)))) {
      const text = readFileSync(file, 'utf8');
      for (const write of text.matchAll(/\.(insert|update)\((?:schema\.)?testRuns\)/g)) {
        const rest = text.slice(write.index);
        const end = rest.search(/;\s*\n/);
        const statement = end === -1 ? rest : rest.slice(0, end);
        if (environmentProperty.test(statement)) {
          const line = text.slice(0, write.index).split('\n').length;
          missing.push(`${relative(APP_DIR, file)}:${line}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
