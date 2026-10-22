import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { FullConfig } from '@playwright/test/reporter';
import {
  configFingerprint,
  configInputs,
  parseUseLine,
  readProjectOptions,
  ProjectOptionsError,
} from '../src/recorder/project-options';
import UseReporter from '../src/recorder/use-reporter';

const FIXTURE = path.join(__dirname, 'fixtures', 'record-project', 'playwright.config.ts');
const NODE_MODULES = path.join(__dirname, '..', '..', '..', 'node_modules');

let dir = '';
let reporter = '';

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-options-')));
  // The reporter as `editor:build` bundles it: one CommonJS file Playwright loads by its path.
  reporter = path.join(dir, 'piwi-use-reporter.cjs');
  await build({
    entryPoints: [path.join(__dirname, '..', 'src', 'recorder', 'use-reporter.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: reporter,
    logLevel: 'silent',
  });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A project folder that resolves this repository's Playwright. */
function project(name: string, config: string): string {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(NODE_MODULES, path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(root, 'playwright.config.ts'), config);
  return path.join(root, 'playwright.config.ts');
}

const LINE = `PIWI_USE ${JSON.stringify({
  configFile: '/work/playwright.config.ts',
  rootDir: '/work/tests',
  projects: [
    { name: 'chromium', testDir: '/work/tests', use: { baseURL: 'http://localhost:3000' } },
    { name: 'broken', testDir: 7, use: {} },
    { name: 'no use', testDir: '/work/tests' },
  ],
})}`;

describe('parseUseLine', () => {
  test('reads the reporter’s line among Playwright’s output, keeping the projects that parse', () => {
    expect(parseUseLine(`Listing tests:\r\n${LINE}\r\nTotal: 0 tests in 0 files\r\n`)).toEqual({
      configFile: '/work/playwright.config.ts',
      rootDir: '/work/tests',
      piwi: null,
      projects: [{ name: 'chromium', testDir: '/work/tests', use: { baseURL: 'http://localhost:3000' } }],
    });
  });

  test('null without a line, with a line that is not JSON, or with no project that parses', () => {
    expect(parseUseLine('Error: No tests found\n')).toBeNull();
    expect(parseUseLine('PIWI_USE {"configFile":')).toBeNull();
    expect(parseUseLine('PIWI_USE {"rootDir":"/w","projects":[{"name":1}]}')).toBeNull();
    expect(parseUseLine('PIWI_USE []')).toBeNull();
  });
});

describe('the reporter', () => {
  test('prints one line with each project’s options, without what JSON cannot hold', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cycle: Record<string, unknown> = { name: 'cycle' };
    cycle.self = cycle;
    try {
      const config = {
        configFile: '/work/playwright.config.ts',
        rootDir: '/work/tests',
        projects: [
          {
            name: 'chromium',
            testDir: '/work/tests',
            use: {
              baseURL: 'http://localhost:3000',
              viewport: { width: 1280, height: 720 },
              launchOptions: { args: ['--a', () => 0], slowMo: Number.NaN },
              fixture: [async () => {}, { scope: 'test' }],
              pattern: /x/,
              when: new Date(0),
              nested: cycle,
            },
          },
        ],
      } as unknown as FullConfig;
      const reporter = new UseReporter();
      expect(reporter.printsToStdio()).toBe(true);
      reporter.onBegin(config);
      expect(write).toHaveBeenCalledTimes(1);
      const line = String(write.mock.calls[0]![0]);
      expect(line.endsWith('\n')).toBe(true);
      expect(parseUseLine(line)!.projects[0]!.use).toEqual({
        baseURL: 'http://localhost:3000',
        viewport: { width: 1280, height: 720 },
        launchOptions: { args: ['--a', null] },
        fixture: [null, { scope: 'test' }],
        nested: { name: 'cycle' },
      });
    } finally {
      write.mockRestore();
    }
  });
});

describe('configInputs', () => {
  test('the config, the .env files up to the repository’s folder, and the local modules the config loads', () => {
    const repo = path.join(dir, 'inputs-repo');
    const e2e = path.join(repo, 'apps', 'e2e');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(e2e, 'support'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'shared'), { recursive: true });
    for (const file of [
      '.env',
      'apps/e2e/.env',
      'apps/e2e/.env.local',
      'apps/e2e/.envrc',
      'apps/e2e/base.ts',
      'apps/e2e/support/index.ts',
      'apps/e2e/users.json',
      'shared/config.ts',
    ]) {
      fs.writeFileSync(path.join(repo, file), '');
    }
    const config = path.join(e2e, 'playwright.config.ts');
    const text = [
      "import { defineConfig } from '@playwright/test';",
      "import base from './base';",
      "import { shared } from '../../shared/config.js';",
      "import './support';",
      "const users = require('./users.json');",
      "export { devices } from './missing';",
    ].join('\n');
    expect(configInputs(config, text)).toEqual([
      config,
      path.join(e2e, '.env'),
      path.join(e2e, '.env.local'),
      path.join(repo, '.env'),
      path.join(e2e, 'base.ts'),
      path.join(repo, 'shared', 'config.ts'),
      path.join(e2e, 'support', 'index.ts'),
      path.join(e2e, 'users.json'),
      path.join(e2e, 'missing'),
    ]);
  });

  test('the config’s folder alone outside a repository', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-outside-'));
    const nested = path.join(outside, 'e2e');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(outside, '.env'), '');
    fs.writeFileSync(path.join(nested, '.env'), '');
    const config = path.join(nested, 'playwright.config.ts');
    expect(configInputs(config, 'export default {};')).toEqual([config, path.join(nested, '.env')]);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('configFingerprint', () => {
  test('changes when a .env file appears, changes its size or its time, or goes', () => {
    const root = path.join(dir, 'fingerprint');
    fs.mkdirSync(root);
    const config = path.join(root, 'playwright.config.ts');
    fs.writeFileSync(config, 'export default {};\n');
    const first = configFingerprint(config);
    expect(configFingerprint(config)).toBe(first);
    fs.writeFileSync(path.join(root, '.env'), 'BASE_URL=http://localhost:3000\n');
    const withEnv = configFingerprint(config);
    expect(withEnv).not.toBe(first);
    const env = path.join(root, '.env');
    const when = fs.statSync(env).mtime;
    fs.writeFileSync(env, 'BASE_URL=http://localhost:40000\n');
    fs.utimesSync(env, when, when);
    const longer = configFingerprint(config);
    expect(longer).not.toBe(withEnv);
    fs.utimesSync(env, when, new Date(when.getTime() + 5_000));
    expect(configFingerprint(config)).not.toBe(longer);
    fs.rmSync(path.join(root, '.env'));
    expect(configFingerprint(config)).toBe(first);
    expect(configFingerprint(path.join(root, 'none.config.ts'))).toBeNull();
  });
});

describe('readProjectOptions', () => {
  test('runs the project’s own Playwright and reads each project’s resolved options', async () => {
    const options = await readProjectOptions(FIXTURE, reporter);
    expect(options.configFile).toBe(FIXTURE);
    expect(options.projects.map((p) => p.name)).toEqual(['desktop', 'mobile']);
    const [desktop, mobile] = options.projects;
    expect(desktop!.testDir).toBe(path.join(path.dirname(FIXTURE), 'specs'));
    expect(desktop!.use).toMatchObject({
      baseURL: 'http://127.0.0.1:4173/app/',
      testIdAttribute: 'data-test',
      viewport: { width: 1024, height: 700 },
      defaultBrowserType: 'chromium',
    });
    expect(mobile!.use).toMatchObject({
      baseURL: 'http://127.0.0.1:4173/app/',
      testIdAttribute: 'data-test',
      locale: 'fr-FR',
      isMobile: true,
      storageState: 'auth/user.json',
    });
    // Kept until the config changes.
    expect(readProjectOptions(FIXTURE, reporter)).toBe(readProjectOptions(FIXTURE, reporter));
  });

  test('reads a config reached through a linked folder from its real path, so Playwright loads once', async () => {
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-link-')), 'project');
    fs.symlinkSync(path.dirname(FIXTURE), link, 'dir');
    const options = await readProjectOptions(path.join(link, 'playwright.config.ts'), reporter);
    expect(options.configFile).toBe(fs.realpathSync.native(FIXTURE));
    expect(options.projects.map((p) => p.name)).toEqual(['desktop', 'mobile']);
  });

  test('reads Piwi’s section of the config as written, which Playwright hands to reporters', async () => {
    const config = project(
      'piwi-section',
      "export default { '@piwi': { codegen: { testSteps: 'page', tags: ['@recorded'], skip: () => 0 } } };\n",
    );
    expect((await readProjectOptions(config, reporter)).piwi).toEqual({
      codegen: { testSteps: 'page', tags: ['@recorded'] },
    });
    const without = project('no-piwi-section', 'export default {};\n');
    expect((await readProjectOptions(without, reporter)).piwi).toBeNull();
  });

  test('reads a config again once it changes', async () => {
    const config = project('changing', "export default { projects: [{ name: 'one' }] };\n");
    expect((await readProjectOptions(config, reporter)).projects.map((p) => p.name)).toEqual(['one']);
    fs.writeFileSync(config, "export default { projects: [{ name: 'one' }, { name: 'two' }] };\n");
    fs.utimesSync(config, new Date(), new Date(Date.now() + 5_000));
    expect((await readProjectOptions(config, reporter)).projects.map((p) => p.name)).toEqual(['one', 'two']);
  });

  test('reads a config again once a module it imports changes', async () => {
    const config = project('importing', "import base from './base';\nexport default base;\n");
    const base = path.join(path.dirname(config), 'base.ts');
    fs.writeFileSync(base, "export default { projects: [{ name: 'one' }] };\n");
    const first = readProjectOptions(config, reporter);
    expect((await first).projects.map((p) => p.name)).toEqual(['one']);
    expect(readProjectOptions(config, reporter)).toBe(first);
    fs.writeFileSync(base, "export default { projects: [{ name: 'one' }, { name: 'two' }] };\n");
    expect((await readProjectOptions(config, reporter)).projects.map((p) => p.name)).toEqual(['one', 'two']);
  });

  test('reads a config once whatever the spelling of its path, and again after five minutes', async () => {
    const config = project('spellings', 'export default {};\n');
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-spelling-')), 'project');
    fs.symlinkSync(path.dirname(config), link, 'dir');
    const first = readProjectOptions(config, reporter);
    expect(readProjectOptions(path.join(link, 'playwright.config.ts'), reporter)).toBe(first);
    await first;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 5 * 60_000 - 1_000);
      expect(readProjectOptions(config, reporter)).toBe(first);
      vi.setSystemTime(Date.now() + 2_000);
      const again = readProjectOptions(config, reporter);
      expect(again).not.toBe(first);
      expect(readProjectOptions(config, reporter)).toBe(again);
    } finally {
      vi.useRealTimers();
    }
  });

  test('fails with one sentence when Playwright is not installed', async () => {
    const root = path.join(dir, 'bare');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'playwright.config.ts'), 'export default {};\n');
    const failure = await readProjectOptions(path.join(root, 'playwright.config.ts'), reporter).catch((e) => e);
    expect(failure).toBeInstanceOf(ProjectOptionsError);
    expect(failure).toMatchObject({
      reason: 'playwright-missing',
      message: `Playwright is not installed in ${root}: run npm install there.`,
    });
  });

  test('fails with Playwright’s first line when it cannot read the config, and does not keep the failure', async () => {
    const config = project('broken', "throw new Error('No BASE_URL in the environment');\n");
    const failure = await readProjectOptions(config, reporter).catch((e) => e);
    expect(failure).toMatchObject({ reason: 'failed' });
    expect(failure.message).toMatch(
      /^Playwright could not read playwright\.config\.ts: .*No BASE_URL in the environment/,
    );
    fs.writeFileSync(config, 'export default {};\n');
    expect((await readProjectOptions(config, reporter)).projects).toHaveLength(1);
  });

  test('fails when Playwright takes too long', async () => {
    const config = project('slow', 'export default {};\n');
    const failure = await readProjectOptions(config, reporter, 50).catch((e) => e);
    expect(failure).toMatchObject({
      reason: 'timeout',
      message: 'Playwright did not read playwright.config.ts within 0.05 seconds.',
    });
  });
});
