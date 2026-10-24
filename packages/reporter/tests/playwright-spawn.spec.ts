import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { playwrightInvocation, resolveNpmEntry } from '../src/internal/support/playwright-spawn.js';

const dirs: string[] = [];

/** A new empty directory, removed after the test. */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-spawn-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('playwrightInvocation', () => {
  it("runs the project's Playwright CLI with this Node, whatever the platform", () => {
    const invocation = playwrightInvocation(['--grep', 'a & b'], { cwd: process.cwd(), platform: 'win32' });
    expect(invocation?.file).toBe(process.execPath);
    expect(invocation?.args.slice(1)).toEqual(['test', '--grep', 'a & b']);
    expect(fs.existsSync(invocation!.args[0]!)).toBe(true);
  });

  it('falls back to the package runner, without a shell, where no CLI resolves', () => {
    expect(playwrightInvocation(['x'], { cwd: tempDir(), runner: 'pnpm', platform: 'linux' })).toEqual({
      file: 'pnpm',
      args: ['playwright', 'test', 'x'],
    });
  });

  it('starts npx through its JavaScript entry on Windows, and nothing it cannot start without a shell', () => {
    const cwd = tempDir();
    const npx = resolveNpmEntry('npx');
    expect(playwrightInvocation(['x'], { cwd, platform: 'win32' })).toEqual(
      npx ? { file: process.execPath, args: [npx, 'playwright', 'test', 'x'] } : null,
    );
    expect(playwrightInvocation(['x'], { cwd, runner: 'pnpm', platform: 'win32' })).toBeNull();
  });
});

describe('resolveNpmEntry', () => {
  it('finds npx beside the Node binary (Windows) or under ../lib (Linux, macOS)', () => {
    const windows = tempDir();
    fs.mkdirSync(path.join(windows, 'node_modules', 'npm', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(windows, 'node_modules', 'npm', 'bin', 'npx-cli.js'), '');
    expect(resolveNpmEntry('npx', path.join(windows, 'node.exe'))).toBe(
      path.join(windows, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    );

    const unix = tempDir();
    fs.mkdirSync(path.join(unix, 'bin'));
    fs.mkdirSync(path.join(unix, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(unix, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), '');
    expect(resolveNpmEntry('npx', path.join(unix, 'bin', 'node'))).toBe(
      path.join(unix, 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    );

    expect(resolveNpmEntry('npx', path.join(tempDir(), 'node'))).toBeNull();
  });
});
