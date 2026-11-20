// Writes the run model's words in each language of Piwi Picker but English (`src/words/<code>.json`), from Picker's
// catalogs (`apps/extension/public/_locales/<code>/messages.json`): the message of each key of `RUN_WORDS_EN`, a counted
// one in every plural form the catalog holds. Run it after a run word or its translation changes:
// `npm run run-model:words`. `apps/extension/tests/unit/run-words.test.ts` fails while a file differs.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const localesDir = path.resolve(root, '..', '..', 'apps', 'extension', 'public', '_locales');
const words = readFileSync(path.join(root, 'src', 'words.ts'), 'utf8');
const body = words.slice(words.indexOf('export const RUN_WORDS_EN = {'), words.indexOf('} as const;'));
const keys = [...body.matchAll(/^ {2}(runs_[A-Za-z0-9_]+):/gm)].map((match) => match[1]);
const plural = /_(zero|one|two|few|many|other)$/;
const bases = new Set(keys.filter((key) => key.endsWith('_other')).map((key) => key.slice(0, -'_other'.length)));

for (const code of readdirSync(localesDir).sort()) {
  if (code === 'en') continue;
  const catalog = JSON.parse(readFileSync(path.join(localesDir, code, 'messages.json'), 'utf8'));
  const out = {};
  for (const [key, entry] of Object.entries(catalog)) {
    const base = key.replace(plural, '');
    if (keys.includes(key) || (base !== key && bases.has(base))) out[key] = entry.message;
  }
  const missing = keys.filter((key) => !(key in out));
  if (missing.length) throw new Error(`${code}: no message for ${missing.join(', ')}`);
  writeFileSync(path.join(root, 'src', 'words', `${code}.json`), `${JSON.stringify(out, null, 2)}\n`);
}
