/**
 * Piwi Runner's release files, from what the bundler writes (the names below are the v0.69.0 build's) to the names
 * the release carries: `ASSET_NAME_PATTERN` of `reusable-publish-runner.yml`, which the docs' download links and
 * `latest-runner.json` read.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { releaseFiles, renderAssetName } from '../scripts/release-files.mjs';

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'reusable-publish-runner.yml'),
  'utf8',
);
const pattern = /^\s*ASSET_NAME_PATTERN: '([^']+)'/m.exec(workflow)![1]!;

const signed = (files: string[]) => files.flatMap((file) => [file, `${file}.sig`]);

describe("Piwi Runner's release files", () => {
  test('name the Windows installers and their signatures', () => {
    const files = signed(['msi/Piwi Runner_0.69.0_x64_en-US.msi', 'nsis/Piwi Runner_0.69.0_x64-setup.exe']);
    expect(releaseFiles({ files, target: 'x86_64-pc-windows-msvc', pattern })).toEqual([
      { from: 'msi/Piwi Runner_0.69.0_x64_en-US.msi', name: 'Piwi-Runner_x64.msi' },
      { from: 'msi/Piwi Runner_0.69.0_x64_en-US.msi.sig', name: 'Piwi-Runner_x64.msi.sig' },
      { from: 'nsis/Piwi Runner_0.69.0_x64-setup.exe', name: 'Piwi-Runner_x64-setup.exe' },
      { from: 'nsis/Piwi Runner_0.69.0_x64-setup.exe.sig', name: 'Piwi-Runner_x64-setup.exe.sig' },
    ]);
  });

  test('name the macOS disk image and update file', () => {
    const files = [
      'dmg/Piwi Runner_0.69.0_aarch64.dmg',
      'macos/Piwi Runner.app.tar.gz',
      'macos/Piwi Runner.app.tar.gz.sig',
    ];
    expect(releaseFiles({ files, target: 'aarch64-apple-darwin', pattern }).map((f) => f.name)).toEqual([
      'Piwi-Runner_aarch64.dmg',
      'Piwi-Runner_aarch64.app.tar.gz',
      'Piwi-Runner_aarch64.app.tar.gz.sig',
    ]);
    // Without the signing key the bundler makes no update file, and the dmg is enough.
    expect(releaseFiles({ files: [files[0]!], target: 'aarch64-apple-darwin', pattern })).toEqual([
      { from: files[0], name: 'Piwi-Runner_aarch64.dmg' },
    ]);
  });

  test('name the Linux packages, the names the v0.69.0 release carries', () => {
    const files = signed([
      'appimage/Piwi Runner_0.69.0_amd64.AppImage',
      'deb/Piwi Runner_0.69.0_amd64.deb',
      'rpm/Piwi Runner-0.69.0-1.x86_64.rpm',
    ]);
    expect(releaseFiles({ files, target: 'x86_64-unknown-linux-gnu', pattern }).map((f) => f.name)).toEqual([
      'Piwi-Runner_amd64.AppImage',
      'Piwi-Runner_amd64.AppImage.sig',
      'Piwi-Runner_amd64.deb',
      'Piwi-Runner_amd64.deb.sig',
      'Piwi-Runner_x86_64.rpm',
      'Piwi-Runner_x86_64.rpm.sig',
    ]);
  });

  test('leaves out what the release does not carry', () => {
    const files = [
      'msi/Piwi Runner_0.69.0_x64_en-US.msi',
      'msi/Piwi Runner_0.69.0_x64_en-US.msi.zip',
      'nsis/Piwi Runner_0.69.0_x64-setup.exe',
      'nsis/Piwi Runner_0.69.0_x64-setup.nsis.zip',
      'nsis/installer.nsi',
    ];
    expect(releaseFiles({ files, target: 'x86_64-pc-windows-msvc', pattern }).map((f) => f.name)).toEqual([
      'Piwi-Runner_x64.msi',
      'Piwi-Runner_x64-setup.exe',
    ]);
  });

  test('fails on an installer the build did not make, or on two of one kind', () => {
    expect(() =>
      releaseFiles({ files: ['msi/Piwi Runner_0.69.0_x64_en-US.msi'], target: 'x86_64-pc-windows-msvc', pattern }),
    ).toThrow('the build made no nsis/*-setup.exe for x86_64-pc-windows-msvc');
    expect(() =>
      releaseFiles({
        files: ['deb/a_amd64.deb', 'deb/b_amd64.deb', 'rpm/a.rpm', 'appimage/a.AppImage'],
        target: 'x86_64-unknown-linux-gnu',
        pattern,
      }),
    ).toThrow('more than one deb package');
    expect(() => releaseFiles({ files: [], target: 'riscv64gc-unknown-linux-gnu', pattern })).toThrow(
      'no Piwi Runner packages known',
    );
  });

  test('fills the workflow pattern, and refuses one it cannot fill', () => {
    expect(pattern).toBe('Piwi-Runner_[arch][setup][ext]');
    expect(() => renderAssetName('Piwi-Runner_[version]_[arch][ext]', { arch: 'x64', setup: '', ext: '.msi' })).toThrow(
      'placeholder',
    );
  });
});
