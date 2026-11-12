/**
 * The bundle Piwi Runner builds is the desktop shell's `tauri.conf.json` with `runner.conf.json` merged over it. Tauri
 * merges a `--config` file as a JSON merge patch (RFC 7396): an object merges key by key, `null` removes a key and any
 * other value, an array included, replaces the one it meets.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function merge(target: Json, patch: Json): Json {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result: { [key: string]: Json } =
    target !== null && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = merge(result[key] ?? null, value);
  }
  return result;
}

const shell = path.join(__dirname, '..', '..', 'desktop', 'src-tauri');
const read = (file: string): Json => JSON.parse(fs.readFileSync(path.join(shell, file), 'utf8')) as Json;
const desktop = read('tauri.conf.json') as Record<string, any>;
const runner = merge(desktop, read('runner.conf.json')) as Record<string, any>;

describe("Piwi Runner's merged bundle config", () => {
  test('is its own app: name, identifier and binary', () => {
    expect(runner.productName).toBe('Piwi Runner');
    expect(runner.identifier).toBe('io.piwitests.runner');
    expect(runner.mainBinaryName).toBe('piwi-runner');
    expect(desktop.mainBinaryName).toBeUndefined();
  });

  test("drops the desktop app's installer hooks, which read the desktop app's settings", () => {
    expect(desktop.bundle.windows.nsis.installerHooks).toBeTruthy();
    expect(runner.bundle.windows.nsis).not.toHaveProperty('installerHooks');
    expect(runner.bundle.windows.nsis.installMode).toBe('currentUser');
  });

  test("keeps none of the desktop app's upgrade ties: its MSI upgrade code and the packages it replaces", () => {
    expect(desktop.bundle.windows.wix.upgradeCode).toBeTruthy();
    expect(runner.bundle.windows.wix).not.toHaveProperty('upgradeCode');
    expect(desktop.bundle.linux.deb.replaces).toEqual(['piwi-dashboard']);
    for (const [format, keys] of [
      ['deb', ['conflicts', 'replaces']],
      ['rpm', ['conflicts', 'obsoletes']],
    ] as const) {
      expect(desktop.bundle.linux[format]).toMatchObject(Object.fromEntries(keys.map((k) => [k, ['piwi-dashboard']])));
      for (const key of keys) expect(runner.bundle.linux?.[format] ?? {}).not.toHaveProperty(key);
    }
  });

  test('answers piwi-runner links alone, and the desktop app keeps piwi', () => {
    expect(desktop.plugins['deep-link'].desktop.schemes).toEqual(['piwi']);
    expect(runner.plugins['deep-link'].desktop.schemes).toEqual(['piwi-runner']);
  });

  test('bundles the host and no file associations', () => {
    expect(runner.bundle.resources).toEqual(['resources/runner-host']);
    expect(runner.bundle).not.toHaveProperty('fileAssociations');
  });
});

describe("Piwi Runner's own files", () => {
  const libRs = fs.readFileSync(path.join(shell, 'src', 'lib.rs'), 'utf8');
  const sidecar = /const NODE_SIDECAR: &str = if cfg!\(feature = "runner"\) \{ "([^"]+)" \} else \{ "([^"]+)" \};/.exec(
    libRs,
  );
  const name = (bin: string) => path.posix.basename(bin);

  test('bundles Node under a name of its own, the one the shell spawns', () => {
    expect(sidecar).not.toBeNull();
    const [, runnerName, desktopName] = sidecar!;
    expect(runner.bundle.externalBin.map(name)).toEqual([runnerName]);
    expect(desktop.bundle.externalBin.map(name)).toEqual([desktopName]);
    // The Linux packages install each sidecar in /usr/bin, so the two apps' must differ.
    expect(runnerName).not.toBe(desktopName);
  });

  test('takes its own icons, in the app and on the installers', () => {
    const own = (file: string) => file.startsWith('icons-runner/');
    expect(runner.bundle.icon.length).toBeGreaterThan(0);
    expect(runner.bundle.icon.every(own)).toBe(true);
    expect(desktop.bundle.icon.some(own)).toBe(false);
    expect(own(runner.bundle.windows.nsis.installerIcon)).toBe(true);
    expect(own(runner.bundle.windows.nsis.uninstallerIcon)).toBe(true);
  });
});
