import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Every raw `<form>` of the app is `method="post"`, so a submit before the page hydrates sends its fields in the
 * body to the page's own URL, never in the query string. `UForm` renders `method="post"` itself, and
 * `tests/form-native-submit.spec.ts` submits the password forms without their handler.
 */

const APP_DIR = fileURLToPath(new URL('../../app/', import.meta.url));

/** A `<form>` opening tag, its quoted attribute values allowed to hold a `>`. */
const FORM_TAG_RE = /<form(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/g;

/** The `method="post"` attribute, alone in its tag. */
const METHOD_POST_RE = /\smethod="post"(?=[\s/>])/;

function formTags(source: string): { tag: string; offset: number }[] {
  return [...source.matchAll(FORM_TAG_RE)].map((m) => ({ tag: m[0], offset: m.index! }));
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

describe('raw forms submit by POST', () => {
  const files = readdirSync(APP_DIR, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.vue'));

  test('every <form> under app/ carries method="post"', () => {
    let forms = 0;
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(APP_DIR, file), 'utf8');
      const tags = formTags(source);
      forms += tags.length;
      return tags
        .filter(({ tag }) => !METHOD_POST_RE.test(tag))
        .map(({ offset }) => `app/${file}:${lineOf(source, offset)}`);
    });
    expect(forms).toBeGreaterThan(0);
    expect(offenders, 'add method="post" to the <form>, or build it with UForm').toEqual([]);
  });

  test('the patterns catch what they are meant to', () => {
    const source = [
      '<form class="a" @submit.prevent="save">',
      '<form',
      '  class="b"',
      '  method="post"',
      '  @submit.prevent="n > 0 && save()"',
      '>',
      '<form method="get">',
      '<form :method="m">',
      '<form>',
      '<FormField name="x">',
      '<formkit>',
      '<UForm :state="s">',
    ].join('\n');
    const tags = formTags(source);
    expect(tags.map(({ offset }) => lineOf(source, offset))).toEqual([1, 2, 7, 8, 9]);
    expect(tags.map(({ tag }) => METHOD_POST_RE.test(tag))).toEqual([false, true, false, false, false]);
  });
});
