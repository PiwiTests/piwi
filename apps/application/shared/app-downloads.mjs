/**
 * The installers of the desktop app and of Piwi Runner, as links to GitHub's latest release, and the visitor's
 * system as the browser tells it. Read by the docs' `<DownloadApps>` component and by the text the docs render for
 * agents (`docs-corpus.ts`, `apps/docs/scripts/generate-llms.mjs`).
 *
 * `releases/latest/download/<file>` serves the file of that name from the latest release, so a file name carries no
 * version: each app's `ASSET_NAME_PATTERN` (`reusable-publish-desktop.yml`, `reusable-publish-runner.yml`) renders
 * `<prefix><arch><setup><ext>`, and `tests/unit/app-downloads.test.ts` holds the two together. A file links there only
 * once the latest release is known to carry it (`latestReleaseFiles`); until then, and for a file it lacks, the link
 * is the release page.
 */

export const LATEST_RELEASE_URL = 'https://github.com/PiwiTests/piwi/releases/latest';

/** GitHub's API answer for the latest release: its files, readable from a browser on another origin. */
export const LATEST_RELEASE_API = 'https://api.github.com/repos/PiwiTests/piwi/releases/latest';

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
  { os: 'windows', label: 'Windows x64, per user (.exe)', file: 'x64-setup.exe' },
  { os: 'windows', label: 'Windows x64, per machine (.msi)', file: 'x64.msi' },
  { os: 'macos', label: 'macOS, Apple silicon (.dmg)', file: 'aarch64.dmg' },
  { os: 'linux', label: 'Linux x86-64, any distribution (.AppImage)', file: 'amd64.AppImage' },
  { os: 'linux', label: 'Debian, Ubuntu, x86-64 (.deb)', file: 'amd64.deb' },
  { os: 'linux', label: 'Fedora, RHEL, x86-64 (.rpm)', file: 'x86_64.rpm' },
];

/** The file name of `pkg` of `app` on a release. */
export function assetName(app, pkg) {
  return `${app.prefix}${pkg.file}`;
}

/** The link to `pkg` of `app`: the file itself when `files`, the latest release's, holds it, else the release page. */
export function downloadUrl(app, pkg, files) {
  const name = assetName(app, pkg);
  return files?.has(name) ? `${LATEST_RELEASE_URL}/download/${name}` : LATEST_RELEASE_URL;
}

/**
 * The names of the latest release's files, or `null` when GitHub does not answer (offline, its rate limit of an
 * address).
 *
 * @param {(url: string, init?: object) => Promise<{ ok: boolean, json: () => Promise<any> }>} fetchFn
 */
export async function latestReleaseFiles(fetchFn) {
  try {
    const response = await fetchFn(LATEST_RELEASE_API, { headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) return null;
    const release = await response.json();
    if (!Array.isArray(release?.assets)) return null;
    return new Set(release.assets.map((asset) => asset.name).filter((name) => typeof name === 'string'));
  } catch {
    return null;
  }
}

/**
 * The desktop system the browser runs on, for the installers above: `windows`, `macos` or `linux`, or `null` when it
 * is none of them, a phone or tablet, or Linux on ARM. Android asks for desktop sites as Linux, with an ARM `platform`
 * or `Android` in its client hints; an iPad in desktop mode says Macintosh, with a touch screen no Mac has. Windows
 * reports x64 on ARM too, where the x64 installers run emulated.
 *
 * @param {{ userAgent?: string, platform?: string, maxTouchPoints?: number, userAgentData?: { platform?: string, mobile?: boolean } }} nav
 */
export function detectOs(nav) {
  if (nav.userAgentData?.mobile) return null;
  const ua = nav.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod/i.test(`${ua} ${nav.userAgentData?.platform ?? ''}`)) return null;
  const said = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${ua}`;
  if (/Windows|Win32|Win64/i.test(said)) return 'windows';
  if (/Mac/i.test(said)) return (nav.maxTouchPoints ?? 0) > 1 ? null : 'macos';
  if (/Linux|X11|CrOS/i.test(said)) return /CrOS|Chrome OS|aarch64|\barm/i.test(said) ? null : 'linux';
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

/** The installers as Markdown, for the docs' text rendering: one line per app, its files named on the latest
 * release. */
export function downloadsMarkdown(appIds = DOWNLOAD_APPS.map((a) => a.id)) {
  return DOWNLOAD_APPS.filter((app) => appIds.includes(app.id)).map(
    (app) =>
      `- ${app.name}: ${app.summary} On the [latest release](${LATEST_RELEASE_URL}): ${DOWNLOAD_PACKAGES.map(
        (pkg) => `${pkg.label}: \`${assetName(app, pkg)}\``,
      ).join('; ')}.`,
  );
}
