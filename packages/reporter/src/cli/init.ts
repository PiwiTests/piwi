/**
 * `piwi init` — wire a Playwright project up to a Piwi Dashboard, deterministically.
 *
 * The command does the mechanical, error-prone parts of setup so an agent (or a
 * person) does not have to hand-edit config: install the reporter, wrap the
 * Playwright config, add the capture fixtures, record the connection in `.env`,
 * and drop the Piwi agent skills into the repo. Every action is reported as a
 * `StepResult`; `--json` prints them verbatim so an agent reads the outcomes and
 * finishes anything left as `manual`.
 *
 * It never fails destructively: an unrecognized config shape or a pre-existing
 * fixtures file becomes a `manual` step carrying the exact snippet to apply, not
 * a rewrite of a file the tool does not understand.
 *
 * Run at a workspace's root that holds no Playwright config, it wires the
 * workspace package that holds one, or the one the person picks when several
 * do; with nobody at a terminal to pick, it wires none and names them.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as tty from 'node:tty';
import { formatStep, type StepResult } from './report.js';
import {
  detectProject,
  installCommand,
  REPORTER_PACKAGE,
  workspacePackagesWithConfig,
  type PackageManager,
  type ProjectShape,
} from './detect.js';
import {
  ensureGitignoreEntry,
  fixturesContents,
  recordDevDependency,
  upsertEnvKeys,
  wrapPlaywrightConfig,
} from './configure.js';
import {
  ALL_SKILLS,
  findTemplatesDir,
  installSkills,
  readTemplatesVersion,
  WORKFLOW_SKILLS,
  DEFAULT_SKILLS_DIR,
} from './skills.js';
import { detectCi } from '../internal/support/ci.js';
import { runPackageManager } from '../internal/support/playwright-spawn.js';

const DEFAULT_SERVER_URL = 'http://localhost:3000';

/** Asks the person at the terminal one question: their answer, or null when they close the input. */
type Ask = (question: string) => Promise<string | null>;

/** The workspace `init` ran at the root of, which holds no Playwright config itself. */
interface WorkspaceChoice {
  /** Absolute path of the workspace's root. */
  root: string;
  /** Its packages that hold a Playwright config, relative to `root`. */
  packages: string[];
  /** The package `init` wires, or null when it wires none. */
  wired: string | null;
}

const DESKTOP_APP_MODES = ['prefer', 'fallback', 'off'] as const;
type DesktopAppMode = (typeof DESKTOP_APP_MODES)[number];

interface InitOptions {
  root: string;
  serverUrl: string;
  projectName: string;
  /** `--desktop-app`, as given: validated by `runInit`. */
  desktopApp: string | null;
  apiKey: string | null;
  /** Whether `apiKey` is the environment's `PIWI_API_KEY`, with no `--api-key` given. */
  apiKeyFromEnv: boolean;
  skillsDir: string;
  skillSlugs: ReadonlyArray<string>;
  install: boolean;
  force: boolean;
  dryRun: boolean;
  json: boolean;
  /** Only install skills; leave the Playwright config and env untouched. */
  skillsOnly: boolean;
  /** Configure the project but install no skills. */
  noSkills: boolean;
}

const USAGE = `
piwi init — wire a Playwright project up to a Piwi Dashboard

Usage:
  npx @piwitests/reporter init [options]

What it does (each step is idempotent and safe to re-run):
  - installs @piwitests/reporter as a dev dependency
  - wraps export default defineConfig(...) with wrapConfig(...)
  - creates the capture-fixtures file (tests/fixtures.ts)
  - records PIWI_* connection settings in .env / .env.example and .gitignore
  - installs the Piwi agent skills so your coding agent can use them

In a monorepo, run it in the package that holds the playwright.config, or pass
--cwd <package>. At a workspace root with no playwright.config of its own
("workspaces" in package.json, or pnpm-workspace.yaml), it wires the workspace
package that has one. When several have one, it asks which in a terminal; in CI,
without a terminal or with --json, it wires none and lists them.

Options:
  --server-url <url>   Dashboard URL to write into the config (env PIWI_DASHBOARD_URL,
                       default ${DEFAULT_SERVER_URL})
  --no-server-url      Write no URL into the config: the reporter finds the Piwi desktop
                       app running on this machine, or reads PIWI_DASHBOARD_URL
  --project <name>     Project name to report under (default: your package/folder name)
  --desktop-app <mode> Write desktopApp into the config: "prefer" sends local runs to the
                       Piwi desktop app while it runs, and CI runs to --server-url
  --api-key <key>      API key to write into .env (env PIWI_API_KEY), where the reporter
                       reads it; never into a .env git tracks or cannot say it does not,
                       nor through a link. Omit to keep it a .env.example placeholder you
                       fill in yourself.
  --cwd <path>         Project root to operate on (default: current directory)
  --skills <list>      Comma-separated skills to install, or "all" / "none"
                       (default: ${WORKFLOW_SKILLS.join(', ')})
  --skills-dir <path>  Directory to install skills into (default: ${DEFAULT_SKILLS_DIR})
  --skills-only        Only install skills; do not touch the config or env
  --no-skills          Configure the project but install no skills
  --no-install         Do not run the package manager; record the dependency only
  --force              Overwrite skill files that already exist
  --dry-run            Report every change without writing anything
  --json               Print the plan/result as JSON (for agents)
  -h, --help           Show this help

Skills: ${ALL_SKILLS.join(', ')}
`.trim();

function readOption(argv: string[], name: string): string | undefined {
  const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

/** Resolve `--skills` into a concrete slug list. `all`/`none` are special. */
function resolveSkillSlugs(raw: string | undefined): ReadonlyArray<string> {
  if (raw === undefined) return WORKFLOW_SKILLS;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'none') return [];
  if (trimmed === 'all') return ALL_SKILLS;
  return raw
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);
}

export function parseInitArgs(argv: string[], env: NodeJS.ProcessEnv, cwd: string): InitOptions {
  const root = path.resolve(cwd, readOption(argv, '--cwd') ?? '.');
  const detected = detectProject(root);
  const noServerUrl = argv.includes('--no-server-url');
  const flagKey = readOption(argv, '--api-key');
  return {
    root,
    serverUrl: noServerUrl
      ? ''
      : (readOption(argv, '--server-url') ?? env.PIWI_DASHBOARD_URL ?? DEFAULT_SERVER_URL).replace(/\/$/, ''),
    projectName: readOption(argv, '--project') ?? detected.suggestedProjectName,
    desktopApp: argv.includes('--desktop-app') ? (readOption(argv, '--desktop-app') ?? '') : null,
    // The desktop app needs no key, and a key with no URL keeps the reporter from finding it.
    apiKey: noServerUrl ? null : (flagKey ?? env.PIWI_API_KEY ?? null),
    apiKeyFromEnv: !noServerUrl && flagKey === undefined && Boolean(env.PIWI_API_KEY),
    skillsDir: readOption(argv, '--skills-dir') ?? DEFAULT_SKILLS_DIR,
    skillSlugs: resolveSkillSlugs(readOption(argv, '--skills')),
    install: !argv.includes('--no-install'),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    skillsOnly: argv.includes('--skills-only'),
    noSkills: argv.includes('--no-skills'),
  };
}

function readFileOr(file: string, fallback: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return fallback;
  }
}

/** Package-manager argv for adding the reporter as a dev dependency. */
function installArgv(manager: PackageManager): [string, string[]] {
  switch (manager) {
    case 'pnpm':
      return ['pnpm', ['add', '-D', REPORTER_PACKAGE]];
    case 'yarn':
      return ['yarn', ['add', '-D', REPORTER_PACKAGE]];
    case 'bun':
      return ['bun', ['add', '-d', REPORTER_PACKAGE]];
    case 'npm':
      return ['npm', ['install', '--save-dev', REPORTER_PACKAGE]];
  }
}

function stepInstallReporter(project: ProjectShape, opts: InitOptions): StepResult {
  const step = 'dependency';
  if (project.reporterInstalled)
    return { step, status: 'already', detail: `${REPORTER_PACKAGE} is already a dependency` };
  if (!project.packageJson)
    return {
      step,
      status: 'manual',
      detail: `No package.json here — run \`npm init\`, then \`${installCommand(project.packageManager)}\``,
    };
  if (!opts.install) return stepRecordReporter(project, opts);
  if (opts.dryRun) return { step, status: 'manual', detail: `Run \`${installCommand(project.packageManager)}\`` };

  const [command, args] = installArgv(project.packageManager);
  const status = runPackageManager(command, args, opts.root);
  if (status === 0) return { step, status: 'updated', detail: `Installed ${REPORTER_PACKAGE}` };
  return {
    step,
    status: 'error',
    detail: `\`${installCommand(project.packageManager)}\` failed (exit ${status ?? 'unknown'}) — install it by hand`,
  };
}

/**
 * `--no-install`: the reporter recorded in `package.json`'s `devDependencies`, at this package's version, for the
 * package manager to install with the project's other dependencies.
 */
function stepRecordReporter(project: ProjectShape, opts: InitOptions): StepResult {
  const step = 'dependency';
  const file = 'package.json';
  const version = readTemplatesVersion(findTemplatesDir(__dirname));
  const range = version === '0.0.0' ? 'latest' : `^${version}`;
  const pkgPath = project.packageJsonPath ?? path.join(project.root, file);
  const edit = recordDevDependency(readFileOr(pkgPath, ''), REPORTER_PACKAGE, range);
  if (edit.status === 'manual')
    return {
      step,
      file,
      status: 'manual',
      detail: `Could not read package.json — run \`${installCommand(project.packageManager)}\``,
    };
  if (edit.status === 'updated' && !opts.dryRun) fs.writeFileSync(pkgPath, edit.text);
  return {
    step,
    file,
    status: edit.status,
    detail:
      edit.status === 'updated'
        ? `Recorded ${REPORTER_PACKAGE} ${range} in devDependencies — run \`${project.packageManager} install\` to install it`
        : `${REPORTER_PACKAGE} is already a dependency`,
  };
}

function stepConfig(project: ProjectShape, opts: InitOptions): StepResult {
  const step = 'config';
  if (!project.configPath)
    return {
      step,
      status: 'manual',
      detail: 'No playwright.config found — create one, then re-run `npx @piwitests/reporter init`',
    };

  const rel = path.relative(project.root, project.configPath) || path.basename(project.configPath);
  const source = readFileOr(project.configPath, '');
  const desktopApp = (opts.desktopApp as DesktopAppMode | null) ?? undefined;
  const edit = wrapPlaywrightConfig(source, {
    serverUrl: opts.serverUrl,
    projectName: opts.projectName,
    desktopApp,
  });
  if (edit.status === 'updated' && !opts.dryRun) fs.writeFileSync(project.configPath, edit.text);
  if (
    edit.status === 'already' &&
    desktopApp &&
    !new RegExp(`\\bdesktopApp\\s*:\\s*['"\`]${desktopApp}['"\`]`).test(source)
  ) {
    return {
      step,
      file: rel,
      status: 'manual',
      detail: `The Piwi reporter is already wired in — add \`desktopApp: '${desktopApp}'\` to its options`,
    };
  }
  return { step, file: rel, status: edit.status, detail: edit.detail };
}

function stepFixtures(project: ProjectShape, opts: InitOptions): StepResult {
  const step = 'fixtures';
  const rel = path.join('tests', project.configLang === 'js' ? 'fixtures.js' : 'fixtures.ts');
  const dest = path.join(project.root, rel);

  if (fs.existsSync(dest)) {
    const current = readFileOr(dest, '');
    if (/piwiFixtures/.test(current))
      return { step, file: rel, status: 'already', detail: 'capture fixtures already set up' };
    return {
      step,
      file: rel,
      status: 'manual',
      detail:
        "A fixtures file exists — extend it: `import { piwiFixtures } from '@piwitests/reporter'` and `base.extend(piwiFixtures)`",
    };
  }

  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fixturesContents());
  }
  return {
    step,
    file: rel,
    status: 'created',
    detail: 'Created capture fixtures — import `test` from here in your specs',
  };
}

/** Whether git tracks a file: `unknown` when git gave no answer in a folder a repository holds. */
type GitTracking = 'tracked' | 'untracked' | 'unknown';

/**
 * Whether git tracks `file`, relative to `root`. Only git's own answer counts (`--error-unmatch` exits 0 or 1); when
 * git gives none (missing, not startable, or refusing the repository, as it refuses one another user owns), it is
 * `unknown` when `root` or a folder above it holds a `.git`, and `untracked` when none does.
 */
function gitTracking(root: string, file: string): GitTracking {
  const { status } = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (status === 0) return 'tracked';
  if (status === 1) return 'untracked';
  return inRepository(root) ? 'unknown' : 'untracked';
}

/** Whether `dir` or a folder above it holds a `.git`: a repository's folder, or the file of a worktree or submodule. */
function inRepository(dir: string): boolean {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    if (path.dirname(current) === current) return false;
  }
}

/** Why `init` writes no API key into the project's `.env`, and what to do with the key instead. */
interface EnvKeyBlock {
  why: string;
  instead: string;
}

const KEY_IN_ENVIRONMENT = 'set PIWI_API_KEY in the environment (in CI, as a secret)';

/**
 * What keeps the API key out of the `.env` in `root`, where a key written could be committed: git tracking it, git
 * giving no answer, or a `.env` that is a link (symbolic or hard), whose other file git is not asked about. Null when
 * nothing does.
 */
function envKeyBlock(root: string): EnvKeyBlock | null {
  const tracking = gitTracking(root, '.env');
  if (tracking === 'tracked') {
    return {
      why: 'git tracks .env',
      instead: `${KEY_IN_ENVIRONMENT}, or untrack the file with \`git rm --cached .env\``,
    };
  }
  if (tracking === 'unknown') {
    return {
      why: 'git did not say whether it tracks .env',
      instead: `${KEY_IN_ENVIRONMENT}, or make \`git ls-files .env\` work here`,
    };
  }
  const env = fs.lstatSync(path.join(root, '.env'), { throwIfNoEntry: false });
  if (env && (env.isSymbolicLink() || env.nlink > 1)) {
    return { why: '.env is a link', instead: `${KEY_IN_ENVIRONMENT}, or put a file of its own in place of the link` };
  }
  return null;
}

/** The `.env` steps; `envBlock` when the `.env` takes no key. */
function stepEnv(project: ProjectShape, opts: InitOptions, envBlock: EnvKeyBlock | null): StepResult[] {
  const results: StepResult[] = [];

  // Committed template: URL and a placeholder for the key, never a real secret.
  const examplePath = path.join(project.root, '.env.example');
  const example = upsertEnvKeys(readFileOr(examplePath, ''), [
    ['PIWI_DASHBOARD_URL', opts.serverUrl],
    ['PIWI_API_KEY', ''],
  ]);
  if (example.added.length && !opts.dryRun) fs.writeFileSync(examplePath, example.text);
  results.push({
    step: 'env',
    file: '.env.example',
    status: example.added.length ? 'updated' : 'already',
    detail: example.added.length ? `Recorded ${example.added.join(', ')}` : 'connection template already present',
  });

  // Only write a real .env when a key was actually supplied — otherwise the
  // placeholder in .env.example is the thing to fill in.
  if (opts.apiKey && envBlock && opts.apiKeyFromEnv) {
    results.push({
      step: 'env',
      file: '.env',
      status: 'already',
      detail: `PIWI_API_KEY is set in the environment, where the reporter reads it; ${envBlock.why}, so no key is written into it`,
    });
  } else if (opts.apiKey && envBlock) {
    results.push({
      step: 'env',
      file: '.env',
      status: 'manual',
      detail: `${envBlock.why}, so the API key is not written into it — ${envBlock.instead} and run init again`,
    });
  } else if (opts.apiKey) {
    const envPath = path.join(project.root, '.env');
    const entries: Array<[string, string]> = [['PIWI_API_KEY', opts.apiKey]];
    if (opts.serverUrl) entries.unshift(['PIWI_DASHBOARD_URL', opts.serverUrl]);
    const env = upsertEnvKeys(readFileOr(envPath, ''), entries);
    if (env.added.length && !opts.dryRun) fs.writeFileSync(envPath, env.text);
    results.push({
      step: 'env',
      file: '.env',
      status: env.added.length ? 'updated' : 'already',
      detail: env.added.length ? `Wrote ${env.added.join(', ')} (keep .env out of git)` : 'already set',
    });

    const gitignorePath = path.join(project.root, '.gitignore');
    const gitignore = ensureGitignoreEntry(readFileOr(gitignorePath, ''));
    if (gitignore.added && !opts.dryRun) fs.writeFileSync(gitignorePath, gitignore.text);
    results.push({
      step: 'gitignore',
      file: '.gitignore',
      status: gitignore.added ? 'updated' : 'already',
      detail: gitignore.added ? 'Added .env' : '.env already ignored',
    });
  }

  return results;
}

/** Guidance the user acts on after the mechanical steps, tailored to what happened. */
function nextSteps(opts: InitOptions, steps: StepResult[], envBlock: EnvKeyBlock | null): string[] {
  const out: string[] = [];
  if (!opts.apiKey && opts.serverUrl && envBlock) {
    out.push(
      'If your dashboard has authentication on, create an API key (Settings → Account → API keys). ' +
        `${envBlock.why}, so keep the key out of it: ${envBlock.instead}.`,
    );
  } else if (!opts.apiKey && opts.serverUrl) {
    out.push(
      'If your dashboard has authentication on, create an API key (Settings → Account → API keys) and ' +
        'put it in .env as PIWI_API_KEY: the reporter reads it from the .env next to your Playwright config. ' +
        'Keep .env out of git; in CI, set PIWI_API_KEY as a secret.',
    );
  }
  if (steps.some((s) => s.status === 'manual')) {
    out.push('Finish the steps marked [manual] above — each one carries the exact change to make.');
  }
  out.push('In your specs, import `test` (and `expect`) from your fixtures file instead of `@playwright/test`.');
  if (!opts.serverUrl) {
    out.push(
      'Run `npx playwright test` — the run appears in the Piwi desktop app while it is running. ' +
        'Elsewhere, set PIWI_DASHBOARD_URL to the dashboard the runs go to.',
    );
  } else if (opts.desktopApp === 'prefer') {
    out.push(
      `Run \`npx playwright test\` — the run appears in the Piwi desktop app while it is running, ` +
        `and at ${opts.serverUrl} on CI or with the app closed.`,
    );
  } else {
    out.push(`Run \`npx playwright test\` — the run should appear at ${opts.serverUrl}.`);
  }
  out.push(
    'For a machine-readable check, set PIWI_OUTPUT_FILE=piwi-run.json and read runUrl from that file after the run.',
  );
  return out;
}

/** One line typed in answer to `question`; null when the input closes first, or on Ctrl+C. */
export function askLine(
  question: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.once('close', () => resolve(null));
    rl.once('SIGINT', () => rl.close());
    rl.question(question, (answer) => {
      resolve(answer);
      rl.close();
    });
  });
}

/** How `init` asks the person at the terminal; null in CI, or when stdin or stdout is not a terminal. */
export function terminalAsk(env: NodeJS.ProcessEnv, isTerminal: (fd: number) => boolean = tty.isatty): Ask | null {
  if (detectCi(env) || !isTerminal(0) || !isTerminal(1)) return null;
  return (question) => askLine(question, process.stdin, process.stdout);
}

/** Asks which of the workspace packages to wire, by its number in the list; null when the person picks none. */
async function choosePackage(packages: string[], ask: Ask): Promise<string | null> {
  console.log(`\nNo playwright.config here, and ${packages.length} workspace packages have one:\n`);
  packages.forEach((pkg, index) => console.log(`  ${index + 1}. ${pkg}`));
  console.log('');
  for (;;) {
    const answer = (await ask(`Which one should init wire? [1-${packages.length}, Enter for none] `))?.trim();
    if (!answer) return null;
    const choice = Number(answer);
    if (Number.isInteger(choice) && choice >= 1 && choice <= packages.length) return packages[choice - 1];
  }
}

/**
 * At a workspace's root, the packages that hold a Playwright config and the one to wire: the only one; when several
 * do, the one the person picks, or none with nobody to ask. Null when no workspace package holds one.
 */
async function chooseWorkspacePackage(root: string, ask: Ask | null): Promise<WorkspaceChoice | null> {
  const packages = workspacePackagesWithConfig(root);
  if (!packages.length) return null;
  if (packages.length === 1) return { root, packages, wired: packages[0] };
  return { root, packages, wired: ask ? await choosePackage(packages, ask) : null };
}

/** The options for the workspace package at `root`: its project name, unless `--project` names one. */
function inPackage(opts: InitOptions, argv: string[], root: string): InitOptions {
  return { ...opts, root, projectName: readOption(argv, '--project') ?? detectProject(root).suggestedProjectName };
}

/** What `init` reports when it wires none of the workspace's packages: which hold a config, and how to pick one. */
function unwiredWorkspace(workspace: WorkspaceChoice, cwd: string): { step: StepResult; guidance: string[] } {
  const flags = workspace.packages.map(
    (pkg) => `\`--cwd ${path.relative(cwd, path.join(workspace.root, pkg)) || '.'}\``,
  );
  return {
    step: {
      step: 'config',
      status: 'manual',
      detail:
        `No playwright.config here; ${workspace.packages.length} workspace packages have one ` +
        `(${workspace.packages.join(', ')}) — run init again with \`--cwd <package>\` for the one to wire`,
    },
    guidance: [
      `Run the same command again with ${flags.slice(0, -1).join(', ')} or ${flags[flags.length - 1]}, ` +
        'for the package to wire.',
    ],
  };
}

/** Prints the steps and what to do next: as text, or as one JSON object under `--json`. */
function printOutcome(
  opts: InitOptions,
  project: ProjectShape,
  workspace: WorkspaceChoice | null,
  steps: StepResult[],
  guidance: string[],
): void {
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: opts.dryRun,
          project: {
            root: project.root,
            packageManager: project.packageManager,
            configPath: project.configPath ? path.relative(project.root, project.configPath) : null,
            projectName: opts.projectName,
            serverUrl: opts.serverUrl,
            desktopApp: opts.desktopApp,
          },
          ...(workspace ? { workspace } : {}),
          steps,
          nextSteps: guidance,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (workspace?.wired && workspace.packages.length === 1) {
    console.log(
      `\nNo playwright.config here, so init wires ${workspace.wired}, the one workspace package that has one.`,
    );
  }
  const where = workspace?.wired ? ` in ${workspace.wired}` : '';
  console.log(`\nPiwi setup${opts.dryRun ? ' (dry run — nothing written)' : ''} for "${opts.projectName}"${where}:\n`);
  for (const step of steps) console.log(formatStep(step));
  console.log('\nNext:');
  for (const line of guidance) console.log(`  • ${line}`);
  console.log('');
}

/**
 * Run `piwi init`. Returns the process exit code rather than calling exit. `ask` puts a question to the person at the
 * terminal; null when nobody is there to answer.
 */
export async function runInit(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  ask: Ask | null = terminalAsk(env),
): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }

  let opts = parseInitArgs(argv, env, cwd);
  if (opts.desktopApp !== null && !DESKTOP_APP_MODES.includes(opts.desktopApp as DesktopAppMode)) {
    console.error(`--desktop-app must be one of ${DESKTOP_APP_MODES.join(', ')} (got "${opts.desktopApp}")`);
    return 1;
  }
  let project = detectProject(opts.root);
  // Under --json the output is an agent's to read, so nobody is asked.
  const workspace =
    opts.skillsOnly || project.configPath ? null : await chooseWorkspacePackage(project.root, opts.json ? null : ask);
  if (workspace && !workspace.wired) {
    const { step, guidance } = unwiredWorkspace(workspace, cwd);
    printOutcome(opts, project, workspace, [step], guidance);
    return 0;
  }
  if (workspace?.wired) {
    opts = inPackage(opts, argv, path.join(workspace.root, workspace.wired));
    project = detectProject(opts.root);
  }
  const steps: StepResult[] = [];
  const envBlock = envKeyBlock(project.root);

  if (!opts.skillsOnly) {
    steps.push(stepInstallReporter(project, opts));
    steps.push(stepConfig(project, opts));
    steps.push(stepFixtures(project, opts));
    steps.push(...stepEnv(project, opts, envBlock));
  }

  if (!opts.noSkills && opts.skillSlugs.length) {
    steps.push(
      ...installSkills({
        templatesDir: findTemplatesDir(__dirname),
        root: opts.root,
        skillsDir: opts.skillsDir,
        slugs: opts.skillSlugs,
        force: opts.force,
        dryRun: opts.dryRun,
      }),
    );
  }

  printOutcome(opts, project, workspace, steps, nextSteps(opts, steps, envBlock));

  // A tool failure (e.g. the install command erroring) is worth a non-zero exit;
  // `manual` steps are expected outcomes, not failures.
  return steps.some((s) => s.status === 'error') ? 1 : 0;
}
