/**
 * Piwi Runner's update manifest, `latest-runner.json`, from the files of a release. Pure: the Release workflow
 * (`reusable-publish-runner.yml`) lists the release's assets, reads the signature files, and calls it.
 *
 * The updater looks for `{os}-{arch}-{installer}` first, then `{os}-{arch}` (tauri-plugin-updater's `get_urls`), so
 * one manifest serves every kind of install: each takes the package it was installed from. The `{os}-{arch}` entries
 * name the package of an install whose kind the build did not record: the `.msi`, the macOS app, the AppImage.
 */

/** The release files that update an install, by their end: the updater's key for them, and whether the key without
 * the installer names them too. */
const PACKAGES = [
  { end: '.msi', os: 'windows', installer: 'msi', fallback: true },
  { end: '-setup.exe', os: 'windows', installer: 'nsis', fallback: false },
  { end: '.app.tar.gz', os: 'darwin', installer: 'app', fallback: true },
  { end: '.AppImage', os: 'linux', installer: 'appimage', fallback: true },
  { end: '.deb', os: 'linux', installer: 'deb', fallback: false },
  { end: '.rpm', os: 'linux', installer: 'rpm', fallback: false },
];

/** The updater's name of the architecture a file name carries (`_x64`, `_amd64`, `_x86_64`, `_aarch64`, `_arm64`). */
function archOf(name) {
  if (/_(aarch64|arm64)[-._]/.test(name)) return 'aarch64';
  if (/_(x64|amd64|x86_64)[-._]/.test(name)) return 'x86_64';
  return null;
}

/**
 * @param {object} release
 * @param {string} release.version The version, without a leading `v`.
 * @param {string} release.pubDate When the manifest is written (ISO 8601).
 * @param {{ name: string, url: string }[]} release.assets The release's files: name and download URL.
 * @param {Record<string, string>} release.signatures The text of each signature file, by the name of the file it signs.
 * @param {string} [release.prefix] The start of every file name of the app's (`ASSET_NAME_PATTERN`, which carries no
 *   version: the release's own files are the ones listed).
 * @returns {{ version: string, pub_date: string, platforms: Record<string, { signature: string, url: string }> }}
 */
export function runnerUpdateManifest({ version, pubDate, assets, signatures, prefix = 'Piwi-Runner_' }) {
  const platforms = {};
  const fallbacks = {};
  for (const asset of assets) {
    if (!asset.name.startsWith(prefix)) continue;
    const kind = PACKAGES.find((p) => asset.name.endsWith(p.end));
    const signature = signatures[asset.name];
    const arch = archOf(asset.name);
    if (!kind || !signature || !arch) continue;
    const entry = { signature: signature.trim(), url: asset.url };
    platforms[`${kind.os}-${arch}-${kind.installer}`] = entry;
    if (kind.fallback) fallbacks[`${kind.os}-${arch}`] = entry;
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error(`no signed ${prefix} package on the release of ${version}`);
  }
  return { version, pub_date: pubDate, platforms: { ...fallbacks, ...platforms } };
}
