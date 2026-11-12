/**
 * The docs' download links point at `releases/latest/download/<file>`, so each file the list names must be the one a
 * release uploads: the app's `ASSET_NAME_PATTERN` rendered with tauri-action's arch for that package
 * (`build.ts` of tauri-action: x64 on Windows, aarch64 on Apple silicon, amd64 for .deb and .AppImage, x86_64 for .rpm).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DOWNLOAD_APPS,
  DOWNLOAD_PACKAGES,
  LATEST_RELEASE_URL,
  detectMacChip,
  detectOs,
  downloadUrl,
  downloadsMarkdown,
} from '#shared/app-downloads.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const WORKFLOWS = { desktop: 'reusable-publish-desktop.yml', runner: 'reusable-publish-runner.yml' } as const;

function assetNamePattern(app: keyof typeof WORKFLOWS): string {
  const text = readFileSync(resolve(root, '.github/workflows', WORKFLOWS[app]), 'utf8');
  const match = /^\s*ASSET_NAME_PATTERN: '([^']+)'/m.exec(text);
  if (!match) throw new Error(`no ASSET_NAME_PATTERN in ${WORKFLOWS[app]}`);
  return match[1]!;
}

/** tauri-action's arch and extension for each package the list names. */
const UPLOADED = {
  'x64-setup.exe': { arch: 'x64', setup: '-setup', ext: '.exe' },
  'x64.msi': { arch: 'x64', setup: '', ext: '.msi' },
  'aarch64.dmg': { arch: 'aarch64', setup: '', ext: '.dmg' },
  'amd64.AppImage': { arch: 'amd64', setup: '', ext: '.AppImage' },
  'amd64.deb': { arch: 'amd64', setup: '', ext: '.deb' },
  'x86_64.rpm': { arch: 'x86_64', setup: '', ext: '.rpm' },
} as const;

describe('the download links', () => {
  test.each(DOWNLOAD_APPS.map((app) => [app.id, app] as const))(
    'name the files a release uploads for %s',
    (id, app) => {
      const pattern = assetNamePattern(id);
      expect(pattern, 'a versioned name has no stable latest/download link').not.toContain('[version]');
      for (const pkg of DOWNLOAD_PACKAGES) {
        const parts = UPLOADED[pkg.file as keyof typeof UPLOADED];
        expect(parts, `${pkg.file} is a package tauri-action uploads`).toBeDefined();
        const rendered = pattern
          .replace('[arch]', parts.arch)
          .replace('[setup]', parts.setup)
          .replace('[ext]', parts.ext);
        expect(rendered).toBe(`${app.prefix}${pkg.file}`);
      }
    },
  );

  test('point at the latest release', () => {
    const desktop = DOWNLOAD_APPS.find((a) => a.id === 'desktop')!;
    expect(downloadUrl(desktop, DOWNLOAD_PACKAGES[0]!)).toBe(
      'https://github.com/PiwiTests/piwi/releases/latest/download/Piwi-Desktop_x64-setup.exe',
    );
    expect(LATEST_RELEASE_URL).toBe('https://github.com/PiwiTests/piwi/releases/latest');
  });

  test('render as one Markdown line per app for agents', () => {
    const [line] = downloadsMarkdown(['runner']);
    expect(downloadsMarkdown(['runner'])).toHaveLength(1);
    expect(line).toMatch(
      /^- Piwi Runner: \[Windows, per user \(\.exe\)\]\(https:\/\/github\.com\/.*Piwi-Runner_x64-setup\.exe\)/,
    );
    expect(downloadsMarkdown()).toHaveLength(2);
  });
});

const UA = {
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};

describe("the visitor's system", () => {
  test('reads the desktop systems from the user agent', () => {
    expect(detectOs({ userAgent: UA.windows })).toBe('windows');
    expect(detectOs({ userAgent: UA.mac, maxTouchPoints: 0 })).toBe('macos');
    expect(detectOs({ userAgent: UA.linux })).toBe('linux');
  });

  test('prefers the client hints where the browser has them', () => {
    expect(detectOs({ userAgent: '', userAgentData: { platform: 'macOS', mobile: false } })).toBe('macos');
    expect(detectOs({ userAgent: UA.linux, userAgentData: { platform: 'Windows', mobile: false } })).toBe('windows');
  });

  test('offers nothing to a phone, a tablet or a Chromebook', () => {
    expect(detectOs({ userAgent: UA.android })).toBeNull();
    expect(detectOs({ userAgent: UA.iphone })).toBeNull();
    // An iPad in desktop mode says Macintosh, with a touch screen.
    expect(detectOs({ userAgent: UA.mac, maxTouchPoints: 5 })).toBeNull();
    expect(detectOs({ userAgent: UA.windows, userAgentData: { mobile: true } })).toBeNull();
    expect(detectOs({ userAgent: UA.chromebook })).toBeNull();
    expect(detectOs({})).toBeNull();
  });

  test("reads a Mac's chip from Chromium's hints only", async () => {
    const hints = (architecture: string) => ({
      userAgentData: { getHighEntropyValues: async () => ({ architecture }) },
    });
    expect(await detectMacChip(hints('arm'))).toBe('arm');
    expect(await detectMacChip(hints('x86'))).toBe('x86');
    expect(await detectMacChip(hints(''))).toBeNull();
    expect(await detectMacChip({ userAgent: UA.mac })).toBeNull();
    expect(
      await detectMacChip({ userAgentData: { getHighEntropyValues: () => Promise.reject(new Error('refused')) } }),
    ).toBeNull();
  });
});
