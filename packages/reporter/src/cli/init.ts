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
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatStep, type StepResult } from './report.js';
import { detectProject, installCommand, REPORTER_PACKAGE, type PackageManager, type ProjectShape } from './detect.js';
import { ensureGitignoreEntry, fixturesContents, upsertEnvKeys, wrapPlaywrightConfig } from './configure.js';
import { ALL_SKILLS, findTemplatesDir, installSkills, WORKFLOW_SKILLS, DEFAULT_SKILLS_DIR } from './skills.js';
import { runPackageManager } from '../internal/support/playwright-spawn.js';

const DEFAULT_SERVER_URL = 'http://localhost:3000';

const DESKTOP_APP_MODES = ['prefer', 'fallback', 'off'] as const;
type DesktopAppMode = (typeof DESKTOP_APP_MODES)[number];

interface InitOptions {
  root: string;
  serverUrl: string;
  projectName: string;
  /** `--desktop-app`, as given: validated by `runInit`. */
  desktopApp: string | null;
  apiKey: string | null;
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

Options:
  --server-url <url>   Dashboard URL to write into the config (env PIWI_DASHBOARD_URL,
                       default ${DEFAULT_SERVER_URL})
  --no-server-url      Write no URL into the config: the reporter finds the Piwi desktop
                       app running on this machine, or reads PIWI_DASHBOARD_URL
  --project <name>     Project name to report under (default: your package/folder name)
  --desktop-app <mode> Write desktopApp into the config: "prefer" sends local runs to the
                       Piwi desktop app while it runs, and CI runs to --server-url
  --api-key <key>      API key to write into .env (env PIWI_API_KEY), where the reporter
                       reads it. Omit to keep it a .env.example placeholder you fill in
                       yourself.
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
  const root = path.resolve(readOption(argv, '--cwd') ?? cwd);
  const detected = detectProject(root);
  return {
    root,
    serverUrl: argv.includes('--no-server-url')
      ? ''
      : (readOption(argv, '--server-url') ?? env.PIWI_DASHBOARD_URL ?? DEFAULT_SERVER_URL).replace(/\/$/, ''),
    projectName: readOption(argv, '--project') ?? detected.suggestedProjectName,
    desktopApp: argv.includes('--desktop-app') ? (readOption(argv, '--desktop-app') ?? '') : null,
    // The desktop app needs no key, and a key with no URL keeps the reporter from finding it.
    apiKey: argv.includes('--no-server-url') ? null : (readOption(argv, '--api-key') ?? env.PIWI_API_KEY ?? null),
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
  if (opts.dryRun || !opts.install)
    return { step, status: 'manual', detail: `Run \`${installCommand(project.packageManager)}\`` };

  const [command, args] = installArgv(project.packageManager);
  const status = runPackageManager(command, args, opts.root);
  if (status === 0) return { step, status: 'updated', detail: `Installed ${REPORTER_PACKAGE}` };
  return {
    step,
    status: 'error',
    detail: `\`${installCommand(project.packageManager)}\` failed (exit ${status ?? 'unknown'}) — install it by hand`,
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

function stepEnv(project: ProjectShape, opts: InitOptions): StepResult[] {
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
  if (opts.apiKey) {
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
function nextSteps(opts: InitOptions, steps: StepResult[]): string[] {
  const out: string[] = [];
  if (!opts.apiKey && opts.serverUrl) {
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

/** Run `piwi init`. Returns the process exit code rather than calling exit. */
export async function runInit(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }

  const opts = parseInitArgs(argv, env, cwd);
  if (opts.desktopApp !== null && !DESKTOP_APP_MODES.includes(opts.desktopApp as DesktopAppMode)) {
    console.error(`--desktop-app must be one of ${DESKTOP_APP_MODES.join(', ')} (got "${opts.desktopApp}")`);
    return 1;
  }
  const project = detectProject(opts.root);
  const steps: StepResult[] = [];

  if (!opts.skillsOnly) {
    steps.push(stepInstallReporter(project, opts));
    steps.push(stepConfig(project, opts));
    steps.push(stepFixtures(project, opts));
    steps.push(...stepEnv(project, opts));
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

  const guidance = nextSteps(opts, steps);

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
          steps,
          nextSteps: guidance,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`\nPiwi setup${opts.dryRun ? ' (dry run — nothing written)' : ''} for "${opts.projectName}":\n`);
    for (const step of steps) console.log(formatStep(step));
    console.log('\nNext:');
    for (const line of guidance) console.log(`  • ${line}`);
    console.log('');
  }

  // A tool failure (e.g. the install command erroring) is worth a non-zero exit;
  // `manual` steps are expected outcomes, not failures.
  return steps.some((s) => s.status === 'error') ? 1 : 0;
}
