import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * A side panel (`USlideover`) that sets its own width does it from `sm` up, as the theme's `sm:max-w-md` does: a
 * `max-w-*` without the variant keeps the theme's class beside it, which wins from `sm` up and leaves the panel at
 * 448 px. Below `sm` the panel spans the screen.
 */

const APP_DIR = fileURLToPath(new URL('../../app/', import.meta.url));

/** A `<USlideover>` opening tag, its quoted attribute values allowed to hold a `>`. */
const SLIDEOVER_TAG_RE = /<USlideover(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/g;

/** The literal classes of the tag's `content` slot: `:ui="{ content: '…' }"`. */
const CONTENT_CLASSES_RE = /\bcontent:\s*'([^']*)'/g;

/** A `max-w-*` class with no variant. */
const BARE_MAX_WIDTH_RE = /(?:^|\s)!?max-w-[^\s]+/;

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function bareWidths(source: string): number[] {
  return [...source.matchAll(SLIDEOVER_TAG_RE)].flatMap((tag) =>
    [...tag[0].matchAll(CONTENT_CLASSES_RE)].some((m) => BARE_MAX_WIDTH_RE.test(m[1]!)) ? [tag.index!] : [],
  );
}

describe('side panel widths', () => {
  const files = readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.vue'));

  test('every USlideover that sets a max-w-* sets it from sm up', () => {
    let panels = 0;
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(APP_DIR, file), 'utf8');
      panels += [...source.matchAll(SLIDEOVER_TAG_RE)].length;
      return bareWidths(source).map((offset) => `app/${file}:${lineOf(source, offset)}`);
    });
    expect(panels).toBeGreaterThan(0);
    expect(offenders, 'write the width as sm:max-w-*, the variant of the theme’s own').toEqual([]);
  });

  test('the patterns catch what they are meant to', () => {
    expect(bareWidths(`<USlideover v-model:open="open" :ui="{ content: 'max-w-3xl' }">`)).toHaveLength(1);
    expect(
      bareWidths(`<USlideover\n  :title="a > b ? 'x' : 'y'"\n  :ui="{ content: 'p-2 max-w-xl' }"\n>`),
    ).toHaveLength(1);
    expect(bareWidths(`<USlideover :ui="{ content: 'sm:max-w-3xl' }">`)).toEqual([]);
    expect(bareWidths(`<USlideover :ui="{ content: 'max-w-none sm:max-w-lg' }">`)).toHaveLength(1);
    expect(bareWidths(`<USlideover side="bottom" :ui="{ content: 'max-h-[85svh]' }">`)).toEqual([]);
  });
});
