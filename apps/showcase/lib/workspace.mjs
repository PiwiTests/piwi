// The shop's repository: a copy of examples/sample-app made a git repository with two commits on `main`, the shop as
// it shipped (the suite green) and the checkout's redesign (`places an order` red), pushed to a bare `origin`. The
// developer's checkout is the folder VS Code opens; each "CI" run clones `origin` afresh. The packages a checkout
// needs come from this repository: the reporter, the Nitro integration and Playwright are linked into its
// `node_modules`, so the set runs the code of this commit and installs nothing.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
const SAMPLE = path.join(REPO_ROOT, 'examples', 'sample-app');

/** The project the shop reports to on the instance. */
export const PROJECT_NAME = 'acme-shop';

/** The page object and the spec the story edits, relative to the checkout. */
export const PAGE_OBJECT = 'tests/pages/checkout-page.ts';
export const SPEC = 'tests/shop.spec.ts';

/**
 * The shop's suite: the shop's spec, its fixtures and its page objects. The sample's other specs show the dashboard's
 * other features (some fail on purpose) and stay out, so a "CI" run runs the whole suite.
 */
const SHOP_SUITE = /^tests\/(shop\.spec\.ts|shop-fixtures\.ts|pages\/[^/]+\.ts)$/;

/** The developer, and the author of both commits: fictional. */
const AUTHOR = { name: 'Camille Durand', email: 'camille.durand@acme-shop.example' };

/** Where the shop serves itself during a run (`backends.ts`). */
export const SHOP_PORT = 4173;

/**
 * The places the test's browser and its debugging port take on the screen, read by the checkout's Playwright config
 * in a headed run, never under CI.
 */
export function headedConfig({ position, size, scale, cdpPort }) {
  return `import { defineConfig } from '@playwright/test';
import { wrapConfig } from '@piwitests/reporter';
import { baseConfig, piwiOptions } from './playwright.shared';

/**
 * The recommended setup: \`wrapConfig\` adds the Piwi reporter and chains its global setup, so the run shows on the
 * dashboard while your own global setup still runs. An action that finds nothing fails within 10 s, at its line, and
 * \`SLOW_MO\` slows every action down to watch a run.
 */
const slowMo = Number(process.env.SLOW_MO) || 0;

/** On this machine, a headed run's browser opens beside the editor, at its window's size, and takes a debugger. */
const besideTheEditor = process.env.CI
  ? []
  : [
      '--window-position=${position.x},${position.y}',
      '--window-size=${size.width},${size.height}',
      '--force-device-scale-factor=${scale}',
      '--remote-debugging-port=${cdpPort}',
    ];

export default wrapConfig(
  defineConfig(baseConfig, {
    // CI keeps the run's JSON report beside its output.
    reporter: process.env.CI ? [['list'], ['json', { outputFile: 'ci-report.json' }]] : [['list']],
    use: {
      actionTimeout: 10_000,
      ...(process.env.CI ? {} : { viewport: null }),
      launchOptions: { slowMo, args: besideTheEditor },
    },
  }),
  piwiOptions,
);
`;
}

/** The redesign: **Pay now** in place of **Place order**, and a required **I accept the terms** box above it. */
function redesign(dir) {
  const page = path.join(dir, 'web', 'pages', 'shop', 'checkout.html');
  const before = fs.readFileSync(page, 'utf8');
  const button = '      <button type="submit" class="primary">Place order</button>\n';
  if (!before.includes(button)) throw new Error(`the checkout page no longer has its button: ${page}`);
  fs.writeFileSync(
    page,
    before.replace(
      button,
      [
        '      <div class="field terms">',
        '        <input id="terms" name="terms" type="checkbox" required>',
        '        <label for="terms">I accept the terms</label>',
        '      </div>',
        '      <button type="submit" class="primary">Pay now</button>',
        '',
      ].join('\n'),
    ),
  );
  fs.appendFileSync(
    path.join(dir, 'web', 'assets', 'app.css'),
    '\n/* The terms to accept before paying */\n\n.terms {\n  grid-template-columns: auto 1fr;\n  align-items: center;\n}\n\n.terms input {\n  width: auto;\n  min-height: 0;\n}\n',
  );
}

function git(dir, args, env = {}) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: AUTHOR.name,
      GIT_AUTHOR_EMAIL: AUTHOR.email,
      GIT_COMMITTER_NAME: AUTHOR.name,
      GIT_COMMITTER_EMAIL: AUTHOR.email,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The packages a checkout links from this repository, by the name it imports them by. */
const LINKED = [
  '@playwright/test',
  'playwright',
  'playwright-core',
  '@piwitests/reporter',
  '@piwitests/instrumentation-nitro',
  'nitropack',
  'h3',
  'consola',
  'typescript',
  '@types/node',
];

/** Links the packages into `dir/node_modules`, with the two commands a run calls (`playwright`, `nitro`). */
function linkPackages(dir) {
  const modules = path.join(dir, 'node_modules');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  for (const name of LINKED) {
    const link = path.join(modules, name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join(REPO_ROOT, 'node_modules', name)), link, 'dir');
  }
  fs.symlinkSync('../@playwright/test/cli.js', path.join(modules, '.bin', 'playwright'));
  fs.symlinkSync('../nitropack/dist/cli/index.mjs', path.join(modules, '.bin', 'nitro'));
}

/** Clones `origin` into `dir` at `main` and links its packages. */
export function checkout(origin, dir) {
  git(path.dirname(dir), ['clone', '--quiet', '--branch', 'main', origin, dir]);
  linkPackages(dir);
  return dir;
}

/**
 * Builds the repository under `root`: `origin.git` holding both commits, and the developer's checkout at `main`
 * (`shop/`), with the `.env` that names the instance and the project. The test's browser takes `testBrowser`'s place.
 */
export function buildWorkspace(root, { instanceUrl, testBrowser }) {
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  const files = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: SAMPLE, encoding: 'utf8' })
    .split('\0')
    .filter(
      (file) =>
        file && !file.startsWith('backends/aspnetcore') && (!file.startsWith('tests/') || SHOP_SUITE.test(file)),
    );
  for (const file of files) {
    fs.mkdirSync(path.join(seed, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(SAMPLE, file), path.join(seed, file));
  }
  fs.writeFileSync(path.join(seed, 'playwright.config.ts'), headedConfig(testBrowser));
  git(seed, ['init', '--quiet', '--initial-branch=main']);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '--quiet', '-m', 'Shop: products, cart and checkout'], {
    GIT_AUTHOR_DATE: '2026-10-26T09:12:00+01:00',
    GIT_COMMITTER_DATE: '2026-10-26T09:12:00+01:00',
  });
  const shipped = git(seed, ['rev-parse', 'HEAD']);
  redesign(seed);
  git(seed, ['commit', '--quiet', '-am', 'Redesign the checkout: Pay now, and the terms to accept'], {
    GIT_AUTHOR_DATE: '2026-10-27T16:40:00+01:00',
    GIT_COMMITTER_DATE: '2026-10-27T16:40:00+01:00',
  });
  const redesigned = git(seed, ['rev-parse', 'HEAD']);
  const origin = path.join(root, 'origin.git');
  git(root, ['clone', '--quiet', '--bare', seed, origin]);
  fs.rmSync(seed, { recursive: true, force: true });
  const shop = checkout(origin, path.join(root, 'shop'));
  fs.writeFileSync(path.join(shop, '.env'), `PIWI_DASHBOARD_URL=${instanceUrl}\nPIWI_PROJECT_NAME=${PROJECT_NAME}\n`);
  return { origin, shop, shipped, redesigned };
}

/** A file of the developer's checkout, as it stands on disk. */
export function read(shop, file) {
  return fs.readFileSync(path.join(shop, file), 'utf8');
}

/** Commits what the developer changed and pushes it to `origin`, as the fix is pushed. */
export function push(shop, message) {
  git(shop, ['commit', '--quiet', '-am', message]);
  git(shop, ['push', '--quiet', 'origin', 'main']);
  return git(shop, ['rev-parse', 'HEAD']);
}

/** Moves a CI checkout's `main` to `commit`, as the branch stood when that commit was pushed. */
export function at(dir, commit) {
  git(dir, ['reset', '--quiet', '--hard', commit]);
}

export { git };
