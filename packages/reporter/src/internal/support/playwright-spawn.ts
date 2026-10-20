/**
 * How the command line starts other programs. `playwright test` runs through
 * the project's own Playwright CLI with the current Node (no shell, no
 * quoting), else through the package runner; a package manager runs with
 * arguments the caller fixed. Shared by every `piwi` command that starts one.
 */
import { spawn, spawnSync, type StdioOptions } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

/** The exit code a command that could not start Playwright returns. */
const COULD_NOT_START = 2;

/** The Playwright CLI the project in `cwd` resolves, or null. */
export function resolvePlaywrightCli(cwd: string = process.cwd()): string | null {
  const require = createRequire(path.join(cwd, 'noop.js'));
  for (const id of ['playwright/cli', '@playwright/test/cli', 'playwright/lib/cli/cli']) {
    try {
      return require.resolve(id);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The JavaScript entry of the npm or npx that ships with the Node at
 * `execPath` (beside it on Windows, under `../lib` elsewhere), or null.
 */
export function resolveNpmEntry(name: 'npm' | 'npx', execPath: string = process.execPath): string | null {
  const dir = path.dirname(execPath);
  for (const candidate of [
    path.join(dir, 'node_modules', 'npm', 'bin', `${name}-cli.js`),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', `${name}-cli.js`),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** A program and its arguments, started without a shell. */
export interface Invocation {
  file: string;
  args: string[];
}

/**
 * How `playwright test` with these arguments starts in `cwd`: the project's
 * Playwright CLI with this Node, else `<runner> playwright test`. On Windows a
 * runner is a `.cmd` shim, which starts only through a shell that would read
 * the arguments, so there it is npx through its JavaScript entry, or nothing:
 * null when Playwright cannot start without a shell.
 */
export function playwrightInvocation(
  playwrightArgs: string[],
  options: { cwd?: string; runner?: string; platform?: NodeJS.Platform } = {},
): Invocation | null {
  const cli = resolvePlaywrightCli(options.cwd);
  if (cli) return { file: process.execPath, args: [cli, 'test', ...playwrightArgs] };
  const runner = options.runner ?? 'npx';
  if ((options.platform ?? process.platform) !== 'win32') {
    return { file: runner, args: ['playwright', 'test', ...playwrightArgs] };
  }
  const npx = runner === 'npx' ? resolveNpmEntry('npx') : null;
  return npx ? { file: process.execPath, args: [npx, 'playwright', 'test', ...playwrightArgs] } : null;
}

export interface SpawnPlaywrightOptions {
  /** Where Playwright's output goes: the terminal, or appended to a file. */
  output?: 'inherit' | { file: string };
  /** The prefix of the message when Playwright cannot start (`piwi probe`). */
  command?: string;
  /** The project directory Playwright runs in; the working directory by default. */
  cwd?: string;
  /** The package runner when the project resolves no Playwright CLI (`npx`, `pnpm`, `yarn`…). */
  runner?: string;
}

/**
 * Run `playwright test` with these arguments and environment, and resolve with
 * its exit code (2 when it could not start).
 */
export function spawnPlaywright(
  playwrightArgs: string[],
  env: NodeJS.ProcessEnv,
  options: SpawnPlaywrightOptions = {},
): Promise<number> {
  const label = options.command ?? 'piwi';
  const cwd = options.cwd ?? process.cwd();
  const invocation = playwrightInvocation(playwrightArgs, { cwd, runner: options.runner });
  if (!invocation) {
    console.error(
      `${label}: could not find Playwright in ${cwd} — install it there (npm install --save-dev @playwright/test).`,
    );
    return Promise.resolve(COULD_NOT_START);
  }
  const output = options.output ?? 'inherit';
  let fd: number | null = output === 'inherit' ? null : fs.openSync(output.file, 'a');
  const stdio: StdioOptions = fd === null ? 'inherit' : ['ignore', fd, fd];
  const child = spawn(invocation.file, invocation.args, { stdio, env, cwd });
  return new Promise((resolve) => {
    const done = (code: number) => {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
      resolve(code);
    };
    child.on('error', (err) => {
      console.error(`${label}: could not start Playwright — ${err.message}`);
      done(COULD_NOT_START);
    });
    child.on('exit', (code) => done(code ?? COULD_NOT_START));
  });
}

/**
 * Run a package manager (`npm`, `pnpm`, `yarn`, `bun`) in `cwd` with
 * arguments the caller fixed, never user input, and return its exit status.
 * On Windows these are `.cmd` shims, which start only through the shell; the
 * command line is then the words joined as they are.
 */
export function runPackageManager(command: string, args: readonly string[], cwd: string): number | null {
  const result =
    process.platform === 'win32'
      ? spawnSync([command, ...args].join(' '), { cwd, stdio: 'inherit', shell: true })
      : spawnSync(command, args, { cwd, stdio: 'inherit' });
  return result.status;
}
