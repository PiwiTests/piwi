#!/usr/bin/env node
// The oldest Playwright the reporter supports: the lower bound of @piwitests/reporter's peer range on
// @playwright/test. CI tests that version twice: `package-smoke.mjs --playwright floor` installs it next to the packed
// reporter, the way a user does, and the `reporter-floor` job runs the reporter's suite on it after `--install`. The
// same install puts another release in place: the `reporter-latest` job tests the latest one, and
// `playwright-next.yml` the next one.
//
// Usage:
//   node scripts/playwright-floor.mjs                      prints the floor
//   node scripts/playwright-floor.mjs latest               prints the version a release names: `floor`, a dist-tag
//                                                          (`latest`, `next`) or a version
//   node scripts/playwright-floor.mjs --install [release]  puts that version of @playwright/test, playwright and
//                                                          playwright-core in the root node_modules, in place of the
//                                                          locked ones, without touching package.json or
//                                                          package-lock.json (the floor by default)
//
// --install unpacks the three packages from the registry: each depends only on the next, so nothing else changes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const PLAYWRIGHT_PACKAGES = ['@playwright/test', 'playwright', 'playwright-core'];

/**
 * The lower bound of a `>=x.y.z <2` range, as `x.y.z`. Any other form fails, a caret range included: `^x.y.z` drops
 * every version below x.y.z, so it is never the reporter's peer range.
 */
export function rangeFloor(range) {
  const match = /^>=(\d+\.\d+\.\d+) <2$/.exec(range);
  if (!match) {
    throw new Error(
      `the reporter's peer range on @playwright/test is ${JSON.stringify(range)}: it must read ">=x.y.z <2", the oldest Playwright the reporter supports`,
    );
  }
  return match[1];
}

/** The oldest @playwright/test the reporter's package.json accepts. */
export function playwrightFloor() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/reporter/package.json'), 'utf8'));
  const range = manifest.peerDependencies?.['@playwright/test'];
  if (!range) throw new Error('packages/reporter/package.json has no peer dependency on @playwright/test');
  return rangeFloor(range);
}

/** The version a release names: `floor`, a dist-tag of @playwright/test (`latest`, `next`) or a version. */
export function playwrightRelease(release = 'floor') {
  if (release === 'floor') return playwrightFloor();
  if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release)) return release;
  if (!/^[a-z][a-z0-9-]*$/.test(release)) throw new Error(`not a Playwright release: ${JSON.stringify(release)}`);
  const view = spawnSync('npm', ['view', `@playwright/test@${release}`, 'version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const version = view.stdout.trim().split('\n').pop() ?? '';
  if (view.status !== 0 || !version) throw new Error(`npm view @playwright/test@${release} failed:\n${view.stderr}`);
  return version;
}

function install(version) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-floor-'));
  try {
    for (const name of PLAYWRIGHT_PACKAGES) {
      const pack = spawnSync('npm', ['pack', '--silent', `${name}@${version}`, '--pack-destination', work], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (pack.status !== 0) throw new Error(`npm pack ${name}@${version} failed:\n${pack.stderr}`);
      const tarball = path.join(work, pack.stdout.trim().split('\n').pop());
      const target = path.join(repoRoot, 'node_modules', name);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      const untar = spawnSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'], { encoding: 'utf8' });
      if (untar.status !== 0) throw new Error(`tar could not unpack ${tarball}:\n${untar.stderr}`);
      const installed = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version;
      if (installed !== version) throw new Error(`${name} unpacked as ${installed}, expected ${version}`);
      console.log(`[playwright-floor] ${name}@${version} in node_modules/${name}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Whether node runs this file, whatever path names it (a symlinked checkout's included), rather than importing it. */
function isMain() {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const installing = args[0] === '--install';
  const release = installing ? args[1] : args[0];
  const version = playwrightRelease(release);
  if (installing) install(version);
  else console.log(version);
}
