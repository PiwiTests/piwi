import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * A left or right side panel (`USlideover`) that sets its own width sets it from `sm` up, as the theme's
 * `sm:max-w-md` does: a `max-w-*` without the `sm:` variant, or with a wider one only (`md:`), keeps the theme's
 * class beside it, which wins from `sm` up and leaves the panel at 448 px. A top or bottom panel has no theme width.
 * The test reads the class strings written in the tag: its `class` attribute and each string of `:ui`'s `content`
 * (both branches of a ternary, every item of an array).
 */

const APP_DIR = fileURLToPath(new URL('../../app/', import.meta.url));

/** A `<USlideover>` opening tag, its quoted attribute values allowed to hold a `>`. */
const SLIDEOVER_TAG_RE = /<USlideover(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/g;

/** A panel along the top or bottom edge. */
const TOP_OR_BOTTOM_RE = /\sside=(["'])(?:top|bottom)\1/;

/** The tag's static `class` attribute. */
const CLASS_ATTR_RE = /\sclass=(?:"([^"]*)"|'([^']*)')/;

/** The value of `:ui`'s `content` key: an array, else up to the next key or the object's end. */
const CONTENT_VALUE_RE = /\bcontent:\s*(\[[^\]]*\]|[^,}]*)/g;

/** A quoted or backquoted string. */
const STRING_RE = /'([^']*)'|"([^"]*)"|`([^`]*)`/g;

/** A width class, with any variant: `max-w-3xl`, `md:max-w-xl`, `!max-w-lg`. */
const WIDTH_RE = /(?:^|:|!)max-w-/;

/** The width class the theme's `sm:max-w-md` gives way to. */
const SM_WIDTH_RE = /^!?sm:!?max-w-/;

function contentClassStrings(tag: string): string[] {
  const strings: string[] = [];
  const attr = CLASS_ATTR_RE.exec(tag);
  if (attr) strings.push(attr[1] ?? attr[2] ?? '');
  for (const content of tag.matchAll(CONTENT_VALUE_RE)) {
    for (const literal of content[1]!.matchAll(STRING_RE)) strings.push(literal[1] ?? literal[2] ?? literal[3] ?? '');
  }
  return strings;
}

/** A class string that sets a width the theme's `sm:max-w-md` wins over. */
function losesToTheme(classes: string): boolean {
  const tokens = classes.split(/\s+/).filter(Boolean);
  return tokens.some((t) => WIDTH_RE.test(t)) && !tokens.some((t) => SM_WIDTH_RE.test(t));
}

function narrowedPanels(source: string): number[] {
  return [...source.matchAll(SLIDEOVER_TAG_RE)].flatMap((tag) =>
    !TOP_OR_BOTTOM_RE.test(tag[0]) && contentClassStrings(tag[0]).some(losesToTheme) ? [tag.index!] : [],
  );
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

describe('side panel widths', () => {
  const files = readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.vue'));

  test('every left or right USlideover that sets a width sets it from sm up', () => {
    let panels = 0;
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(APP_DIR, file), 'utf8');
      panels += [...source.matchAll(SLIDEOVER_TAG_RE)].length;
      return narrowedPanels(source).map((offset) => `app/${file}:${lineOf(source, offset)}`);
    });
    expect(panels).toBeGreaterThan(0);
    expect(offenders, 'write the width as sm:max-w-*, the variant of the theme’s own').toEqual([]);
  });

  test('the patterns catch what they are meant to', () => {
    const caught = [
      `<USlideover v-model:open="open" :ui="{ content: 'max-w-3xl' }">`,
      `<USlideover\n  :title="a > b ? 'x' : 'y'"\n  :ui="{ content: 'p-2 max-w-xl' }"\n>`,
      `<USlideover :ui="{ content: 'md:max-w-3xl' }">`,
      `<USlideover :ui="{ content: wide ? 'sm:max-w-3xl' : 'max-w-xl' }">`,
      `<USlideover :ui="{ content: ['max-w-3xl', 'p-2'] }">`,
      `<USlideover :ui="{ content: \`max-w-3xl\` }">`,
      `<USlideover :ui='{ content: "max-w-3xl" }'>`,
      `<USlideover class="max-w-3xl">`,
      `<USlideover side="left" :ui="{ content: 'max-w-xl' }">`,
    ];
    for (const tag of caught) expect(narrowedPanels(tag), tag).toHaveLength(1);
    const passed = [
      `<USlideover :ui="{ content: 'sm:max-w-3xl' }">`,
      `<USlideover :ui="{ content: 'max-w-none sm:max-w-lg' }">`,
      `<USlideover :ui="{ content: 'sm:max-w-3xl top-[var(--x,0px)]!' }">`,
      `<USlideover side="bottom" :ui="{ content: 'max-h-[85svh] max-w-3xl' }">`,
      `<USlideover v-model:open="open" title="Credential">`,
    ];
    for (const tag of passed) expect(narrowedPanels(tag), tag).toEqual([]);
  });
});
