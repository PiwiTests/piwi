import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromiumManifest, firefoxManifest, isReleaseBuild } from '../../scripts/build.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));

describe('the manifests the build writes', () => {
  it('keeps Firefox’s background script in the source manifest, which AMO requires', () => {
    expect(manifest.background).toEqual({ service_worker: 'background.js', scripts: ['background.js'] });
  });

  it('leaves it out for Chrome and Edge, and changes nothing else', () => {
    const chromium = chromiumManifest(manifest);
    expect(chromium.background).toEqual({ service_worker: 'background.js' });
    expect({ ...chromium, background: manifest.background }).toEqual(manifest);
  });

  it('asks Chrome and Edge for `debugger`, and never Firefox, which has no such API', () => {
    expect(chromiumManifest(manifest).permissions).toContain('debugger');
    const firefox = firefoxManifest(manifest);
    expect(firefox.permissions).not.toContain('debugger');
    expect(JSON.stringify(firefox)).not.toContain('debugger');
    expect({
      ...firefox,
      permissions: manifest.permissions,
      minimum_chrome_version: manifest.minimum_chrome_version,
      commands: manifest.commands,
    }).toEqual(manifest);
  });

  it('makes the run shortcut global in Chrome and Edge, on a key their rules let a global command suggest', () => {
    const command = chromiumManifest(manifest).commands['run-pause-resume'];
    expect(command.global).toBe(true);
    // Chrome assigns a global command's suggested key only on Ctrl+Shift+[0-9] (Command+Shift+[0-9] on macOS).
    expect(command.suggested_key.default).toMatch(/^Ctrl\+Shift\+[0-9]$/);
    expect(command.suggested_key.mac).toMatch(/^Command\+Shift\+[0-9]$/);
    // macOS takes Command+Shift+3 to 6 for its screenshots.
    expect(command.suggested_key.mac).not.toMatch(/\+[3-6]$/);
  });

  it('leaves `global` out of Firefox’s manifest, whose commands work while Firefox has the focus', () => {
    const firefox = firefoxManifest(manifest);
    expect(firefox.commands['run-pause-resume']).not.toHaveProperty('global');
    expect(firefox.commands['run-pause-resume'].suggested_key).toEqual(
      manifest.commands['run-pause-resume'].suggested_key,
    );
    expect(firefox.commands['pick-element']).toEqual(manifest.commands['pick-element']);
  });

  it('asks for Chrome or Edge 118 or later, which keep the worker running while a debugging session is attached', () => {
    expect(manifest.minimum_chrome_version).toBe('118');
    expect(chromiumManifest(manifest).minimum_chrome_version).toBe('118');
    // Firefox reads its floor from `strict_min_version` alone.
    expect(firefoxManifest(manifest)).not.toHaveProperty('minimum_chrome_version');
  });
});

describe('the build the store zips are made of', () => {
  it('is the release build of the manifest’s version, never a dev build stamped with its build time', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'piwi-zip-'));
    expect(isReleaseBuild(dir, '0.45.0')).toBe(false);
    writeFileSync(path.join(dir, 'background.js'), '(function(){var e=`2026-10-02T10:00:00.000Z`;})();');
    expect(isReleaseBuild(dir, '0.45.0')).toBe(false);
    writeFileSync(path.join(dir, 'background.js'), '(function(){var e=`v0.44.0`;})();');
    expect(isReleaseBuild(dir, '0.45.0')).toBe(false);
    // The minifier writes string literals in backticks.
    writeFileSync(path.join(dir, 'background.js'), '(function(){var e=`v0.45.0`;})();');
    expect(isReleaseBuild(dir, '0.45.0')).toBe(true);
    writeFileSync(path.join(dir, 'background.js'), '(function(){var e="v0.45.0";})();');
    expect(isReleaseBuild(dir, '0.45.0')).toBe(true);
  });
});
