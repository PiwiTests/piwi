/**
 * `latest-runner.json`, from the files a release carries: the names tauri-action gives Runner's files under
 * `ASSET_NAME_PATTERN` (`Piwi-Runner_[version]_[arch][setup][ext]`).
 */
import { describe, expect, test } from 'vitest';
import { runnerUpdateManifest } from '../scripts/update-manifest.mjs';

const VERSION = '0.69.0';
const PACKAGES = [
  'Piwi-Runner_0.69.0_x64.msi',
  'Piwi-Runner_0.69.0_x64-setup.exe',
  'Piwi-Runner_0.69.0_aarch64.app.tar.gz',
  'Piwi-Runner_0.69.0_amd64.AppImage',
  'Piwi-Runner_0.69.0_amd64.deb',
  'Piwi-Runner_0.69.0_x86_64.rpm',
];
const url = (name: string) => `https://github.com/PiwiTests/piwi/releases/download/v${VERSION}/${name}`;
const signed = (names: string[]) => Object.fromEntries(names.map((name) => [name, `sig of ${name}\n`]));

function manifest(names: string[], signatures = signed(names)) {
  const assets = [...names, ...names.map((n) => `${n}.sig`)].map((name) => ({ name, url: url(name) }));
  return runnerUpdateManifest({ version: VERSION, pubDate: '2026-11-12T00:00:00Z', assets, signatures });
}

describe("Piwi Runner's update manifest", () => {
  test('names each kind of install, and the package of an install of no recorded kind', () => {
    const { version, pub_date, platforms } = manifest(PACKAGES);
    expect(version).toBe(VERSION);
    expect(pub_date).toBe('2026-11-12T00:00:00Z');
    expect(
      Object.fromEntries(Object.entries(platforms).map(([key, entry]) => [key, entry.url.split('/').pop()])),
    ).toEqual({
      'windows-x86_64-msi': 'Piwi-Runner_0.69.0_x64.msi',
      'windows-x86_64-nsis': 'Piwi-Runner_0.69.0_x64-setup.exe',
      'windows-x86_64': 'Piwi-Runner_0.69.0_x64.msi',
      'darwin-aarch64-app': 'Piwi-Runner_0.69.0_aarch64.app.tar.gz',
      'darwin-aarch64': 'Piwi-Runner_0.69.0_aarch64.app.tar.gz',
      'linux-x86_64-appimage': 'Piwi-Runner_0.69.0_amd64.AppImage',
      'linux-x86_64': 'Piwi-Runner_0.69.0_amd64.AppImage',
      'linux-x86_64-deb': 'Piwi-Runner_0.69.0_amd64.deb',
      'linux-x86_64-rpm': 'Piwi-Runner_0.69.0_x86_64.rpm',
    });
    expect(platforms['linux-x86_64-deb']!.signature).toBe('sig of Piwi-Runner_0.69.0_amd64.deb');
  });

  test("leaves out the desktop app's files, another version's, unsigned ones and the macOS disk image", () => {
    const names = [
      'Piwi-Runner_0.69.0_x64.msi',
      'Piwi-Desktop_0.69.0_x64.msi',
      'Piwi-Runner_0.68.0_amd64.deb',
      'Piwi-Runner_0.69.0_aarch64.dmg',
      'Piwi-Runner_0.69.0_amd64.AppImage',
    ];
    const signatures = signed(names);
    delete signatures['Piwi-Runner_0.69.0_amd64.AppImage'];
    expect(Object.keys(manifest(names, signatures).platforms).sort()).toEqual(['windows-x86_64', 'windows-x86_64-msi']);
  });

  test('refuses a release with no signed package of the version', () => {
    expect(() => manifest(['Piwi-Desktop_0.69.0_x64.msi'])).toThrow(/no signed Piwi-Runner_0.69.0_ package/);
    expect(() => manifest(PACKAGES, {})).toThrow();
  });
});
