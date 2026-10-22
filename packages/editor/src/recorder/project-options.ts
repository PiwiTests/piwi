/**
 * The `use` options Playwright resolves for each project of a config, read by running the project's own Playwright
 * CLI with the editor service's reporter (`piwi-use-reporter.cjs`): `playwright test --list` with a filter no spec
 * file matches, so Playwright reads the config and loads no test, with the project's Node (`projectNode`). Cached per
 * config file until it or a file it reads changes (`configFingerprint`), for five minutes at most.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectNode, projectNodeEnv } from './node.js';
import { canonicalPath, resolvePlaywrightCli } from './playwright.js';
import { USE_LINE } from './use-reporter.js';

export interface ProjectUse {
  name: string;
  testDir: string;
  /** The project's `use` options as Playwright resolved them, without the values JSON cannot hold. */
  use: Record<string, unknown>;
}

export interface ProjectOptions {
  configFile: string;
  rootDir: string;
  /** Piwi's section of the config (`'@piwi'`) as written, unchecked; null when there is none. */
  piwi?: unknown;
  projects: ProjectUse[];
}

/** Why a config's options could not be read. */
export type ProjectOptionsFailure = 'playwright-missing' | 'timeout' | 'failed';

export class ProjectOptionsError extends Error {
  constructor(
    readonly reason: ProjectOptionsFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectOptionsError';
  }
}

/** How long Playwright may take to read a config. */
const READ_TIMEOUT_MS = 30_000;

/** A spec filter no file matches: Playwright reads the config and loads no test. */
const NO_SPEC = '__piwi_no_such_spec__';

/** The most output kept from Playwright. */
const MAX_OUTPUT = 8 * 1024 * 1024;

/** How long a config's options are kept, whatever changes. */
const CACHE_TTL_MS = 5 * 60_000;

/** The extensions a relative import without one is resolved with, in order. */
const IMPORT_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.json'];

/** A relative module a config loads: `import … from`, `export … from`, `import(…)`, a bare `import` or `require(…)`. */
const RELATIVE_IMPORT = /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*(['"])(\.{1,2}\/[^'"\r\n]*)\1/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The options in the reporter's output (its `PIWI_USE` line), checked field by field; null when there is none. */
export function parseUseLine(output: string): ProjectOptions | null {
  const line = output.split(/\r?\n/).find((l) => l.startsWith(USE_LINE));
  if (!line) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(USE_LINE.length));
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.rootDir !== 'string' || !Array.isArray(value.projects)) return null;
  const projects = value.projects.flatMap((p): ProjectUse[] =>
    isRecord(p) && typeof p.name === 'string' && typeof p.testDir === 'string' && isRecord(p.use)
      ? [{ name: p.name, testDir: p.testDir, use: p.use }]
      : [],
  );
  if (!projects.length) return null;
  return {
    configFile: typeof value.configFile === 'string' ? value.configFile : '',
    rootDir: value.rootDir,
    piwi: value.piwi ?? null,
    projects,
  };
}

/** The first line of Playwright's output (run without colors), shortened, as the end of a sentence. */
function firstLine(output: string): string {
  const line =
    output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? 'no output';
  const short = line.length > 200 ? `${line.slice(0, 199)}…` : line;
  return /[.!?…]$/.test(short) ? short : `${short}.`;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The file a relative import names, as Node and Playwright resolve it: the path itself, with one of
 * `IMPORT_EXTENSIONS`, a `.ts` for a `.js`, or the folder's `index`; the path as written when none exists.
 */
function resolveImport(dir: string, specifier: string): string {
  const base = path.resolve(dir, specifier);
  const typed = base.replace(/\.([mc]?)js$/, '.$1ts');
  const candidates = [
    base,
    ...(typed === base ? [] : [typed]),
    ...IMPORT_EXTENSIONS.map((ext) => base + ext),
    ...IMPORT_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  return candidates.find(isFile) ?? base;
}

/** The folder of `dir`'s repository (the first folder up from it holding `.git`); null outside a repository. */
function repositoryOf(dir: string): string | null {
  for (let folder = dir; ; folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, '.git'))) return folder;
    if (path.dirname(folder) === folder) return null;
  }
}

/** The `.env` files (`.env`, `.env.local`, …) of `dir`, sorted. */
function envFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name === '.env' || name.startsWith('.env.'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * The files a config's options may depend on: the config, the `.env` files of its folder and of each folder above it
 * up to the repository's (its folder alone outside a repository), and the local modules the config imports or
 * requires, by a relative path.
 */
export function configInputs(configFile: string, text: string): string[] {
  const dir = path.dirname(configFile);
  const repository = repositoryOf(dir);
  const folders = [dir];
  if (repository) {
    for (let folder = dir; folder !== repository; folder = path.dirname(folder)) folders.push(path.dirname(folder));
  }
  const imports = new Set<string>();
  for (const match of text.matchAll(RELATIVE_IMPORT)) imports.add(resolveImport(dir, match[2]!));
  return [configFile, ...folders.flatMap(envFiles), ...imports];
}

/**
 * The modification time and size of each of a config's {@link configInputs}, in one string that changes when one of
 * them does or the list does; null when the config cannot be read.
 */
export function configFingerprint(configFile: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch {
    return null;
  }
  return configInputs(configFile, text)
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${file}\0${stat.mtimeMs}\0${stat.size}`;
      } catch {
        return `${file}\0-`;
      }
    })
    .join('\n');
}

function run(configFile: string, reporter: string, timeoutMs: number): Promise<ProjectOptions> {
  const cwd = path.dirname(configFile);
  const name = path.basename(configFile);
  const cli = resolvePlaywrightCli(cwd);
  if (!cli) {
    return Promise.reject(
      new ProjectOptionsError('playwright-missing', `Playwright is not installed in ${cwd}: run npm install there.`),
    );
  }
  if (!fs.existsSync(reporter)) {
    return Promise.reject(new ProjectOptionsError('failed', `The editor service's reporter is missing: ${reporter}.`));
  }
  return new Promise((resolve, reject) => {
    const node = projectNode();
    const child = spawn(
      node.execPath,
      [cli, 'test', '--list', '--pass-with-no-tests', `--reporter=${reporter}`, '-c', configFile, NO_SPEC],
      {
        cwd,
        env: projectNodeEnv(node, { ...process.env, FORCE_COLOR: '0' }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      settle(() =>
        reject(
          new ProjectOptionsError('timeout', `Playwright did not read ${name} within ${timeoutMs / 1000} seconds.`),
        ),
      );
    }, timeoutMs);
    child.on('error', (error) =>
      settle(() =>
        reject(new ProjectOptionsError('failed', `Playwright could not start: ${firstLine(error.message)}`)),
      ),
    );
    child.on('close', () => {
      const options = parseUseLine(stdout);
      settle(() =>
        options
          ? resolve(options)
          : reject(
              new ProjectOptionsError('failed', `Playwright could not read ${name}: ${firstLine(stderr || stdout)}`),
            ),
      );
    });
  });
}

const cache = new Map<string, { fingerprint: string; expires: number; options: Promise<ProjectOptions> }>();

/**
 * The resolved options of a config's projects, read by its own Playwright (resolved from the config's folder, run
 * there with the project's Node), with `reporter` (the path of `piwi-use-reporter.cjs`). Kept per config, as the file
 * system spells its path, until its {@link configFingerprint} changes or for five minutes; a failure is not kept.
 * Rejects with a {@link ProjectOptionsError}.
 */
export function readProjectOptions(
  configFile: string,
  reporter: string,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<ProjectOptions> {
  const file = canonicalPath(configFile);
  const fingerprint = configFingerprint(file);
  if (fingerprint === null) return Promise.reject(new ProjectOptionsError('failed', `${configFile} cannot be read.`));
  const now = Date.now();
  const cached = cache.get(file);
  if (cached && cached.fingerprint === fingerprint && now < cached.expires) return cached.options;
  const entry = { fingerprint, expires: now + CACHE_TTL_MS, options: run(file, reporter, timeoutMs) };
  cache.set(file, entry);
  entry.options.catch(() => {
    if (cache.get(file) === entry) cache.delete(file);
  });
  return entry.options;
}
