#!/usr/bin/env node
// The oldest Playwright the reporter supports: the lower bound of @piwitests/reporter's peer range on
// @playwright/test. CI tests that version twice: `package-smoke.mjs --playwright floor` installs it next to the packed
// reporter, the way a user does, and the `reporter-floor` job runs the reporter's suite on it after `--install`.
//
// Usage:
//   node scripts/playwright-floor.mjs            prints the version
//   node scripts/playwright-floor.mjs --install  puts that version of @playwright/test, playwright and playwright-core
//                                                in the root node_modules, in place of the locked ones, without
//                                                touching package.json or package-lock.json
//
// --install unpacks the three packages from the registry: each depends only on the next, so nothing else changes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const PLAYWRIGHT_PACKAGES = ['@playwright/test', 'playwright', 'playwright-core'];

/** The lower bound of a `>=x.y.z` or `^x.y.z` range, as `x.y.z`. */
export function rangeFloor(range) {
  const match = /^\s*(?:>=\s*|\^)(\d+\.\d+\.\d+)(?:\s|$)/.exec(range);
  if (!match) throw new Error(`cannot read a lower bound from the range ${JSON.stringify(range)}`);
  return match[1];
}

/** The oldest @playwright/test the reporter's package.json accepts. */
export function playwrightFloor() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/reporter/package.json'), 'utf8'));
  const range = manifest.peerDependencies?.['@playwright/test'];
  if (!range) throw new Error('packages/reporter/package.json has no peer dependency on @playwright/test');
  return rangeFloor(range);
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
  const version = playwrightFloor();
  if (process.argv.includes('--install')) install(version);
  else console.log(version);
}
