// prepack step: copy the application's freshly built Nitro output into this package
// so it ships inside the published tarball (`files: [".output/"]`). The build artifact
// is intentionally not committed to git — CI runs `npm run app:build --workspace=apps/application`
// (with NITRO_PRESET=node-server) before packing.
//
// Nitro bundles the npm dependencies into the server, apart from the native modules
// (sharp, libsql), whose files it copies into `.output/server/node_modules`: the BUILD
// machine's platform binaries (e.g. linux-x64-glibc), which would be wrong for a
// macOS / Windows / arm / musl user.
// We strip those platform-specific binary sub-packages here and declare `sharp` +
// `@libsql/client` as real dependencies in package.json, so npm installs the correct
// per-platform binaries at install time (the bundled JS wrappers resolve them from the
// hoisted top-level node_modules). This mirrors the Dockerfile's runtime install.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '../../../apps/application/.output')
const target = resolve(here, '../.output')

if (!existsSync(source)) {
  console.error(
    `[copy-output] Application build output not found at ${source}.\n` +
      'Build it first: NITRO_PRESET=node-server npm run app:build --workspace=apps/application',
  )
  process.exit(1)
}

// npm pack leaves symlinks out of the tarball, and Nitro links each package it ships in
// two versions (`node_modules/detect-libc -> .nf3/detect-libc@2.0.2`), so the copy follows
// links and writes what they point to.
function copyFollowingLinks(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) copyFollowingLinks(join(from, name), join(to, name))
  } else {
    copyFileSync(from, to)
  }
}

rmSync(target, { recursive: true, force: true })
copyFollowingLinks(source, target)
console.log(`[copy-output] Copied ${source} -> ${target}`)

// Strip platform-locked native binaries so npm reinstalls the correct ones per platform.
const serverModules = join(target, 'server/node_modules')
const stripDirs = []

// sharp: every @img/sharp-<platform>* and @img/sharp-libvips-<platform>* except the
// cross-platform wasm fallback (@img/sharp-wasm32) and shared helper (@img/colour).
const imgDir = join(serverModules, '@img')
if (existsSync(imgDir)) {
  for (const entry of readdirSync(imgDir)) {
    if (entry.startsWith('sharp-') && entry !== 'sharp-wasm32') {
      stripDirs.push(join(imgDir, entry))
    }
  }
}

// libsql: every @libsql/<platform> native binary (e.g. linux-x64-gnu, darwin-arm64).
const libsqlDir = join(serverModules, '@libsql')
if (existsSync(libsqlDir)) {
  const KEEP = new Set(['client', 'core', 'hrana-client', 'isomorphic-ws'])
  for (const entry of readdirSync(libsqlDir)) {
    if (!KEEP.has(entry)) {
      stripDirs.push(join(libsqlDir, entry))
    }
  }
}

for (const dir of stripDirs) {
  rmSync(dir, { recursive: true, force: true })
  console.log(`[copy-output] Stripped platform binary: ${dir.slice(target.length + 1)}`)
}
