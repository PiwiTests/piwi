import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectProject, installCommand, workspacePackagesWithConfig } from '../src/cli/detect.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-detect-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, contents = '') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

describe('detectProject', () => {
  it('finds the TypeScript config and derives an unscoped project name', () => {
    write('package.json', JSON.stringify({ name: '@acme/checkout' }));
    write('playwright.config.ts');
    const shape = detectProject(root);
    expect(shape.configPath).toBe(path.join(root, 'playwright.config.ts'));
    expect(shape.configLang).toBe('ts');
    expect(shape.suggestedProjectName).toBe('checkout');
  });

  it('treats a .js config as JavaScript', () => {
    write('package.json', JSON.stringify({ name: 'app' }));
    write('playwright.config.js');
    expect(detectProject(root).configLang).toBe('js');
  });

  it('falls back to the folder name when package.json has no name', () => {
    write('package.json', JSON.stringify({}));
    expect(detectProject(root).suggestedProjectName).toBe(path.basename(root));
  });

  it('detects the reporter across dependencies and devDependencies', () => {
    write('package.json', JSON.stringify({ devDependencies: { '@piwitests/reporter': '^0.20.0' } }));
    expect(detectProject(root).reporterInstalled).toBe(true);
  });

  it('picks the package manager from a lockfile', () => {
    write('package.json', JSON.stringify({ name: 'app' }));
    write('pnpm-lock.yaml');
    expect(detectProject(root).packageManager).toBe('pnpm');
  });

  it('lets the corepack packageManager field win over a lockfile', () => {
    write('package.json', JSON.stringify({ name: 'app', packageManager: 'yarn@4.0.0' }));
    write('package-lock.json');
    expect(detectProject(root).packageManager).toBe('yarn');
  });

  it("reads a workspace package's package manager from its workspace's root", () => {
    write('package.json', JSON.stringify({ name: 'shop', private: true, packageManager: 'pnpm@9.12.0' }));
    write('pnpm-lock.yaml');
    write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    write('packages/e2e/package.json', JSON.stringify({ name: '@shop/e2e' }));
    write('packages/e2e/playwright.config.ts');
    const shape = detectProject(path.join(root, 'packages', 'e2e'));
    expect(shape.packageManager).toBe('pnpm');
    expect(installCommand(shape.packageManager)).toBe('pnpm add -D @piwitests/reporter');
    // A lockfile alone names it too, and the nearest folder that names one wins.
    write('apps/web/package.json', JSON.stringify({ name: 'web' }));
    write('apps/web/yarn.lock');
    write('apps/web/tests/e2e/package.json', JSON.stringify({ name: 'web-e2e' }));
    expect(detectProject(path.join(root, 'apps', 'web', 'tests', 'e2e')).packageManager).toBe('yarn');
  });

  it('looks no further up than the repository root', () => {
    write('yarn.lock');
    write('repo/.git/HEAD', 'ref: refs/heads/main\n');
    write('repo/package.json', JSON.stringify({ name: 'app' }));
    expect(detectProject(path.join(root, 'repo')).packageManager).toBe('npm');
  });

  it('defaults to npm and reports no config for a bare directory', () => {
    const shape = detectProject(root);
    expect(shape.packageManager).toBe('npm');
    expect(shape.configPath).toBeNull();
    expect(shape.packageJson).toBeNull();
  });
});

describe('workspacePackagesWithConfig', () => {
  it('lists the packages the workspaces globs name that hold a Playwright config', () => {
    write('package.json', JSON.stringify({ name: 'shop', workspaces: ['apps/*', './tools/**', '!tools/legacy'] }));
    write('apps/web/package.json', '{}');
    write('apps/web/playwright.config.ts');
    write('apps/api/package.json', '{}');
    // A folder with a config and no package.json is no package.
    write('apps/docs/playwright.config.ts');
    write('tools/e2e/smoke/package.json', '{}');
    write('tools/e2e/smoke/playwright.config.mjs');
    write('tools/legacy/package.json', '{}');
    write('tools/legacy/playwright.config.js');
    // A wildcard enters neither node_modules nor a dot folder.
    write('tools/node_modules/dep/package.json', '{}');
    write('tools/node_modules/dep/playwright.config.ts');
    write('tools/.cache/copy/package.json', '{}');
    write('tools/.cache/copy/playwright.config.ts');
    expect(workspacePackagesWithConfig(root)).toEqual(['apps/web', 'tools/e2e/smoke']);
  });

  it("reads Yarn's workspaces.packages and the packages of a pnpm-workspace.yaml", () => {
    write('package.json', JSON.stringify({ name: 'shop', workspaces: { packages: ['web'], nohoist: ['**/react'] } }));
    write('web/package.json', '{}');
    write('web/playwright.config.ts');
    expect(workspacePackagesWithConfig(root)).toEqual(['web']);

    write('package.json', JSON.stringify({ name: 'shop' }));
    write(
      'pnpm-workspace.yaml',
      '# The packages\npackages:\n  - \'apps/*\' # the apps\n  - "e2e"\n\ncatalog:\n  react: ^19.0.0\n',
    );
    write('apps/admin/package.json', '{}');
    write('apps/admin/playwright.config.cts');
    write('e2e/package.json', '{}');
    write('e2e/playwright.config.ts');
    expect(workspacePackagesWithConfig(root)).toEqual(['apps/admin', 'e2e']);

    write('pnpm-workspace.yaml', "packages: ['e2e', web]\n");
    expect(workspacePackagesWithConfig(root)).toEqual(['e2e', 'web']);
  });

  it('lists nothing in a folder that declares no workspace', () => {
    write('package.json', JSON.stringify({ name: 'app' }));
    write('packages/e2e/package.json', '{}');
    write('packages/e2e/playwright.config.ts');
    expect(workspacePackagesWithConfig(root)).toEqual([]);
  });
});

describe('installCommand', () => {
  it('names the reporter as a dev dependency for each manager', () => {
    expect(installCommand('npm')).toBe('npm install --save-dev @piwitests/reporter');
    expect(installCommand('pnpm')).toBe('pnpm add -D @piwitests/reporter');
    expect(installCommand('yarn')).toBe('yarn add -D @piwitests/reporter');
    expect(installCommand('bun')).toBe('bun add -d @piwitests/reporter');
  });
});
