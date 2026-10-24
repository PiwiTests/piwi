import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseInitArgs, runInit } from '../src/cli/init.js';
import { WORKFLOW_SKILLS } from '../src/cli/skills.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-init-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function scaffoldProject() {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/checkout' }));
  fs.writeFileSync(
    path.join(root, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test'\n\nexport default defineConfig({\n  use: { trace: 'retain-on-failure' },\n})\n`,
  );
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
    const opts = parseInitArgs(
      [],
      { PIWI_DASHBOARD_URL: 'https://piwi.example.com/', PIWI_API_KEY: 'pd_x' } as NodeJS.ProcessEnv,
      root,
    );
    expect(opts.serverUrl).toBe('https://piwi.example.com');
    expect(opts.apiKey).toBe('pd_x');
  });

  it('resolves --skills all / none', () => {
    expect(parseInitArgs(['--skills', 'none'], EMPTY_ENV, root).skillSlugs).toEqual([]);
    expect(parseInitArgs(['--skills', 'all'], EMPTY_ENV, root).skillSlugs.length).toBeGreaterThan(
      WORKFLOW_SKILLS.length,
    );
  });
});

describe('runInit', () => {
  it('configures a clean project end to end (without installing) and returns 0', async () => {
    scaffoldProject();
    const code = await runInit(
      ['--no-install', '--server-url', 'https://piwi.example.com', '--project', 'checkout'],
      EMPTY_ENV,
      root,
    );
    expect(code).toBe(0);

    const config = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8');
    expect(config).toContain('wrapConfig(');
    expect(config).toContain("serverUrl: 'https://piwi.example.com',");

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
    expect(config.detail).toContain("serverUrl: 'https://piwi.example.com'");
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

  it('does not create a real .env when no key is given', async () => {
    scaffoldProject();
    await runInit(['--no-install'], EMPTY_ENV, root);
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it('under --dry-run writes nothing at all', async () => {
    scaffoldProject();
    const before = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf-8');
    await runInit(['--no-install', '--dry-run'], EMPTY_ENV, root);
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
