/**
 * A run target's route checks the permission its meta declares: `requireRunTarget` takes `run:receive` unless the
 * route names another (`permission: 'project:read'`), and the meta's `x-required-permission` says the same, so a route
 * that declares `project:read` never lets in a key that only takes run requests.
 */
import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const routesDir = join(appDir, 'server/api/run-targets');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routeFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('the run target routes', () => {
  for (const file of routeFiles(routesDir)) {
    test(relative(appDir, file), () => {
      const src = readFileSync(file, 'utf8');
      const declared = /'x-required-permission':\s*'([^']+)'/.exec(src)?.[1];
      const calls = [...src.matchAll(/requireRunTarget\(event(?:,\s*\{([^}]*)\})?\)/g)];
      expect(calls.length, 'calls requireRunTarget').toBeGreaterThan(0);
      for (const call of calls) {
        const checked = /permission:\s*'([^']+)'/.exec(call[1] ?? '')?.[1] ?? 'run:receive';
        expect(checked).toBe(declared);
      }
    });
  }
});
