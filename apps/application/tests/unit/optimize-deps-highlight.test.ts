import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe("the dev server's pre-bundled dependencies", () => {
  it('include every highlight.js module the run-ui highlighter imports', () => {
    const highlighter = read('../../../../packages/run-ui/src/highlight.ts');
    const config = read('../../nuxt.config.ts');
    const imported = [...highlighter.matchAll(/from '(highlight\.js\/[^']+)'/g)].map((m) => m[1]);
    expect(imported.length).toBeGreaterThan(1);
    const missing = imported.filter((name) => !config.includes(`'${name}'`));
    // A module Vite discovers at run time reloads the open page, which drops a test's fake desktop bridge.
    expect(missing).toEqual([]);
  });
});
