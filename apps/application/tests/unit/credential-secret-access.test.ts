import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * A credential's secret is read only by `server/utils/credentials.ts`, whose
 * `withCredential` checks the credential's rules and logs the use before it
 * opens it. Any other code of the server, the shared modules or the app (the
 * demo included) that reads the secret column, or selects whole credential
 * rows, fails here. The schema and the migrations declare the column and are
 * not scanned.
 */

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED = ['server', 'shared', 'app'];
const SKIPPED = ['server/database/'];
const OWNER = 'server/utils/credentials.ts';
const EXTENSIONS = /\.(ts|mts|cts|js|mjs|cjs|vue)$/;

/** The ways code reads the secret column or a whole credential row. */
const SECRET_READS: Array<{ what: string; pattern: RegExp }> = [
  { what: 'reads the secret column', pattern: /\bcredentials\s*\.\s*secret\b/ },
  { what: 'reads the secret column by its name', pattern: /\bcredentials\s*\[\s*['"`]secret['"`]\s*\]/ },
  {
    what: 'selects whole credential rows',
    pattern: /\.select\(\s*\)\s*\.from\(\s*(?:[\w$]+\.)?credentials\s*\)/,
  },
  { what: 'selects every column of the credentials', pattern: /getTableColumns\(\s*(?:[\w$]+\.)?credentials\s*\)/ },
  { what: 'queries credential rows', pattern: /\.query\s*\.\s*credentials\b/ },
  {
    what: 'reads credential rows in SQL',
    pattern: /\bselect\s+(?:\*|[\w."`]+(?:\s*,\s*[\w."`]+)*)\s+from\s+["`]?credentials["`]?(?!\w)/i,
  },
];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (EXTENSIONS.test(entry.name)) files.push(path);
  }
  return files;
}

const files = SCANNED.flatMap((dir) => sourceFiles(join(APP_ROOT, dir)))
  .map((path) => relative(APP_ROOT, path).split(sep).join('/'))
  .filter((path) => !SKIPPED.some((skipped) => path.startsWith(skipped)));

/** What a file does with the secret, one entry per kind of read. */
function secretReads(text: string): string[] {
  return SECRET_READS.filter(({ pattern }) => pattern.test(text)).map(({ what }) => what);
}

describe('the credential secret', () => {
  test('is read by server/utils/credentials.ts alone', () => {
    const offenders = files
      .filter((path) => path !== OWNER)
      .flatMap((path) => secretReads(readFileSync(join(APP_ROOT, path), 'utf8')).map((what) => `${path} ${what}`));
    expect(offenders).toEqual([]);
  });

  test('the scan covers the code that handles credentials', () => {
    for (const path of [OWNER, 'shared/handlers/credentials.ts', 'server/utils/ci-server-dispatch.ts']) {
      expect(files).toContain(path);
    }
    expect(files.some((path) => path.startsWith('app/demo/'))).toBe(true);
    expect(files.some((path) => path.startsWith('server/database/'))).toBe(false);
    expect(secretReads(readFileSync(join(APP_ROOT, OWNER), 'utf8'))).toContain('reads the secret column');
  });

  test('the patterns find each way of reading it', () => {
    const reads = [
      'db.select({ secret: credentials.secret }).from(credentials)',
      'const [row] = await tx.select().from(credentials).where(eq(credentials.id, id));',
      'await db\n  .select()\n  .from(schema.credentials)',
      'db.select(getTableColumns(credentials)).from(credentials)',
      'await db.query.credentials.findFirst()',
      'row = credentials["secret"]',
      'sql`SELECT * FROM credentials WHERE id = ${id}`',
      'sql`select secret from "credentials"`',
      'sql`select id, secret from credentials`',
    ];
    for (const text of reads) expect(secretReads(text), text).not.toEqual([]);
    const allowed = [
      'db.select({ id: credentials.id, name: credentials.name }).from(credentials)',
      'db.select().from(credentialUses)',
      'db.select().from(credentialProjects)',
      'await db.update(credentials).set({ secret: sealed })',
      'select id from credential_uses',
      'Only the credential manager reads a secret from credentials it stores.',
    ];
    for (const text of allowed) expect(secretReads(text), text).toEqual([]);
  });
});
