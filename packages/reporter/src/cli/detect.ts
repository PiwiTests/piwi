/**
 * Read-only inspection of the target project so `init` knows what it is looking
 * at before it changes anything: which package manager runs there, where the
 * Playwright config lives, whether the reporter is already a dependency, and a
 * sensible default project name.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
type ConfigLang = 'ts' | 'js';

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

export interface ProjectShape {
  /** Absolute project root the command was pointed at. */
  root: string;
  /** Parsed `package.json`, or null when the directory has none. */
  packageJson: PackageJson | null;
  packageJsonPath: string | null;
  packageManager: PackageManager;
  /** Absolute path to the Playwright config, or null when none is found. */
  configPath: string | null;
  configLang: ConfigLang;
  /** Whether `@piwitests/reporter` is already listed in dependencies. */
  reporterInstalled: boolean;
  /** Default `projectName` for the reporter, derived from the package or folder. */
  suggestedProjectName: string;
}

const CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.cts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

/** Lockfile → package manager, in the order a repo's presence should win. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

const REPORTER_PACKAGE = '@piwitests/reporter';

function readPackageJson(root: string): { pkg: PackageJson | null; pkgPath: string | null } {
  const pkgPath = path.join(root, 'package.json');
  try {
    return { pkg: JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PackageJson, pkgPath };
  } catch {
    return { pkg: null, pkgPath: null };
  }
}

/** A folder's own sign of its package manager: Corepack's `packageManager` field wins, then a lockfile. */
function declaredPackageManager(dir: string, pkg: PackageJson | null): PackageManager | null {
  const declared = pkg?.packageManager?.split('@')[0];
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared;
  for (const [file, manager] of LOCKFILES) {
    if (fs.existsSync(path.join(dir, file))) return manager;
  }
  return null;
}

/**
 * The package manager of the nearest folder that names one, from `root` up to the repository's root (the folder
 * holding `.git`): a workspace package names none, its workspace's root does. Else npm.
 */
function detectPackageManager(root: string, pkg: PackageJson | null): PackageManager {
  let dir = root;
  let dirPkg = pkg;
  for (;;) {
    const manager = declaredPackageManager(dir, dirPkg);
    if (manager) return manager;
    const parent = path.dirname(dir);
    if (parent === dir || fs.existsSync(path.join(dir, '.git'))) return 'npm';
    dir = parent;
    dirPkg = readPackageJson(dir).pkg;
  }
}

function findConfig(root: string): string | null {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** `.js`/`.mjs`/`.cjs` configs are JavaScript; everything else is treated as TypeScript. */
function langOf(configPath: string | null): ConfigLang {
  if (!configPath) return 'ts';
  return /\.[cm]?js$/.test(configPath) ? 'js' : 'ts';
}

/** Unscoped, filesystem-safe project name: `@acme/checkout` → `checkout`. */
function suggestProjectName(root: string, pkg: PackageJson | null): string {
  const fromPkg = pkg?.name?.replace(/^@[^/]+\//, '').trim();
  return fromPkg || path.basename(root) || 'default-project';
}

function hasReporter(pkg: PackageJson | null): boolean {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[REPORTER_PACKAGE] || pkg.devDependencies?.[REPORTER_PACKAGE]);
}

export function detectProject(root: string): ProjectShape {
  const absRoot = path.resolve(root);
  const { pkg, pkgPath } = readPackageJson(absRoot);
  const configPath = findConfig(absRoot);
  return {
    root: absRoot,
    packageJson: pkg,
    packageJsonPath: pkgPath,
    packageManager: detectPackageManager(absRoot, pkg),
    configPath,
    configLang: langOf(configPath),
    reporterInstalled: hasReporter(pkg),
    suggestedProjectName: suggestProjectName(absRoot, pkg),
  };
}

/** The shell command that adds the reporter as a dev dependency, per manager. */
export function installCommand(manager: PackageManager): string {
  switch (manager) {
    case 'pnpm':
      return `pnpm add -D ${REPORTER_PACKAGE}`;
    case 'yarn':
      return `yarn add -D ${REPORTER_PACKAGE}`;
    case 'bun':
      return `bun add -d ${REPORTER_PACKAGE}`;
    case 'npm':
      return `npm install --save-dev ${REPORTER_PACKAGE}`;
  }
}

export { REPORTER_PACKAGE };
