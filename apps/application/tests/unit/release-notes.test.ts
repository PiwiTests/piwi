import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const script = join(repoRoot, 'scripts', 'release-notes.mjs');

const link = (hash: string) => `[${hash}](https://github.com/PiwiTests/piwi/commit/${hash})`;
const dedupe = (body: string) =>
  execFileSync('node', [script, 'dedupe'], { input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });

describe('release-notes dedupe', () => {
  test('merges an entry written once per commit into one, with every link', () => {
    const body = [
      `* **ide:** reproduce and bisect team CI failures (${link('0588512')})`,
      `* **ide:** reproduce and bisect team CI failures (${link('1111111')})`,
    ].join('\n');
    expect(dedupe(body)).toBe(
      `* **ide:** reproduce and bisect team CI failures (${link('0588512')}, ${link('1111111')})\n`,
    );
  });

  test('keeps the same subject under different scopes as separate entries', () => {
    const body = [
      `* **desktop:** reproduce and bisect team CI failures (${link('c7140f5')})`,
      `* **ide:** reproduce and bisect team CI failures (${link('0588512')})`,
    ].join('\n');
    expect(dedupe(body)).toBe(body + '\n');
  });
});
