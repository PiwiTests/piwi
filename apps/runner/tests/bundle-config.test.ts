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

  test("takes installer hooks of its own, never the desktop app's, which read the desktop app's settings", () => {
    expect(desktop.bundle.windows.nsis.installerHooks).toBe('windows/installer-hooks.nsh');
    expect(runner.bundle.windows.nsis.installerHooks).toBe('windows/runner-installer-hooks.nsh');
    expect(runner.bundle.windows.nsis.installMode).toBe('currentUser');
    const hooks = fs.readFileSync(path.join(shell, runner.bundle.windows.nsis.installerHooks), 'utf8');
    // It stops the sidecar the config bundles, before the installer and the uninstaller touch a file.
    const sidecar = path.posix.basename(runner.bundle.externalBin[0]);
    expect(hooks.match(new RegExp(`PIWI_STOP_SIDECAR ${sidecar}\\n`, 'g'))).toHaveLength(2);
    expect(hooks).not.toMatch(/MUI_|PIWI_SAVE_PORT/);
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

describe("Piwi Runner's update channel", () => {
  const overlay = read('runner.updater.conf.json') as Record<string, any>;
  const desktopOverlay = read('tauri.updater.conf.json') as Record<string, any>;
  const updating = merge(runner, overlay) as Record<string, any>;

  test('reads its own manifest, never the desktop app’s', () => {
    expect(updating.plugins.updater.endpoints).toEqual([
      'https://github.com/PiwiTests/piwi/releases/latest/download/latest-runner.json',
    ]);
  });

  test("checks the signature with the desktop app's public key, which signs both apps' packages", () => {
    expect(updating.plugins.updater.pubkey).toBe(desktopOverlay.plugins.updater.pubkey);
    expect(updating.bundle.createUpdaterArtifacts).toBe(true);
  });

  test('keeps the merged product Runner’s', () => {
    expect(updating.identifier).toBe('io.piwitests.runner');
    expect(updating.plugins['deep-link'].desktop.schemes).toEqual(['piwi-runner']);
  });
});
