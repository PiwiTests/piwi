import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { askLine, parseInitArgs, runInit, terminalAsk } from '../src/cli/init.js';
import { WORKFLOW_SKILLS } from '../src/cli/skills.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-init-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const CONFIG = `import { defineConfig } from '@playwright/test'\n\nexport default defineConfig({\n  use: { trace: 'retain-on-failure' },\n})\n`;

function scaffoldProject() {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/checkout' }));
  fs.writeFileSync(path.join(root, 'playwright.config.ts'), CONFIG);
}

function write(rel: string, contents = '') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** Every file under `dir`, by its `/`-separated path relative to `root`, with its contents. */
function snapshot(dir = root): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(file));
    else files[path.relative(root, file).split(path.sep).join('/')] = fs.readFileSync(file, 'utf-8');
  }
  return files;
}

/** The files of a snapshot outside the folder `rel`. */
function outside(files: Record<string, string>, rel: string): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([file]) => !file.startsWith(`${rel}/`)));
}

function captureLogs(): string[] {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.join(' ')));
  return logs;
}

describe('parseInitArgs', () => {
  it('defaults the server URL, and derives the project name from package.json', () => {
    scaffoldProject();
    const opts = parseInitArgs([], EMPTY_ENV, root);
    expect(opts.serverUrl).toBe('http://localhost:3000');
    expect(opts.projectName).toBe('checkout');
    expect(opts.skillSlugs).toEqual([...WORKFLOW_SKILLS]);
  });

  it('reads the server URL and key from the environment and strips a trailing slash', () => {
    const opts = parseInitArgs([], { PIWI_DASHBOARD_URL: 'https://piwi.example.com/', PIWI_API_KEY: 'pd_x' } as NodeJS.ProcessEnv, root);
    expect(opts.serverUrl).toBe('https://piwi.example.com');
    expect(opts.apiKey).toBe('pd_x');
    expect(opts.apiKeyFromEnv).toBe(true);
    const flag = parseInitArgs(['--api-key', 'pd_y'], { PIWI_API_KEY: 'pd_x' } as NodeJS.ProcessEnv, root);
    expect(flag).toMatchObject({ apiKey: 'pd_y', apiKeyFromEnv: false });
  });

  it('resolves --skills all / none', () => {
    expect(parseInitArgs(['--skills', 'none'], EMPTY_ENV, root).skillSlugs).toEqual([]);
    expect(parseInitArgs(['--skills', 'all'], EMPTY_ENV, root).skillSlugs.length).toBeGreaterThan(WORKFLOW_SKILLS.length);
  });
});

describe('runInit', () => {
  it('configures a clean project end to end (without installing) and returns 0', async () => {
    scaffoldProject();
    const code = await runInit(['--no-install', '--server-url', 'https://piwi.example.com', '--project', 'checkout'], EMPTY_ENV, root);
    expect(code).toBe(0);

    const config = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8');
    expect(config).toContain('wrapConfig(');
    expect(config).toContain("serverUrl: process.env.PIWI_DASHBOARD_URL || 'https://piwi.example.com',");

    expect(fs.existsSync(path.join(root, 'tests', 'fixtures.ts'))).toBe(true);

    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf-8');
    expect(example).toContain('PIWI_DASHBOARD_URL=https://piwi.example.com');
    expect(example).toContain('PIWI_API_KEY=');

    // Workflow skills land in the repo.
    for (const slug of WORKFLOW_SKILLS) {
      expect(fs.existsSync(path.join(root, '.claude', 'skills', slug, 'SKILL.md'))).toBe(true);
    }
  });

  it('writes desktopApp into the config with --desktop-app', async () => {
    scaffoldProject();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await runInit(
      ['--no-install', '--no-skills', '--server-url', 'https://piwi.example.com', '--desktop-app', 'prefer'],
      EMPTY_ENV,
      root,
    );
    expect(code).toBe(0);
    const config = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8');
    expect(config).toContain("desktopApp: 'prefer',");
  });

  it('asks for desktopApp by hand when the reporter is already wired in', async () => {
    scaffoldProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInit(['--no-install', '--no-skills'], EMPTY_ENV, root);
    log.mockClear();
    await runInit(['--no-install', '--no-skills', '--desktop-app', 'prefer', '--json'], EMPTY_ENV, root);
    const plan = JSON.parse(String(log.mock.calls[0]?.[0]));
    const config = plan.steps.find((step: { step: string }) => step.step === 'config');
    expect(config.status).toBe('manual');
    expect(config.detail).toContain("desktopApp: 'prefer'");

    // A config already set to another mode still needs the change.
    const configPath = path.join(root, 'playwright.config.ts');
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, 'utf-8').replace('projectName:', "desktopApp: 'off',\n    projectName:"),
    );
    log.mockClear();
    await runInit(['--no-install', '--no-skills', '--desktop-app', 'prefer', '--json'], EMPTY_ENV, root);
    const again = JSON.parse(String(log.mock.calls[0]?.[0])).steps.find(
      (step: { step: string }) => step.step === 'config',
    );
    expect(again.status).toBe('manual');
  });

  it('writes no server URL and no key with --no-server-url, so the reporter finds the desktop app', async () => {
    scaffoldProject();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = { PIWI_DASHBOARD_URL: 'https://piwi.example.com', PIWI_API_KEY: 'pd_team' } as NodeJS.ProcessEnv;
    await runInit(['--no-install', '--no-skills', '--no-server-url', '--api-key', 'pd_secret'], env, root);
    const config = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8');
    expect(config).toContain('wrapConfig(');
    expect(config).not.toContain('serverUrl');
    // A key with no URL would keep the reporter from adopting the desktop app.
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    expect(log.mock.calls.flat().join('\n')).not.toContain('create an API key');
  });

  it('keeps the chosen options in the manual step for a config it cannot wrap', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.writeFileSync(path.join(root, 'playwright.config.ts'), 'module.exports = { testDir: "./tests" }\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInit(
      ['--no-install', '--no-skills', '--server-url', 'https://piwi.example.com', '--desktop-app', 'prefer', '--json'],
      EMPTY_ENV,
      root,
    );
    const plan = JSON.parse(String(log.mock.calls[0]?.[0]));
    const config = plan.steps.find((step: { step: string }) => step.step === 'config');
    expect(config.status).toBe('manual');
    expect(config.detail).toContain("serverUrl: process.env.PIWI_DASHBOARD_URL || 'https://piwi.example.com'");
    expect(config.detail).toContain("desktopApp: 'prefer'");
  });

  it('refuses an unknown or missing --desktop-app mode', async () => {
    scaffoldProject();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runInit(['--no-install', '--desktop-app', '--json'], EMPTY_ENV, root)).toBe(1);
    expect(await runInit(['--no-install', '--desktop-app', 'always'], EMPTY_ENV, root)).toBe(1);
    const config = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8');
    expect(config).not.toContain('wrapConfig');
  });

  it('writes a real .env and gitignores it only when an API key is supplied', async () => {
    scaffoldProject();
    await runInit(['--no-install', '--api-key', 'pd_secret'], EMPTY_ENV, root);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf-8')).toContain('PIWI_API_KEY=pd_secret');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8')).toContain('.env');
  });

  it('writes no key into a .env git tracks, and says what to do instead', async () => {
    scaffoldProject();
    write('.env', 'BASE_URL=http://localhost:5173\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('add', '.env');
    const logs = captureLogs();
    expect(await runInit(['--no-install', '--no-skills', '--api-key', 'pd_secret'], EMPTY_ENV, root)).toBe(0);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf-8')).toBe('BASE_URL=http://localhost:5173\n');
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    const output = logs.join('\n');
    expect(output).not.toContain('pd_secret');
    expect(output).toContain('! [manual] env .env — git tracks .env, so the API key is not written into it');
    expect(output).toContain('set PIWI_API_KEY in the environment (in CI, as a secret)');
    expect(output).toContain('`git rm --cached .env`');
    // The rest of the setup goes on.
    expect(fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8')).toContain('wrapConfig(');
    expect(fs.readFileSync(path.join(root, '.env.example'), 'utf-8')).toContain('PIWI_API_KEY=');

    // Without a key, the guidance does not send one into the tracked .env either.
    logs.length = 0;
    await runInit(['--no-install', '--no-skills'], EMPTY_ENV, root);
    expect(logs.join('\n')).toContain('git tracks .env, so keep the key out of it');
    expect(logs.join('\n')).not.toContain('put it in .env');

    // With the key in the environment, as the manual step says, the step is done.
    logs.length = 0;
    await runInit(['--no-install', '--no-skills'], { PIWI_API_KEY: 'pd_secret' } as NodeJS.ProcessEnv, root);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf-8')).toBe('BASE_URL=http://localhost:5173\n');
    expect(logs.join('\n')).toContain(
      '= [already] env .env — PIWI_API_KEY is set in the environment, where the reporter reads it; git tracks .env',
    );
    expect(logs.join('\n')).not.toContain('[manual]');
    expect(logs.join('\n')).not.toContain('pd_secret');

    // Untracked, the key goes into it.
    git('rm', '-q', '--cached', '.env');
    await runInit(['--no-install', '--no-skills', '--api-key', 'pd_secret'], EMPTY_ENV, root);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf-8')).toContain('PIWI_API_KEY=pd_secret');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8')).toContain('.env');
  });

  it('writes no key into the .env of a repository when git gives no answer, and one with no repository', async () => {
    scaffoldProject();
    write('.env', 'BASE_URL=http://localhost:5173\n');
    // A .git git cannot open: it answers with an error, as it does for a repository it does not trust.
    write('.git', `gitdir: ${path.join(root, 'missing')}\n`);
    const logs = captureLogs();
    expect(await runInit(['--no-install', '--no-skills', '--api-key', 'pd_secret'], EMPTY_ENV, root)).toBe(0);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf-8')).toBe('BASE_URL=http://localhost:5173\n');
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
    expect(logs.join('\n')).toContain(
      '! [manual] env .env — git did not say whether it tracks .env, so the API key is not written into it',
    );
    expect(logs.join('\n')).toContain('make `git ls-files .env` work here');

    // Without git to ask, the repository's .git alone keeps the key out.
    fs.rmSync(path.join(root, '.git'));
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    vi.stubEnv('PATH', path.join(root, 'no-git-here'));
    logs.length = 0;
    await runInit(['--no-install', '--no-skills', '--api-key', 'pd_secret'], EMPTY_ENV, root);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf-8')).not.toContain('pd_secret');
    expect(logs.join('\n')).toContain('git did not say whether it tracks .env');

    // With no repository, the key goes into it.
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    await runInit(['--no-install', '--no-skills', '--api-key', 'pd_secret'], EMPTY_ENV, root);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf-8')).toContain('PIWI_API_KEY=pd_secret');
  });

  it('writes no key through a .env that is a link', async () => {
    write('shared.env', 'BASE_URL=http://localhost:5173\n');
    const project = path.join(root, 'e2e');
    write('e2e/package.json', JSON.stringify({ name: 'e2e' }));
    write('e2e/playwright.config.ts', CONFIG);
    try {
      fs.symlinkSync(path.join('..', 'shared.env'), path.join(project, '.env'));
    } catch {
      return; // creating a link needs a privilege some systems do not grant
    }
    const logs = captureLogs();
    expect(await runInit(['--no-install', '--no-skills', '--api-key', 'pd_secret'], EMPTY_ENV, project)).toBe(0);
    expect(fs.readFileSync(path.join(root, 'shared.env'), 'utf-8')).toBe('BASE_URL=http://localhost:5173\n');
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
    expect(logs.join('\n')).toContain('! [manual] env .env — .env is a link, so the API key is not written into it');

    // A hard link is another name of the same file.
    fs.rmSync(path.join(project, '.env'));
    fs.linkSync(path.join(root, 'shared.env'), path.join(project, '.env'));
    await runInit(['--no-install', '--no-skills', '--api-key', 'pd_secret'], EMPTY_ENV, project);
    expect(fs.readFileSync(path.join(root, 'shared.env'), 'utf-8')).toBe('BASE_URL=http://localhost:5173\n');
  });

  it('does not create a real .env when no key is given', async () => {
    scaffoldProject();
    await runInit(['--no-install'], EMPTY_ENV, root);
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it('records the reporter in package.json under --no-install, for the package manager to install', async () => {
    scaffoldProject();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    expect(await runInit(['--no-install', '--no-skills', '--json'], EMPTY_ENV, root)).toBe(0);
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    expect(pkg).toEqual({ name: '@acme/checkout', devDependencies: { '@piwitests/reporter': `^${version}` } });
    const step = JSON.parse(logs.join('\n')).steps.find((s: { step: string }) => s.step === 'dependency');
    expect(step).toMatchObject({ file: 'package.json', status: 'updated' });
    expect(step.detail).toContain('run `npm install` to install it');

    // Run again, it finds the dependency recorded.
    logs.length = 0;
    await runInit(['--no-install', '--no-skills', '--json'], EMPTY_ENV, root);
    expect(JSON.parse(logs.join('\n')).steps.find((s: { step: string }) => s.step === 'dependency').status).toBe('already');
  });

  it('under --dry-run writes nothing at all', async () => {
    scaffoldProject();
    const before = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8');
    const pkgBefore = fs.readFileSync(path.join(root, 'package.json'), 'utf-8');
    await runInit(['--no-install', '--dry-run'], EMPTY_ENV, root);
    expect(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).toBe(pkgBefore);
    expect(fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(root, 'tests', 'fixtures.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.env.example'))).toBe(false);
  });

  it('emits a machine-readable plan under --json', async () => {
    scaffoldProject();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    await runInit(['--no-install', '--dry-run', '--json'], EMPTY_ENV, root);
    const payload = JSON.parse(logs.join('\n'));
    expect(payload.dryRun).toBe(true);
    expect(payload.project.projectName).toBe('checkout');
    expect(Array.isArray(payload.steps)).toBe(true);
    expect(payload.steps.find((s: { step: string }) => s.step === 'config')).toBeTruthy();
    expect(Array.isArray(payload.nextSteps)).toBe(true);
  });

  it('reports config as manual (and does not throw) when there is no defineConfig export', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.writeFileSync(path.join(root, 'playwright.config.ts'), 'export default { use: {} }\n');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    const code = await runInit(['--no-install', '--json'], EMPTY_ENV, root);
    expect(code).toBe(0);
    const payload = JSON.parse(logs.join('\n'));
    const configStep = payload.steps.find((s: { step: string }) => s.step === 'config');
    expect(configStep.status).toBe('manual');
  });

  it('installs only skills under --skills-only, leaving the config untouched', async () => {
    scaffoldProject();
    const before = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8');
    await runInit(['--skills-only'], EMPTY_ENV, root);
    expect(fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(root, '.env.example'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.claude', 'skills', WORKFLOW_SKILLS[0], 'SKILL.md'))).toBe(true);
  });

  it('exits 0 for --help', async () => {
    expect(await runInit(['--help'], EMPTY_ENV, root)).toBe(0);
  });
});

describe('runInit at a workspace root with no playwright.config', () => {
  it('wires the one workspace package that has a playwright.config, and says which', async () => {
    write('package.json', JSON.stringify({ name: 'shop', private: true, packageManager: 'pnpm@9.12.0' }));
    write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
    write('apps/web/package.json', JSON.stringify({ name: '@shop/web' }));
    write('packages/e2e/package.json', JSON.stringify({ name: '@shop/e2e' }));
    write('packages/e2e/playwright.config.ts', CONFIG);
    const e2e = path.join(root, 'packages', 'e2e');
    const before = snapshot();
    const logs = captureLogs();
    const ask = vi.fn();

    // --dry-run plans the package's setup and writes nothing.
    expect(await runInit(['--no-install', '--dry-run', '--json'], EMPTY_ENV, root, ask)).toBe(0);
    const plan = JSON.parse(logs.join('\n'));
    expect(plan.workspace).toEqual({ root, packages: ['packages/e2e'], wired: 'packages/e2e' });
    expect(plan.project).toMatchObject({
      root: e2e,
      packageManager: 'pnpm',
      configPath: 'playwright.config.ts',
      projectName: 'e2e',
    });
    expect(snapshot()).toEqual(before);

    logs.length = 0;
    expect(await runInit(['--no-install', '--no-skills', '--api-key', 'pd_secret'], EMPTY_ENV, root, ask)).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    const output = logs.join('\n');
    expect(output).toContain('init wires packages/e2e, the one workspace package that has one');
    expect(output).toContain('Piwi setup for "e2e" in packages/e2e:');
    // The package manager is the workspace root's.
    expect(output).toContain('run `pnpm install` to install it');
    expect(fs.readFileSync(path.join(e2e, 'playwright.config.ts'), 'utf-8')).toContain("projectName: 'e2e',");
    expect(fs.existsSync(path.join(e2e, 'tests', 'fixtures.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(e2e, '.env'), 'utf-8')).toContain('PIWI_API_KEY=pd_secret');
    const pkg = JSON.parse(fs.readFileSync(path.join(e2e, 'package.json'), 'utf-8'));
    expect(pkg.devDependencies).toHaveProperty('@piwitests/reporter');
    // The workspace's root and its other packages are left as they were.
    expect(outside(snapshot(), 'packages/e2e')).toEqual(outside(before, 'packages/e2e'));
  });

  it('asks which workspace package to wire in an interactive terminal', async () => {
    write('package.json', JSON.stringify({ name: 'shop', private: true, workspaces: ['apps/*'] }));
    write('package-lock.json', '{}');
    write('apps/admin/package.json', JSON.stringify({ name: 'admin' }));
    write('apps/admin/playwright.config.ts', CONFIG);
    write('apps/web/package.json', JSON.stringify({ name: 'web' }));
    write('apps/web/playwright.config.ts', CONFIG);
    const before = snapshot();
    const logs = captureLogs();
    const questions: string[] = [];
    const answers = ['', '3', ' 2 '];
    const ask = async (question: string) => {
      questions.push(question);
      return answers.shift() ?? null;
    };

    // Enter picks none, and nothing changes.
    expect(await runInit(['--no-install', '--no-skills'], EMPTY_ENV, root, ask)).toBe(0);
    expect(logs.join('\n')).toContain('1. apps/admin');
    expect(logs.join('\n')).toContain('2. apps/web');
    expect(logs.join('\n')).toContain('`--cwd apps/admin` or `--cwd apps/web`');
    expect(snapshot()).toEqual(before);

    // An answer that is not in the list asks again.
    logs.length = 0;
    expect(await runInit(['--no-install', '--no-skills'], EMPTY_ENV, root, ask)).toBe(0);
    expect(questions).toEqual(Array(3).fill('Which one should init wire? [1-2, Enter for none] '));
    expect(logs.join('\n')).toContain('Piwi setup for "web" in apps/web:');
    expect(fs.readFileSync(path.join(root, 'apps', 'web', 'playwright.config.ts'), 'utf-8')).toContain(
      "projectName: 'web',",
    );
    expect(outside(snapshot(), 'apps/web')).toEqual(outside(before, 'apps/web'));
  });

  it('wires none of several without a terminal, in CI or under --json, names them and asks for --cwd', async () => {
    write('package.json', JSON.stringify({ name: 'shop', private: true, workspaces: { packages: ['packages/*'] } }));
    write('yarn.lock');
    write('packages/admin/package.json', JSON.stringify({ name: 'admin' }));
    write('packages/admin/playwright.config.ts', CONFIG);
    write('packages/web/package.json', JSON.stringify({ name: 'web' }));
    write('packages/web/playwright.config.ts', CONFIG);
    const before = snapshot();
    const logs = captureLogs();

    expect(await runInit(['--no-install'], EMPTY_ENV, root, null)).toBe(0);
    expect(snapshot()).toEqual(before);
    const output = logs.join('\n');
    expect(output).toContain('No playwright.config here; 2 workspace packages have one (packages/admin, packages/web)');
    expect(output).toContain('Run the same command again with `--cwd packages/admin` or `--cwd packages/web`');

    // The folders it names for --cwd are relative to the folder init runs from.
    logs.length = 0;
    await runInit(['--no-install', '--cwd', path.basename(root)], EMPTY_ENV, path.dirname(root), null);
    expect(logs.join('\n')).toContain(`\`--cwd ${path.join(path.basename(root), 'packages', 'admin')}\``);

    // Under --json, nobody is asked, even at a terminal.
    logs.length = 0;
    const ask = vi.fn();
    expect(await runInit(['--no-install', '--json'], EMPTY_ENV, root, ask)).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    const plan = JSON.parse(logs.join('\n'));
    expect(plan.workspace).toEqual({ root, packages: ['packages/admin', 'packages/web'], wired: null });
    expect(plan.steps).toEqual([expect.objectContaining({ step: 'config', status: 'manual' })]);
    expect(snapshot()).toEqual(before);

    // Nobody answers in CI, nor when stdin or stdout is not a terminal.
    expect(terminalAsk({ CI: 'true' } as NodeJS.ProcessEnv, () => true)).toBeNull();
    expect(terminalAsk(EMPTY_ENV, (fd) => fd !== 0)).toBeNull();
    expect(terminalAsk(EMPTY_ENV, (fd) => fd !== 1)).toBeNull();
    expect(terminalAsk(EMPTY_ENV, () => true)).toBeTypeOf('function');
  });

  it("keeps today's message when none of the workspace's packages has a playwright.config", async () => {
    write('package.json', JSON.stringify({ name: 'shop', private: true, workspaces: ['packages/*'] }));
    write('packages/lib/package.json', JSON.stringify({ name: 'lib' }));
    const logs = captureLogs();
    const ask = vi.fn();
    expect(await runInit(['--no-install', '--no-skills'], EMPTY_ENV, root, ask)).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    const output = logs.join('\n');
    expect(output).toContain('Piwi setup for "shop":');
    expect(output).toContain(
      '! [manual] config — No playwright.config found — create one, then re-run `npx @piwitests/reporter init`',
    );
  });
});

describe('askLine', () => {
  it('reads the line typed in answer, and null when the input closes first', async () => {
    const output = new PassThrough();
    const typed = new PassThrough();
    const answer = askLine('Which one? ', typed, output);
    typed.write('2\n');
    expect(await answer).toBe('2');
    expect(String(output.read())).toContain('Which one? ');

    const closed = new PassThrough();
    const none = askLine('Which one? ', closed, output);
    closed.end();
    expect(await none).toBeNull();
  });
});
