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
  LATEST_RELEASE_API,
  assetName,
  detectMacChip,
  detectOs,
  downloadUrl,
  downloadsMarkdown,
  latestReleaseFiles,
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
        expect(rendered).toBe(assetName(app, pkg));
      }
    },
  );

  test('point at a file only once the latest release is known to hold it', () => {
    const desktop = DOWNLOAD_APPS.find((a) => a.id === 'desktop')!;
    const exe = DOWNLOAD_PACKAGES[0]!;
    expect(downloadUrl(desktop, exe, new Set(['Piwi-Desktop_x64-setup.exe']))).toBe(
      'https://github.com/PiwiTests/piwi/releases/latest/download/Piwi-Desktop_x64-setup.exe',
    );
    // Not known yet, not answered, or a release without the file: the release page, which never 404s.
    expect(downloadUrl(desktop, exe)).toBe(LATEST_RELEASE_URL);
    expect(downloadUrl(desktop, exe, null)).toBe(LATEST_RELEASE_URL);
    expect(downloadUrl(desktop, exe, new Set(['Piwi.Dashboard_0.68.0_x64-setup.exe']))).toBe(LATEST_RELEASE_URL);
    expect(LATEST_RELEASE_URL).toBe('https://github.com/PiwiTests/piwi/releases/latest');
  });

  test("read the latest release's file names from GitHub, and nothing when it does not answer", async () => {
    const asked: string[] = [];
    const answer = (ok: boolean, body: unknown) => async (url: string) => {
      asked.push(url);
      return { ok, json: async () => body };
    };
    const files = await latestReleaseFiles(answer(true, { assets: [{ name: 'Piwi-Desktop_x64.msi' }, { name: 3 }] }));
    expect([...files!]).toEqual(['Piwi-Desktop_x64.msi']);
    expect(asked).toEqual([LATEST_RELEASE_API]);
    expect(await latestReleaseFiles(answer(false, { message: 'API rate limit exceeded' }))).toBeNull();
    expect(await latestReleaseFiles(answer(true, { message: 'Not Found' }))).toBeNull();
    expect(await latestReleaseFiles(() => Promise.reject(new Error('offline')))).toBeNull();
  });

  test('render as one Markdown line per app for agents, naming the files on the release page', () => {
    expect(downloadsMarkdown(['runner'])).toHaveLength(1);
    expect(downloadsMarkdown(['runner'])[0]).toBe(
      '- Piwi Runner: Runs the tests a team instance asks for, without the dashboard. Not needed beside the desktop app, ' +
        'which takes the same requests. On the [latest release](https://github.com/PiwiTests/piwi/releases/latest): ' +
        'Windows x64, per user (.exe): `Piwi-Runner_x64-setup.exe`; Windows x64, per machine (.msi): `Piwi-Runner_x64.msi`; ' +
        'macOS, Apple silicon (.dmg): `Piwi-Runner_aarch64.dmg`; ' +
        'Linux x86-64, any distribution (.AppImage): `Piwi-Runner_amd64.AppImage`; ' +
        'Debian, Ubuntu, x86-64 (.deb): `Piwi-Runner_amd64.deb`; Fedora, RHEL, x86-64 (.rpm): `Piwi-Runner_x86_64.rpm`.',
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
    expect(detectOs({ userAgent: UA.chromebook, userAgentData: { platform: 'Chrome OS', mobile: false } })).toBeNull();
    expect(detectOs({})).toBeNull();
  });

  test('offers no x86-64 installer to an ARM machine asking for the desktop site', () => {
    // Firefox's "Desktop site" on Android: a Linux user agent, an ARM platform, a touch screen.
    expect(detectOs({ userAgent: UA.linux, platform: 'Linux aarch64', maxTouchPoints: 5 })).toBeNull();
    // Chrome on a tablet asks for desktop sites as Linux, and its hints still say Android.
    expect(detectOs({ userAgent: UA.linux, userAgentData: { platform: 'Android', mobile: false } })).toBeNull();
    expect(
      detectOs({ userAgent: 'Mozilla/5.0 (X11; Linux aarch64; rv:132.0) Gecko/20100101 Firefox/132.0' }),
    ).toBeNull();
    expect(detectOs({ userAgent: UA.linux, platform: 'Linux armv7l' })).toBeNull();
    // Windows on ARM reports x64, where the x64 installers run emulated.
    expect(detectOs({ userAgent: UA.windows, userAgentData: { platform: 'Windows', mobile: false } })).toBe('windows');
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
