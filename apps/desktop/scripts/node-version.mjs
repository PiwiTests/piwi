#!/usr/bin/env node
// The Node.js version the desktop app bundles: the tag of the server image's
// base, `FROM node:<version>-alpine…` in the root Dockerfile. Dependabot moves
// that tag every week, so the sidecar follows it with no version to bump by hand.
//
// Usage: node scripts/node-version.mjs   prints the version, e.g. 24.22.1
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = resolve(here, '../../../Dockerfile');

export function bundledNodeVersion() {
  const match = readFileSync(dockerfile, 'utf8').match(/^FROM node:(\d+\.\d+\.\d+)-/m);
  if (!match) throw new Error(`no "FROM node:<x.y.z>-…" line in ${dockerfile}`);
  return match[1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(bundledNodeVersion());
}
