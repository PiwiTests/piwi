/**
 * Piwi Runner's installers and their update signatures, copied from the bundler's output to the names the release
 * carries: `ASSET_NAME_PATTERN` of `reusable-publish-runner.yml` rendered with each package's arch, setup and
 * extension, as tauri-action names an upload (`getAssetName` and `createArtifact` in its `utils.ts`). The workflow
 * uploads the copies with `gh release upload`.
 *
 *   ASSET_NAME_PATTERN='Piwi-Runner_[arch][setup][ext]' \
 *     node apps/runner/scripts/release-files.mjs --bundle <target>/release/bundle --target <triple> --out <dir> [--signed]
 *
 * A target whose installers are missing fails, naming them. A signature is copied when the build made one; with
 * `--signed` (a build with the update signing key) a missing one fails, since `latest-runner.json` lists only a
 * signed package.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The packages each target's build makes: the folder the bundler writes, the end of the file, and the arch and
 * setup the release names it with. */
const PACKAGES = {
  'x86_64-pc-windows-msvc': [
    { dir: 'msi', end: '.msi', ext: '.msi', arch: 'x64', setup: '' },
    { dir: 'nsis', end: '-setup.exe', ext: '.exe', arch: 'x64', setup: '-setup' },
  ],
  'aarch64-apple-darwin': [
    { dir: 'dmg', end: '.dmg', ext: '.dmg', arch: 'aarch64', setup: '' },
    { dir: 'macos', end: '.app.tar.gz', ext: '.app.tar.gz', arch: 'aarch64', setup: '', updateOnly: true },
  ],
  'x86_64-unknown-linux-gnu': [
    { dir: 'appimage', end: '.AppImage', ext: '.AppImage', arch: 'amd64', setup: '' },
    { dir: 'deb', end: '.deb', ext: '.deb', arch: 'amd64', setup: '' },
    { dir: 'rpm', end: '.rpm', ext: '.rpm', arch: 'x86_64', setup: '' },
  ],
};

/** `pattern` with a package's arch, setup and extension. */
export function renderAssetName(pattern, pkg) {
  const name = pattern.replace('[arch]', pkg.arch).replace('[setup]', pkg.setup).replace('[ext]', pkg.ext);
  if (/\[\w+\]/.test(name))
    throw new Error(`ASSET_NAME_PATTERN has a placeholder this script does not fill: ${pattern}`);
  return name;
}

/**
 * The files to upload for `target`, from the bundle folder's file list (paths relative to it, `/`-separated): each
 * installer, and its `.sig` when listed, with the name the release gives it.
 *
 * @param {{ files: string[], target: string, pattern: string, signed?: boolean }} build
 * @returns {{ from: string, name: string }[]}
 */
export function releaseFiles({ files, target, pattern, signed = false }) {
  const packages = PACKAGES[target];
  if (!packages) throw new Error(`no Piwi Runner packages known for ${target}`);
  const listed = new Set(files);
  const out = [];
  const missing = [];
  for (const pkg of packages) {
    const found = files.filter((file) => file.startsWith(`${pkg.dir}/`) && file.endsWith(pkg.end));
    if (found.length > 1) throw new Error(`more than one ${pkg.dir} package: ${found.join(', ')}`);
    if (found.length === 0) {
      // The macOS update file is packed from the app bundle, which a build without `app` in its bundles leaves out.
      if (!pkg.updateOnly) missing.push(`${pkg.dir}/*${pkg.end}`);
      continue;
    }
    const name = renderAssetName(pattern, pkg);
    out.push({ from: found[0], name });
    if (listed.has(`${found[0]}.sig`)) out.push({ from: `${found[0]}.sig`, name: `${name}.sig` });
    else if (signed) missing.push(`${found[0]}.sig`);
  }
  if (missing.length) throw new Error(`the build made no ${missing.join(', ')} for ${target}`);
  return out;
}

/** Every file under `dir`, relative to it, `/`-separated. */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'));
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return false;
  }
})();

if (isMain) {
  const bundle = arg('bundle');
  const target = arg('target');
  const outDir = arg('out');
  const pattern = process.env.ASSET_NAME_PATTERN;
  if (!pattern) throw new Error('ASSET_NAME_PATTERN is required');
  if (!existsSync(bundle)) throw new Error(`no bundle folder at ${bundle}`);
  mkdirSync(outDir, { recursive: true });
  const signed = process.argv.includes('--signed');
  for (const { from, name } of releaseFiles({ files: listFiles(bundle), target, pattern, signed })) {
    copyFileSync(join(bundle, from), join(outDir, name));
    console.log(`${from} -> ${basename(name)}`);
  }
}
