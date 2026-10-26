#!/usr/bin/env node
// Download the official Node.js runtime for a Tauri target triple and place it
// as the sidecar binary at desktop/src-tauri/binaries/node-<triple>[.exe].
// Tauri resolves `externalBin: ["binaries/node"]` to node-<current-triple>.
// Every download is checked against the release's SHASUMS256.txt, and the
// script fails on a file the list does not name or whose SHA-256 differs.
//
// The version is the root Dockerfile's (scripts/node-version.mjs), unless
// --node or PIWI_NODE_VERSION names another.
//
// Usage: node scripts/fetch-node.mjs --target <triple> [--node <version>]
//   e.g. --target x86_64-pc-windows-msvc
//        --target aarch64-apple-darwin
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { bundledNodeVersion } from './node-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const binaries = resolve(here, '../src-tauri/binaries');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function defaultHostTriple() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32') return 'x86_64-pc-windows-msvc';
  if (p === 'darwin') return a === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return 'x86_64-unknown-linux-gnu';
}

const NODE_VERSION = arg('node', process.env.PIWI_NODE_VERSION || bundledNodeVersion()).replace(/^v/, '');
const target = arg('target', defaultHostTriple());
const base = `https://nodejs.org/dist/v${NODE_VERSION}`;

mkdirSync(binaries, { recursive: true });

async function get(url) {
  console.log(`[fetch-node] GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The release's SHA-256 of each file, by its path under the release folder. */
let checksums;
async function expectedSha256(file) {
  checksums ??= new Map(
    (await get(`${base}/SHASUMS256.txt`))
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2)
      .map(([hash, name]) => [name, hash.toLowerCase()]),
  );
  const expected = checksums.get(file);
  if (!expected) throw new Error(`SHASUMS256.txt of v${NODE_VERSION} does not list ${file}`);
  return expected;
}

/** Download `file` of the release to `to`, once its SHA-256 matches the release's list. */
async function download(file, to) {
  const bytes = await get(`${base}/${file}`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  const expected = await expectedSha256(file);
  if (actual !== expected) throw new Error(`checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
  writeFileSync(to, bytes);
}

function extractNodeBinary(archive, innerDir, outFile) {
  const work = join(tmpdir(), `node-extract-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execSync(`tar -xf "${archive}" -C "${work}"`, { stdio: 'inherit' });
  copyFileSync(join(work, innerDir, 'bin', 'node'), outFile);
  chmodSync(outFile, 0o755);
  rmSync(work, { recursive: true, force: true });
}

async function fromTarball(distName, ext) {
  const archive = join(tmpdir(), `${distName}.${ext}`);
  await download(`${distName}.${ext}`, archive);
  const out = join(binaries, `node-${target}`);
  extractNodeBinary(archive, distName, out);
  rmSync(archive, { force: true });
  console.log(`[fetch-node] Wrote ${out}`);
}

const run = async () => {
  if (target.includes('windows')) {
    // Windows ships node.exe directly — no archive to unpack.
    const out = join(binaries, `node-${target}.exe`);
    await download('win-x64/node.exe', out);
    console.log(`[fetch-node] Wrote ${out}`);
  } else if (target === 'aarch64-apple-darwin') {
    await fromTarball(`node-v${NODE_VERSION}-darwin-arm64`, 'tar.gz');
  } else if (target === 'x86_64-apple-darwin') {
    await fromTarball(`node-v${NODE_VERSION}-darwin-x64`, 'tar.gz');
  } else if (target.includes('linux')) {
    await fromTarball(`node-v${NODE_VERSION}-linux-x64`, 'tar.xz');
  } else {
    throw new Error(`unsupported target: ${target}`);
  }
};

run().catch((e) => {
  console.error('[fetch-node]', e.message);
  process.exit(1);
});
