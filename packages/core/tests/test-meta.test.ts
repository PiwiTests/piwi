import { describe, test, expect } from 'vitest';
import {
  addTagsTruncated,
  collectTagsTruncated,
  compileExternalIdPattern,
  keepTagsTruncated,
  formatTagsTruncatedTests,
  MAX_TAGS_TRUNCATED_EXAMPLES,
  MAX_TAGS_TRUNCATED_SUITE_DEPTH,
  MAX_TAGS_TRUNCATED_TEXT_CHARS,
  normalizeTestTagsWithDropped,
  readTagsTruncated,
  tagsTruncatedCount,
  isPiwiAnnotation,
  MAX_EXTERNAL_ID_CHARS,
  MAX_EXTERNAL_ID_DUPLICATES,
  mergeExternalIdDuplicates,
  normalizeExternalId,
  parseExternalId,
  readExternalIdFromTitle,
  normalizeTestLocks,
  normalizeTestTags,
  parseTestMetadata,
  sanitizeTestMetadata,
  MAX_TEST_LOCKS,
  MAX_TEST_LOCK_CHARS,
  MAX_TEST_TAGS,
  MAX_TEST_TAG_CHARS,
} from '../src/test-meta';

describe('normalizeTestTags', () => {
  test('strips the leading @ so a tag reads the same however it was declared', () => {
    expect(normalizeTestTags(['@smoke', 'regression'])).toEqual(['smoke', 'regression']);
  });

  test('collapses repeated @ and surrounding whitespace', () => {
    expect(normalizeTestTags(['  @@smoke  '])).toEqual(['smoke']);
  });

  test('preserves declaration order and drops duplicates', () => {
    expect(normalizeTestTags(['@b', '@a', 'b', '@a'])).toEqual(['b', 'a']);
  });

  test('drops non-strings and blanks rather than throwing', () => {
    expect(normalizeTestTags(['ok', 42, null, '', '   ', '@'])).toEqual(['ok']);
  });

  test('returns an empty array for anything that is not an array', () => {
    for (const input of [null, undefined, 'smoke', 7, {}]) {
      expect(normalizeTestTags(input)).toEqual([]);
    }
  });

  test('caps the number of tags', () => {
    const many = Array.from({ length: MAX_TEST_TAGS + 5 }, (_, i) => `tag${i}`);
    expect(normalizeTestTags(many)).toHaveLength(MAX_TEST_TAGS);
  });

  test('caps the length of a single tag', () => {
    const [tag] = normalizeTestTags(['x'.repeat(MAX_TEST_TAG_CHARS + 20)]);
    expect(tag).toHaveLength(MAX_TEST_TAG_CHARS);
  });
});

const tagList = (count: number, prefix = 'SHOP-T') => Array.from({ length: count }, (_, i) => `@${prefix}${i + 1}`);

describe('normalizeTestTagsWithDropped', () => {
  test('counts the distinct tags past the limit, in declaration order', () => {
    const { tags, dropped } = normalizeTestTagsWithDropped(tagList(MAX_TEST_TAGS + 5));
    expect(tags).toEqual(tagList(MAX_TEST_TAGS).map((tag) => tag.slice(1)));
    expect(dropped).toBe(5);
  });

  test('counts neither duplicates nor blanks, before or past the limit', () => {
    const raw = [...tagList(MAX_TEST_TAGS), '@SHOP-T1', 'SHOP-T2', '', '  ', '@', 42, '@extra'];
    expect(normalizeTestTagsWithDropped(raw)).toEqual({
      tags: tagList(MAX_TEST_TAGS).map((tag) => tag.slice(1)),
      dropped: 1,
    });
  });

  test('counts a tag repeated past the limit once', () => {
    expect(normalizeTestTagsWithDropped([...tagList(MAX_TEST_TAGS), '@x', 'x', '@x', '@y']).dropped).toBe(2);
  });

  test('drops nothing at the limit, and agrees with normalizeTestTags', () => {
    const raw = tagList(MAX_TEST_TAGS);
    expect(normalizeTestTagsWithDropped(raw).dropped).toBe(0);
    expect(normalizeTestTagsWithDropped(tagList(30)).tags).toEqual(normalizeTestTags(tagList(30)));
    expect(normalizeTestTagsWithDropped('nope')).toEqual({ tags: [], dropped: 0 });
  });
});

describe('collectTagsTruncated', () => {
  const test1 = { filePath: 'tests/cart.spec.ts', suitePath: ['cart'], title: 'pays', line: 4 };

  test('names each test that lost a tag, once across Playwright projects', () => {
    const found = collectTagsTruncated([
      { ...test1, tags: tagList(MAX_TEST_TAGS + 2) },
      { ...test1, tags: tagList(MAX_TEST_TAGS + 3) },
      { filePath: 'tests/cart.spec.ts', title: 'fits', tags: tagList(3) },
    ]);
    expect(found).toEqual({ tests: 1, examples: [{ ...test1, dropped: 3 }] });
  });

  test('counts every test and keeps the first examples', () => {
    const tests = Array.from({ length: MAX_TAGS_TRUNCATED_EXAMPLES + 4 }, (_, i) => ({
      filePath: 'tests/a.spec.ts',
      title: `t${i}`,
      tags: tagList(MAX_TEST_TAGS + 1),
    }));
    const found = collectTagsTruncated(tests)!;
    expect(found.tests).toBe(MAX_TAGS_TRUNCATED_EXAMPLES + 4);
    expect(found.examples).toHaveLength(MAX_TAGS_TRUNCATED_EXAMPLES);
  });

  test('is null when every test fits', () => {
    expect(collectTagsTruncated([{ filePath: 'a', title: 'b', tags: tagList(MAX_TEST_TAGS) }])).toBeNull();
  });
});

describe('readTagsTruncated', () => {
  test('drops malformed examples and never counts fewer tests than it lists', () => {
    expect(
      readTagsTruncated({
        tests: 0,
        examples: [{ filePath: 'a', title: 'b', dropped: 2 }, { filePath: 'a', title: 'c', dropped: 0 }, 'x', null],
      }),
    ).toEqual({ tests: 1, examples: [{ filePath: 'a', title: 'b', dropped: 2 }] });
    expect(readTagsTruncated({ tests: 'many', examples: [] })).toBeNull();
    expect(readTagsTruncated({ tests: 1e308, examples: [] })).toBeNull();
    expect(readTagsTruncated(null)).toBeNull();
  });
});

describe('readTagsTruncated limits', () => {
  const long = 'x'.repeat(MAX_TAGS_TRUNCATED_TEXT_CHARS + 100);
  const oversized = {
    filePath: `tests/${long}.spec.ts`,
    suitePath: Array.from({ length: MAX_TAGS_TRUNCATED_SUITE_DEPTH + 8 }, (_, i) => `${i}${long}`),
    title: long,
    line: 12,
    dropped: 2,
  };

  test('cuts the file path, title, describe entries and describe depth', () => {
    const [example] = readTagsTruncated({ tests: 1, examples: [oversized] })!.examples;
    expect(example!.filePath).toBe(oversized.filePath.slice(0, MAX_TAGS_TRUNCATED_TEXT_CHARS));
    expect(example!.title).toHaveLength(MAX_TAGS_TRUNCATED_TEXT_CHARS);
    expect(example!.suitePath).toHaveLength(MAX_TAGS_TRUNCATED_SUITE_DEPTH);
    expect(example!.suitePath!.every((entry) => entry.length === MAX_TAGS_TRUNCATED_TEXT_CHARS)).toBe(true);
    expect(example!.suitePath![0]).toBe(oversized.suitePath[0]!.slice(0, MAX_TAGS_TRUNCATED_TEXT_CHARS));
  });

  test('keeps a line that is a positive safe integer and omits any other', () => {
    const lineOf = (line: unknown) =>
      readTagsTruncated({ tests: 1, examples: [{ filePath: 'a', title: 'b', dropped: 1, line }] })!.examples[0]!.line;
    expect(lineOf(12)).toBe(12);
    for (const line of [-3, 0, 1.5, Infinity, NaN, 2 ** 60, '12', null]) expect(lineOf(line)).toBeUndefined();
  });

  test('a collected oversized test and its read form are one test', () => {
    const collected = collectTagsTruncated([{ ...oversized, tags: tagList(MAX_TEST_TAGS + 2) }])!;
    expect(collected.examples[0]!.title).toHaveLength(MAX_TAGS_TRUNCATED_TEXT_CHARS);
    expect(readTagsTruncated(collected)).toEqual(collected);
  });

  test('merging an oversized report with its cut form counts the test once', () => {
    const cut = readTagsTruncated({ tests: 1, examples: [oversized] })!;
    const raw = { tests: 1, examples: [oversized] };
    expect(keepTagsTruncated(cut, raw)).toEqual(cut);
    expect(keepTagsTruncated(raw, cut)).toEqual(cut);
    expect(addTagsTruncated(cut, raw)).toEqual(cut);
  });
});

test('readTagsTruncated keeps each test once and caps the examples', () => {
  const examples = Array.from({ length: MAX_TAGS_TRUNCATED_EXAMPLES + 5 }, (_, i) => ({
    filePath: 'a',
    title: `t${i % (MAX_TAGS_TRUNCATED_EXAMPLES + 2)}`,
    dropped: 1,
  }));
  const read = readTagsTruncated({ tests: 40, examples })!;
  expect(read.tests).toBe(40);
  expect(read.examples).toHaveLength(MAX_TAGS_TRUNCATED_EXAMPLES);
  expect(new Set(read.examples.map((e) => e.title)).size).toBe(MAX_TAGS_TRUNCATED_EXAMPLES);
});

describe('merging tagsTruncated', () => {
  const a = { filePath: 'a.spec.ts', title: 'A', dropped: 1 };
  const b = { filePath: 'b.spec.ts', title: 'B', dropped: 2 };

  test('a report sent again counts once, even past the examples', () => {
    const report = { tests: 30, examples: [a, b] };
    expect(keepTagsTruncated(report, report)).toEqual(report);
    expect(keepTagsTruncated(null, report)).toEqual(report);
  });

  test("other shards' reports add up, less the tests both list", () => {
    expect(addTagsTruncated({ tests: 3, examples: [a] }, { tests: 2, examples: [b] })).toEqual({
      tests: 5,
      examples: [a, b],
    });
    expect(addTagsTruncated({ tests: 1, examples: [a] }, { tests: 2, examples: [a, b] })).toEqual({
      tests: 2,
      examples: [a, b],
    });
    expect(addTagsTruncated(undefined, { tests: 1, examples: [a] })).toEqual({ tests: 1, examples: [a] });
    expect(addTagsTruncated(undefined, undefined)).toBeNull();
  });
});

describe('tagsTruncatedCount', () => {
  const example = (i: number) => ({ filePath: 'a.spec.ts', title: `t${i}`, dropped: 1 });
  const examples = (n: number) => Array.from({ length: n }, (_, i) => example(i));

  test('is the exact count while the examples list every test', () => {
    const one = { tests: 1, examples: examples(1) };
    expect(tagsTruncatedCount(one)).toEqual({ count: 1, atLeast: false });
    expect(formatTagsTruncatedTests(one)).toBe('1 test');
    const some = { tests: 5, examples: examples(5) };
    expect(tagsTruncatedCount(some)).toEqual({ count: 5, atLeast: false });
    expect(formatTagsTruncatedTests(some)).toBe('5 tests');
    const full = { tests: MAX_TAGS_TRUNCATED_EXAMPLES, examples: examples(MAX_TAGS_TRUNCATED_EXAMPLES) };
    expect(tagsTruncatedCount(full)).toEqual({ count: MAX_TAGS_TRUNCATED_EXAMPLES, atLeast: false });
  });

  test('is at least the examples kept, never the stored count, when that is above them', () => {
    const report = { tests: 47, examples: examples(MAX_TAGS_TRUNCATED_EXAMPLES) };
    expect(tagsTruncatedCount(report)).toEqual({ count: MAX_TAGS_TRUNCATED_EXAMPLES, atLeast: true });
    expect(formatTagsTruncatedTests(report)).toBe(`at least ${MAX_TAGS_TRUNCATED_EXAMPLES} tests`);
  });

  test('shows at least the examples kept for two overlapping reports merged past the examples', () => {
    const shard = (from: number) => ({
      tests: MAX_TAGS_TRUNCATED_EXAMPLES + 10,
      examples: examples(MAX_TAGS_TRUNCATED_EXAMPLES).map((_, i) => example(from + i)),
    });
    const merged = addTagsTruncated(shard(0), shard(5))!;
    expect(merged.examples).toHaveLength(MAX_TAGS_TRUNCATED_EXAMPLES);
    expect(merged.tests).toBeGreaterThan(merged.examples.length);
    expect(tagsTruncatedCount(merged)).toEqual({ count: MAX_TAGS_TRUNCATED_EXAMPLES, atLeast: true });
  });
});

describe('normalizeTestLocks', () => {
  test('keeps lock names verbatim, no @ stripping', () => {
    expect(normalizeTestLocks(['database', 'external-api'])).toEqual(['database', 'external-api']);
  });

  test('preserves declaration order and drops duplicates', () => {
    expect(normalizeTestLocks(['db', 'api', 'db'])).toEqual(['db', 'api']);
  });

  test('trims and drops non-strings and blanks rather than throwing', () => {
    expect(normalizeTestLocks(['  db  ', 42, null, '', '   '])).toEqual(['db']);
  });

  test('returns an empty array for anything that is not an array', () => {
    for (const input of [null, undefined, 'db', 7, {}]) {
      expect(normalizeTestLocks(input)).toEqual([]);
    }
  });

  test('caps the number of locks', () => {
    const many = Array.from({ length: MAX_TEST_LOCKS + 5 }, (_, i) => `lock${i}`);
    expect(normalizeTestLocks(many)).toHaveLength(MAX_TEST_LOCKS);
  });

  test('caps the length of a single lock', () => {
    const [lock] = normalizeTestLocks(['x'.repeat(MAX_TEST_LOCK_CHARS + 20)]);
    expect(lock).toHaveLength(MAX_TEST_LOCK_CHARS);
  });
});

describe('parseTestMetadata', () => {
  test('reads every supported field', () => {
    expect(
      parseTestMetadata([
        { type: 'piwi:owner', description: '@checkout-team' },
        { type: 'piwi:priority', description: 'critical' },
        { type: 'piwi:feature', description: 'Checkout' },
        { type: 'piwi:link', description: 'https://example.com/PROJ-1' },
      ]),
    ).toEqual({
      owner: '@checkout-team',
      priority: 'critical',
      feature: 'Checkout',
      link: 'https://example.com/PROJ-1',
    });
  });

  test('ignores Playwright test marks', () => {
    expect(parseTestMetadata([{ type: 'skip' }, { type: 'slow', description: 'flaky on CI' }])).toBeNull();
  });

  test('matches the annotation type case-insensitively', () => {
    expect(parseTestMetadata([{ type: 'PIWI:Owner', description: 'team' }])).toEqual({ owner: 'team' });
  });

  test('drops a priority outside the known set', () => {
    expect(parseTestMetadata([{ type: 'piwi:priority', description: 'urgent' }])).toBeNull();
  });

  test('normalizes priority case', () => {
    expect(parseTestMetadata([{ type: 'piwi:priority', description: 'HIGH' }])).toEqual({ priority: 'high' });
  });

  test('a later annotation of the same field wins', () => {
    expect(
      parseTestMetadata([
        { type: 'piwi:owner', description: 'first' },
        { type: 'piwi:owner', description: 'second' },
      ]),
    ).toEqual({ owner: 'second' });
  });

  test('ignores unknown piwi: fields', () => {
    expect(parseTestMetadata([{ type: 'piwi:severity', description: 'blocker' }])).toBeNull();
  });

  test('returns null rather than an empty object when nothing was declared', () => {
    expect(parseTestMetadata([])).toBeNull();
    expect(parseTestMetadata(null)).toBeNull();
    expect(parseTestMetadata('nope')).toBeNull();
  });

  // A link is rendered as an anchor in the dashboard and in pull-request
  // comments, so a non-http scheme must never survive parsing.
  test.each(['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'not a url', 'ftp://host/x'])(
    'rejects the unsafe link %s',
    (link) => {
      expect(parseTestMetadata([{ type: 'piwi:link', description: link }])).toBeNull();
    },
  );

  test.each(['http://example.com/a', 'https://example.com/a?b=c#d'])('accepts the http(s) link %s', (link) => {
    expect(parseTestMetadata([{ type: 'piwi:link', description: link }])).toEqual({ link });
  });

  test('reads a bug report id from piwi:bug, with or without a leading #', () => {
    expect(parseTestMetadata([{ type: 'piwi:bug', description: '37' }])).toEqual({ bug: '37' });
    expect(parseTestMetadata([{ type: 'piwi:bug', description: '#37' }])).toEqual({ bug: '37' });
  });

  test('reads the largest id a report can have', () => {
    expect(parseTestMetadata([{ type: 'piwi:bug', description: '2147483647' }])).toEqual({ bug: '2147483647' });
  });

  test.each(['0', 'abc', '12a', '-3', '1234567890123', '2147483648', '99999999999'])('ignores the bug id %s', (id) => {
    expect(parseTestMetadata([{ type: 'piwi:bug', description: id }])).toBeNull();
  });

  test('survives malformed annotation entries', () => {
    expect(parseTestMetadata([null, 42, {}, { type: 7 }, { type: 'piwi:owner' }])).toBeNull();
  });
});

describe('sanitizeTestMetadata', () => {
  test('applies the same rules to an already-shaped object', () => {
    expect(
      sanitizeTestMetadata({ owner: 'team', priority: 'nonsense', link: 'javascript:x', feature: 'Cart' }),
    ).toEqual({ owner: 'team', feature: 'Cart' });
  });

  test('returns null for non-objects and arrays', () => {
    for (const input of [null, undefined, 'x', 3, []]) {
      expect(sanitizeTestMetadata(input)).toBeNull();
    }
  });

  test('ignores non-string values', () => {
    expect(sanitizeTestMetadata({ owner: 42, feature: 'Cart' })).toEqual({ feature: 'Cart' });
  });
});

describe('isPiwiAnnotation', () => {
  test('separates Piwi metadata from Playwright marks', () => {
    expect(isPiwiAnnotation('piwi:owner')).toBe(true);
    expect(isPiwiAnnotation('PIWI:LINK')).toBe(true);
    expect(isPiwiAnnotation('skip')).toBe(false);
    expect(isPiwiAnnotation(null)).toBe(false);
  });

  test("counts the reporter's own annotations as Piwi's", () => {
    expect(isPiwiAnnotation('piwi-locator-suggestion')).toBe(true);
    expect(isPiwiAnnotation('piwis')).toBe(false);
  });
});

describe('normalizeExternalId', () => {
  test('trims and keeps case', () => {
    expect(normalizeExternalId('  AB-12  ')).toBe('AB-12');
  });

  test('drops blanks, non-strings, control characters and over-long values', () => {
    for (const input of ['', '   ', 12526, null, undefined, 'a\nb', 'x'.repeat(MAX_EXTERNAL_ID_CHARS + 1)]) {
      expect(normalizeExternalId(input)).toBeUndefined();
    }
    expect(normalizeExternalId('x'.repeat(MAX_EXTERNAL_ID_CHARS))).toHaveLength(MAX_EXTERNAL_ID_CHARS);
  });
});

describe('parseExternalId', () => {
  test('reads piwi:id, case-insensitively, the last one winning', () => {
    expect(
      parseExternalId([
        { type: 'piwi:owner', description: '@team' },
        { type: 'PIWI:ID', description: ' 1 ' },
        { type: 'piwi:id', description: '2' },
      ]),
    ).toBe('2');
  });

  test('ignores an invalid value and returns undefined without an annotation', () => {
    expect(parseExternalId([{ type: 'piwi:id', description: '   ' }])).toBeUndefined();
    expect(parseExternalId([{ type: 'piwi:id' }])).toBeUndefined();
    expect(parseExternalId(null)).toBeUndefined();
  });

  test('is not read as metadata', () => {
    expect(parseTestMetadata([{ type: 'piwi:id', description: '12526' }])).toBeNull();
  });
});

describe('readExternalIdFromTitle', () => {
  test('takes the first capture group and removes the whole match from the title', () => {
    const pattern = compileExternalIdPattern(/^(\d+),\s*/);
    expect(readExternalIdFromTitle('12526, Log in modal: Log in with Email', pattern)).toEqual({
      externalId: '12526',
      displayTitle: 'Log in modal: Log in with Email',
    });
  });

  test('takes the whole match when the pattern has no group', () => {
    expect(readExternalIdFromTitle('Checkout [TC-7] pays', compileExternalIdPattern('TC-\\d+'))).toEqual({
      externalId: 'TC-7',
      displayTitle: 'Checkout [] pays',
    });
  });

  test('returns null when the pattern does not match', () => {
    expect(readExternalIdFromTitle('No id here', compileExternalIdPattern(/^(\d+),/))).toBeNull();
  });

  test('leaves out the display title when nothing is left', () => {
    expect(readExternalIdFromTitle('12526', compileExternalIdPattern(/\d+/))).toEqual({ externalId: '12526' });
  });

  test('does not depend on the previous match of a global pattern', () => {
    const pattern = compileExternalIdPattern(/(\d+)/g);
    expect(readExternalIdFromTitle('1 a', pattern)?.externalId).toBe('1');
    expect(readExternalIdFromTitle('2 b', pattern)?.externalId).toBe('2');
  });

  test('throws on a string that is not a regular expression', () => {
    expect(() => compileExternalIdPattern('(')).toThrow();
  });
});

describe('mergeExternalIdDuplicates', () => {
  test('lists each ID once with every distinct test', () => {
    const shard1 = [{ externalId: '7', tests: [{ filePath: 'a.spec.ts', title: 'A', line: 3 }] }];
    const shard2 = [
      {
        externalId: '7',
        tests: [
          { filePath: 'a.spec.ts', title: 'A', line: 3 },
          { filePath: 'b.spec.ts', suitePath: ['Cart'], title: 'B' },
        ],
      },
    ];
    expect(mergeExternalIdDuplicates(shard1, shard2)).toEqual([
      {
        externalId: '7',
        tests: [
          { filePath: 'a.spec.ts', title: 'A', line: 3 },
          { filePath: 'b.spec.ts', suitePath: ['Cart'], title: 'B' },
        ],
      },
    ]);
  });

  test('drops malformed entries and caps the list', () => {
    const many = Array.from({ length: MAX_EXTERNAL_ID_DUPLICATES + 3 }, (_, i) => ({
      externalId: String(i),
      tests: [{ filePath: 'a.spec.ts', title: 'A' }],
    }));
    const merged = mergeExternalIdDuplicates(
      null,
      [{ externalId: 5 }, { externalId: 'x', tests: [{ title: 1 }] }],
      many,
    );
    expect(merged).toHaveLength(MAX_EXTERNAL_ID_DUPLICATES);
    expect(merged[0]?.externalId).toBe('0');
  });
});
