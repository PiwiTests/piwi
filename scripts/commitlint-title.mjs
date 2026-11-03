#!/usr/bin/env node
// Prepares the install that lints a pull request title (the `title` job of pr-lint.yml), outside
// the workspace: the packages commitlint.config.js loads, with every package they depend on at the
// version and integrity package-lock.json records, and a title config that loads the repository's.
//
// Usage:
//   node scripts/commitlint-title.mjs <dir>
//   npm ci --prefix <dir> --ignore-scripts
//   printf '%s\n' "$TITLE" | <dir>/node_modules/.bin/commitlint --config <dir>/title.config.mjs
//
// <dir> receives a package.json naming the packages below at their locked versions, a
// package-lock.json holding only the entries they resolve to, and title.config.mjs. A package
// commitlint.config.js names (an extends, a parser preset, a plugin, a formatter) is listed in
// PACKAGES, or the script fails.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGES = ['@commitlint/cli', '@commitlint/config-conventional', 'conventional-changelog-conventionalcommits'];

const root = path.resolve(import.meta.dirname, '..');
const dir = process.argv[2];
if (!dir) throw new Error('Usage: node scripts/commitlint-title.mjs <dir>');

const config = pathToFileURL(path.join(root, 'commitlint.config.js')).href;
const exported = (await import(config)).default;
const loaded = typeof exported === 'function' ? await exported() : exported;
const named = [...(loaded.extends ?? []), ...(loaded.plugins ?? []), loaded.parserPreset, loaded.formatter].filter(
  (name) => typeof name === 'string' && !name.startsWith('.') && !path.isAbsolute(name),
);
for (const name of named) {
  if (!PACKAGES.includes(name)) throw new Error(`commitlint.config.js loads ${name}, which PACKAGES does not list`);
}

const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

// The lockfile key a dependency of the package at `from` resolves to, by Node's lookup: its own
// node_modules first, then each enclosing one up to the top level.
function resolve(from, name) {
  let base = from;
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[key]) return key;
    if (!base) return undefined;
    const index = base.lastIndexOf('/node_modules/');
    base = index === -1 ? '' : base.slice(0, index);
  }
}

const packages = {};
const dependencies = {};
const pending = [];
for (const name of PACKAGES) {
  const key = resolve('', name);
  if (!key) throw new Error(`${name} is not in package-lock.json`);
  dependencies[name] = lock.packages[key].version;
  pending.push(key);
}
while (pending.length > 0) {
  const key = pending.pop();
  if (packages[key]) continue;
  // Every package of this tree is a dependency of the title install, whatever the workspace's graph flags it as.
  const entry = { ...lock.packages[key] };
  for (const flag of ['dev', 'optional', 'devOptional', 'peer']) delete entry[flag];
  if (entry.link) throw new Error(`${key} is a workspace link`);
  packages[key] = entry;
  const optional = new Set([
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.entries(entry.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional)
      .map(([name]) => name),
  ]);
  const names = {
    ...entry.dependencies,
    ...entry.optionalDependencies,
    ...entry.peerDependencies,
  };
  for (const name of Object.keys(names)) {
    const dependency = resolve(key, name);
    if (dependency) pending.push(dependency);
    else if (!optional.has(name)) throw new Error(`${name}, a dependency of ${key}, is not in package-lock.json`);
  }
}

const manifest = { name: 'commitlint-title', private: true, dependencies };
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(
  path.join(dir, 'package-lock.json'),
  `${JSON.stringify(
    {
      name: manifest.name,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': manifest,
        ...Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
      },
    },
    null,
    2,
  )}\n`,
);

// A title is linted by the repository's rules without commitlint's default ignores (merges,
// reverts, fixups, bare versions) and without the config's own ignores.
fs.writeFileSync(
  path.join(dir, 'title.config.mjs'),
  `import base from ${JSON.stringify(config)};
const config = typeof base === 'function' ? await base() : base;
export default { ...config, ignores: [], defaultIgnores: false };
`,
);
