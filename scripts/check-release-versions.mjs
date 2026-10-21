#!/usr/bin/env node
// Checks that every file release-please stamps carries the release version: the root
// package.json and package-lock.json, and each `extra-files` entry of
// release-please-config.json, read the way release-please writes it (a `jsonpath` in a
// JSON file, a `[[package]]` entry picked by name in Cargo.lock, the
// `x-release-please-version` markers in any other file). CI runs it on
// every pull request, and it is the only check the release PR gets.
//
// Usage:
//   node scripts/check-release-versions.mjs
//
// Exits 1 and lists each file that disagrees with .release-please-manifest.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

/** Reads a `jsonpath` of the shape release-please-config.json uses: `$.a.b`, `$.a['b/c'].d`, `$.a[''].b`. */
function readJsonPath(data, jsonpath) {
  if (!jsonpath.startsWith('$')) throw new Error(`unsupported jsonpath: ${jsonpath}`);
  const keys = [...jsonpath.slice(1).matchAll(/\.([A-Za-z_$][\w$]*)|\['([^']*)'\]/g)].map((m) => m[1] ?? m[2]);
  return keys.reduce((value, key) => (value == null ? undefined : value[key]), data);
}

/**
 * Reads the version of one `[[package]]` entry of a Cargo.lock, picked by name the way
 * release-please-config.json does: `$.package[?(@.name.value == 'name')].version`.
 */
function readCargoLockVersion(text, jsonpath) {
  const name = jsonpath.match(/^\$\.package\[\?\(@\.name\.value == '([^']+)'\)\]\.version$/)?.[1];
  if (!name) throw new Error(`unsupported toml jsonpath: ${jsonpath}`);
  for (const entry of text.split(/^\[\[package\]\]\r?$/m)) {
    if (entry.match(/^name = "([^"]*)"/m)?.[1] === name) return entry.match(/^version = "([^"]*)"/m)?.[1];
  }
  return undefined;
}

/** The versions on the lines release-please's generic updater stamps: a marked line, or every line of a marked block. */
function markedVersions(text) {
  const versions = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes('x-release-please-start-version')) {
      inBlock = true;
      continue;
    }
    if (line.includes('x-release-please-end')) {
      inBlock = false;
      continue;
    }
    if (!inBlock && !line.includes('x-release-please-version')) continue;
    const match = line.match(SEMVER);
    if (match) versions.push(match[0]);
  }
  return versions;
}

const expected = readJson('.release-please-manifest.json')['.'];
const config = readJson('release-please-config.json');
const problems = [];

function check(where, actual) {
  if (actual !== expected) problems.push(`${where}: ${actual === undefined ? 'no version found' : actual}`);
}

check('package.json $.version', readJson('package.json').version);
const lock = readJson('package-lock.json');
check('package-lock.json $.version', lock.version);
check(`package-lock.json $.packages['']`, lock.packages?.['']?.version);

for (const { type, path: file, jsonpath } of config.packages['.']['extra-files'] ?? []) {
  if (type === 'json') {
    check(`${file} ${jsonpath}`, readJsonPath(readJson(file), jsonpath));
    continue;
  }
  if (type === 'toml') {
    check(`${file} ${jsonpath}`, readCargoLockVersion(fs.readFileSync(path.join(root, file), 'utf8'), jsonpath));
    continue;
  }
  const versions = markedVersions(fs.readFileSync(path.join(root, file), 'utf8'));
  if (versions.length === 0) check(file, undefined);
  for (const version of versions) check(file, version);
}

if (problems.length > 0) {
  console.error(`These files do not carry the release version ${expected}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Every file release-please stamps carries ${expected}.`);
