/**
 * The installers of the desktop app and of Piwi Runner, as links to GitHub's latest release, and the visitor's
 * system as the browser tells it. Read by the docs' `<DownloadApps>` component and by the text the docs render for
 * agents (`docs-corpus.ts`, `apps/docs/scripts/generate-llms.mjs`).
 *
 * `releases/latest/download/<file>` serves the file of that name from the latest release, so a file name carries no
 * version: each app's `ASSET_NAME_PATTERN` (`reusable-publish-desktop.yml`, `reusable-publish-runner.yml`) renders
 * `<prefix><arch><setup><ext>`, and `tests/unit/app-downloads.test.ts` holds the two together.
 */

export const LATEST_RELEASE_URL = 'https://github.com/PiwiTests/piwi/releases/latest';

/** The two apps whose installers the release carries. */
export const DOWNLOAD_APPS = [
  {
    id: 'desktop',
    name: 'Piwi Desktop',
    prefix: 'Piwi-Desktop_',
    summary: 'The dashboard on your computer, with your local runs.',
    doc: 'features/desktop',
  },
  {
    id: 'runner',
    name: 'Piwi Runner',
    prefix: 'Piwi-Runner_',
    summary:
      'Runs the tests a team instance asks for, without the dashboard. Not needed beside the desktop app, which takes the same requests.',
    doc: 'features/piwi-runner',
  },
];

/** Each app's installers: the system they install on, a label, and the end of the file name. The first of a system
 * is the one its button offers. */
export const DOWNLOAD_PACKAGES = [
  { os: 'windows', label: 'Windows, per user (.exe)', file: 'x64-setup.exe' },
  { os: 'windows', label: 'Windows, per machine (.msi)', file: 'x64.msi' },
  { os: 'macos', label: 'macOS, Apple silicon (.dmg)', file: 'aarch64.dmg' },
  { os: 'linux', label: 'Linux, any distribution (.AppImage)', file: 'amd64.AppImage' },
  { os: 'linux', label: 'Debian, Ubuntu (.deb)', file: 'amd64.deb' },
  { os: 'linux', label: 'Fedora, RHEL (.rpm)', file: 'x86_64.rpm' },
];

/** The link to `pkg` of `app` in the latest release. */
export function downloadUrl(app, pkg) {
  return `${LATEST_RELEASE_URL}/download/${app.prefix}${pkg.file}`;
}

/**
 * The desktop system the browser runs on: `windows`, `macos` or `linux`, or `null` when it is none of them or a phone
 * or tablet (Android says Linux; an iPad in desktop mode says Macintosh, with a touch screen no Mac has).
 *
 * @param {{ userAgent?: string, platform?: string, maxTouchPoints?: number, userAgentData?: { platform?: string, mobile?: boolean } }} nav
 */
export function detectOs(nav) {
  if (nav.userAgentData?.mobile) return null;
  const ua = nav.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return null;
  const said = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${ua}`;
  if (/Windows|Win32|Win64/i.test(said)) return 'windows';
  if (/Mac/i.test(said)) return (nav.maxTouchPoints ?? 0) > 1 ? null : 'macos';
  if (/Linux|X11|CrOS/i.test(said)) return /CrOS/i.test(said) ? null : 'linux';
  return null;
}

/**
 * A Mac's chip, where the browser tells it: `arm` or `x86` from Chromium's client hints, `null` elsewhere. Safari and
 * Firefox report every Mac as Intel, so their answer is never read.
 *
 * @param {{ userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> } }} nav
 */
export async function detectMacChip(nav) {
  const hints = nav.userAgentData?.getHighEntropyValues;
  if (!hints) return null;
  try {
    const { architecture } = await hints.call(nav.userAgentData, ['architecture']);
    if (architecture === 'arm') return 'arm';
    if (architecture === 'x86') return 'x86';
  } catch {
    // A browser that refuses the hint leaves the chip unknown.
  }
  return null;
}

/** The installers as Markdown, for the docs' text rendering: one line per app. */
export function downloadsMarkdown(appIds = DOWNLOAD_APPS.map((a) => a.id)) {
  return DOWNLOAD_APPS.filter((app) => appIds.includes(app.id)).map(
    (app) => `- ${app.name}: ${DOWNLOAD_PACKAGES.map((pkg) => `[${pkg.label}](${downloadUrl(app, pkg)})`).join(', ')}`,
  );
}
