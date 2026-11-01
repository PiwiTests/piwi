#!/usr/bin/env node
// Pack the desktop app as an MSIX package for the Microsoft Store.
//
// Lays out the release build of `tauri build --no-bundle`, the Node sidecar and the staged server as they sit in an
// installed app (the executable, node.exe beside it, resources\app-server), fills src-tauri/windows/AppxManifest.xml,
// then runs the Windows SDK's makeappx. The package is unsigned: the Store signs it on certification, and a test
// install signs a copy with its own certificate.
//
// The package identity comes from Partner Center (Product identity), through the environment:
//   MSIX_IDENTITY_NAME, MSIX_PUBLISHER, MSIX_PUBLISHER_DISPLAY_NAME
// Without them the package gets a test identity, installable only with a certificate whose subject is its publisher.
//
// Usage: node scripts/msix.mjs --out <file.msix> [--variant unvirtualized|classic] [--version 1.2.3.0]
//                              [--target x86_64-pc-windows-msvc] [--layout-only]
//   --variant   unvirtualized (the default, the Store package): a full-trust packaged desktop app whose AppData and
//                 HKCU writes go to the real locations, shared with the user's tools and kept on uninstall (the
//                 unvirtualizedResources restricted capability);
//               classic: the same app with Windows' default virtualization: new AppData files go to a private copy.
//   --version   the package version; default: tauri.conf.json's, with a fourth part of 0.
//   --layout-only  write the layout and manifest beside --out, without makeappx (works on any OS).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, '../src-tauri');

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    variant: { type: 'string', default: 'unvirtualized' },
    version: { type: 'string' },
    target: { type: 'string', default: 'x86_64-pc-windows-msvc' },
    'layout-only': { type: 'boolean', default: false },
  },
});

const VARIANTS = {
  classic: { properties: [], capabilities: [] },
  unvirtualized: {
    properties: [
      '<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>',
      '<desktop6:RegistryWriteVirtualization>disabled</desktop6:RegistryWriteVirtualization>',
    ],
    capabilities: ['<rescap:Capability Name="unvirtualizedResources" />'],
  },
};

function fail(message) {
  console.error(`[msix] ${message}`);
  process.exit(1);
}

if (!args.out) fail('--out <file.msix> is required');
const variant = VARIANTS[args.variant];
if (!variant) fail(`unknown --variant ${args.variant}: ${Object.keys(VARIANTS).join(', ')}`);

const config = JSON.parse(readFileSync(join(tauriDir, 'tauri.conf.json'), 'utf8'));
const version = args.version ?? `${config.version}.0`;
if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) fail(`the package version must have four parts: ${version}`);

const releaseDir = join(tauriDir, 'target', args.target, 'release');
const executable = ['Piwi Dashboard.exe', 'piwi-desktop.exe'].find((name) => existsSync(join(releaseDir, name)));
const sources = {
  executable: executable && join(releaseDir, executable),
  node: join(tauriDir, 'binaries', `node-${args.target}.exe`),
  server: join(tauriDir, 'resources', 'app-server'),
  icons: join(tauriDir, 'icons'),
};
if (!executable) fail(`no release build in ${releaseDir}: run \`npx tauri build --target ${args.target} --no-bundle\``);
if (!existsSync(sources.node)) fail(`no Node sidecar at ${sources.node}: run \`npm run fetch-node\``);
if (!existsSync(sources.server)) fail(`no staged server at ${sources.server}: run \`npm run stage\``);

const LOGOS = ['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png'];
for (const logo of LOGOS) {
  if (!existsSync(join(sources.icons, logo))) fail(`no ${logo} in ${sources.icons}: run \`npx tauri icon\``);
}

const out = resolve(args.out);
const layout = join(dirname(out), `${basename(out, '.msix')}-layout`);
rmSync(layout, { recursive: true, force: true });
mkdirSync(join(layout, 'Assets'), { recursive: true });
cpSync(sources.executable, join(layout, executable));
cpSync(sources.node, join(layout, 'node.exe'));
cpSync(sources.server, join(layout, 'resources', 'app-server'), { recursive: true });
for (const logo of LOGOS) cpSync(join(sources.icons, logo), join(layout, 'Assets', logo));

const xml = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const indent = (lines, spaces) => (lines.length ? lines.map((line) => `\n${' '.repeat(spaces)}${line}`).join('') : '');
const IDENTITY = {
  IDENTITY_NAME: ['MSIX_IDENTITY_NAME', 'PiwiTests.PiwiDashboard'],
  PUBLISHER: ['MSIX_PUBLISHER', 'CN=Piwi Dashboard Test'],
  PUBLISHER_DISPLAY_NAME: ['MSIX_PUBLISHER_DISPLAY_NAME', 'Piwi Dashboard (test)'],
};
const missing = Object.values(IDENTITY)
  .map(([name]) => name)
  .filter((name) => !process.env[name]);
if (missing.length > 0 && missing.length < Object.keys(IDENTITY).length) {
  fail(`the package identity is incomplete: set ${missing.join(', ')} too, or none of the three for a test identity`);
}
const values = {
  ...Object.fromEntries(
    Object.entries(IDENTITY).map(([key, [name, testValue]]) => [key, process.env[name] || testValue]),
  ),
  VERSION: version,
  DESCRIPTION: config.bundle.shortDescription,
  EXECUTABLE: executable,
};
const escaped = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, xml(value)]));
const manifest = readFileSync(join(tauriDir, 'windows', 'AppxManifest.xml'), 'utf8')
  .replace(/<!--[\s\S]*?-->\n/, '')
  .replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key === 'PROPERTIES') return indent(variant.properties, 4);
    if (key === 'CAPABILITIES') return indent(variant.capabilities, 4);
    if (key in escaped) return escaped[key];
    fail(`AppxManifest.xml names an unknown placeholder ${match}`);
  });
writeFileSync(join(layout, 'AppxManifest.xml'), manifest);
console.log(`[msix] Laid out ${values.IDENTITY_NAME} ${version} (${args.variant}) in ${layout}`);

if (args['layout-only']) process.exit(0);
if (process.platform !== 'win32') fail('makeappx runs on Windows only: pass --layout-only elsewhere');

/** The newest x64 makeappx.exe of the installed Windows SDKs. */
function findMakeAppx() {
  const bin = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = existsSync(bin) ? readdirSync(bin).filter((name) => /^10\.\d+\.\d+\.\d+$/.test(name)) : [];
  versions.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).reverse();
  for (const sdk of versions) {
    const tool = join(bin, sdk, 'x64', 'makeappx.exe');
    if (existsSync(tool)) return tool;
  }
  fail(`no makeappx.exe under ${bin}: install the Windows SDK`);
}

rmSync(out, { force: true });
execFileSync(findMakeAppx(), ['pack', '/o', '/d', layout, '/p', out], { stdio: 'inherit' });
console.log(`[msix] Packed ${out}`);
