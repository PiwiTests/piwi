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

  test('answers piwi-runner links alone, and the desktop app keeps piwi', () => {
    expect(desktop.plugins['deep-link'].desktop.schemes).toEqual(['piwi']);
    expect(runner.plugins['deep-link'].desktop.schemes).toEqual(['piwi-runner']);
  });

  test('bundles the host and no file associations', () => {
    expect(runner.bundle.resources).toEqual(['resources/runner-host']);
    expect(runner.bundle).not.toHaveProperty('fileAssociations');
  });
});
