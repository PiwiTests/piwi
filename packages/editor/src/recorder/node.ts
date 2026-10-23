/**
 * The Node that runs the project's Playwright, for the config's reader and the recorder's launcher. Under an editor's
 * Electron running as Node (`process.versions.electron`), the first `node` on the `PATH` of the service's environment
 * when it is Node 20 or later; else, or when there is none, the service's own runtime.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The oldest Node major the editor clients support. */
const MIN_MAJOR = 20;

/** How long `node --version` may take. */
const VERSION_TIMEOUT_MS = 5_000;

export interface ProjectNode {
  /** The binary a child runs with. */
  execPath: string;
  /** Whether that binary is an Electron, which runs as Node only with `ELECTRON_RUN_AS_NODE=1`. */
  runAsNode: boolean;
}

export interface NodeLookup {
  /** Whether the service runs in an Electron. */
  electron: boolean;
  /** The service's own runtime. */
  execPath: string;
  platform: NodeJS.Platform;
  /** The `PATH` of the service's environment. */
  pathVariable: string | undefined;
  /** The output of `file` run with `args`; null when it cannot run or fails. */
  run(file: string, args: string[]): string | null;
  /** Whether `file` is a file; the file system's answer when not given. */
  isFile?(file: string): boolean;
}

/** The major version in the output of `node --version` (`v22.4.0`); null when there is none. */
export function nodeMajor(output: string): number | null {
  const match = /^v(\d+)\./.exec(output.trim());
  return match ? Number(match[1]) : null;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The first `node` (`node.exe` on Windows) in an absolute folder of the `PATH`, when it is Node 20 or later. */
export function pathNode(lookup: NodeLookup): string | null {
  const windows = lookup.platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const name = windows ? 'node.exe' : 'node';
  const exists = lookup.isFile ?? isFile;
  for (const entry of (lookup.pathVariable ?? '').split(paths.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !paths.isAbsolute(dir)) continue;
    const file = paths.join(dir, name);
    if (!exists(file)) continue;
    const output = lookup.run(file, ['--version']);
    const major = output === null ? null : nodeMajor(output);
    return major !== null && major >= MIN_MAJOR ? file : null;
  }
  return null;
}

/** The Node that runs the project's Playwright, as `lookup` describes the service. */
export function chooseProjectNode(lookup: NodeLookup): ProjectNode {
  const found = lookup.electron ? pathNode(lookup) : null;
  if (found) return { execPath: found, runAsNode: false };
  return { execPath: lookup.execPath, runAsNode: lookup.electron };
}

/** `base` for a child run by `node`: `ELECTRON_RUN_AS_NODE=1` for an Electron, without it for a Node. */
export function projectNodeEnv(node: ProjectNode, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  if (node.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function runVersion(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      env: projectNodeEnv({ execPath: file, runAsNode: false }),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

let resolved: ProjectNode | undefined;

/** The Node that runs the project's Playwright in this service, looked up once. */
export function projectNode(): ProjectNode {
  resolved ??= chooseProjectNode({
    electron: !!process.versions.electron,
    execPath: process.execPath,
    platform: process.platform,
    pathVariable: process.env.PATH,
    run: runVersion,
  });
  return resolved;
}
