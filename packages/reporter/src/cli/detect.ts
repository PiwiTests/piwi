/**
 * Read-only inspection of the target project so `init` knows what it is looking
 * at before it changes anything: which package manager runs there, where the
 * Playwright config lives, whether the reporter is already a dependency, a
 * sensible default project name, and, at a workspace's root, which of its
 * packages hold a Playwright config.
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
  /** npm, Yarn and Bun workspaces: a list of globs, or an object holding them in `packages`. */
  workspaces?: unknown;
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

/** The strings of a list, or an empty list when `value` is not one. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** A plain or quoted YAML scalar, without its trailing comment. */
function yamlScalar(text: string): string {
  const value = text.trim();
  const quoted = /^(['"])(.*?)\1/.exec(value);
  return quoted ? quoted[2]! : value.replace(/\s+#.*$/, '').trim();
}

/** The `packages` globs of a pnpm-workspace.yaml: a block list under the key, or a flow list beside it. */
function pnpmWorkspaceGlobs(yaml: string): string[] {
  const flow = /^packages\s*:\s*\[([^\]]*)\]/m.exec(yaml);
  if (flow) return flow[1]!.split(',').map(yamlScalar).filter(Boolean);
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages\s*:\s*(#.*)?$/.test(line));
  if (start === -1) return [];
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (!item) break;
    globs.push(yamlScalar(item[1]!));
  }
  return globs.filter(Boolean);
}

/** The globs naming a workspace's packages: `workspaces` in its package.json, and its pnpm-workspace.yaml's. */
function workspaceGlobs(root: string, pkg: PackageJson | null): string[] {
  const declared = pkg?.workspaces;
  const globs = stringList(
    typeof declared === 'object' && declared !== null && 'packages' in declared ? declared.packages : declared,
  );
  try {
    globs.push(...pnpmWorkspaceGlobs(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf-8')));
  } catch {
    // No pnpm-workspace.yaml.
  }
  return globs;
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The folders directly in `dir` a wildcard may enter: never node_modules, a dot folder or a symbolic link. */
function subfolders(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** A folder name pattern as a regular expression: `*` any run of characters, `?` one character. */
function namePattern(segment: string): RegExp {
  const source = segment
    .split(/([*?])/)
    .map((part) => (part === '*' ? '.*' : part === '?' ? '.' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`);
}

/** The folders under `root` a workspace glob names: `*` and `?` within one folder name, `**` any number of folders. */
function expandGlob(root: string, glob: string): string[] {
  const segments = glob.split('/').filter((segment) => segment !== '' && segment !== '.');
  const found: string[] = [];
  const walk = (dir: string, index: number): void => {
    if (index === segments.length) {
      found.push(dir);
      return;
    }
    const segment = segments[index]!;
    if (segment === '**') {
      walk(dir, index + 1);
      for (const child of subfolders(dir)) walk(child, index);
    } else if (/[*?]/.test(segment)) {
      const pattern = namePattern(segment);
      for (const child of subfolders(dir)) if (pattern.test(path.basename(child))) walk(child, index + 1);
    } else if (isDirectory(path.join(dir, segment))) {
      walk(path.join(dir, segment), index + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * The packages of the workspace whose root is `root` that hold a Playwright config, as `/`-separated paths relative to
 * `root`, sorted. A workspace is declared by `workspaces` in the root's package.json (npm, Yarn, Bun) or by a
 * pnpm-workspace.yaml; a glob starting with `!` leaves out the folders it names. Empty when `root` declares none.
 */
export function workspacePackagesWithConfig(root: string): string[] {
  const absRoot = path.resolve(root);
  const globs = workspaceGlobs(absRoot, readPackageJson(absRoot).pkg);
  const excluded = new Set(
    globs.filter((glob) => glob.startsWith('!')).flatMap((glob) => expandGlob(absRoot, glob.slice(1))),
  );
  const packages = new Set(
    globs
      .filter((glob) => !glob.startsWith('!'))
      .flatMap((glob) => expandGlob(absRoot, glob))
      .filter((dir) => dir !== absRoot && !excluded.has(dir) && fs.existsSync(path.join(dir, 'package.json'))),
  );
  return [...packages]
    .filter((dir) => findConfig(dir) !== null)
    .map((dir) => path.relative(absRoot, dir).split(path.sep).join('/'))
    .sort();
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
