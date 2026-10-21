import { describe, test, expect } from 'vitest';
import {
  applyTestSearchSuggestion,
  CATALOG_SEARCH_FIELDS,
  collectTestSearchValues,
  compileTestSearch,
  completeTestSearch,
  formatTestSearchTerm,
  formatTestSearchValue,
  highlightRanges,
  parseTestSearch,
  RUN_SEARCH_FIELDS,
  testSearchHighlights,
  tokenizeTestSearch,
  type TestSearchSubject,
} from '#shared/test-search';

const login: TestSearchSubject = {
  title: 'login via header',
  suitePath: ['Authentication', 'Header'],
  filePath: 'tests/auth.spec.ts',
  error: 'TimeoutError: locator.click: Timeout 30000ms exceeded',
  tags: ['smoke', 'auth'],
  locks: ['db'],
  browser: 'chromium',
  owner: '@team/identity',
  priority: 'high',
  feature: 'sign-in',
  externalId: 'TC-12',
};
const cart: TestSearchSubject = {
  title: 'cart shows items',
  suitePath: ['Cart'],
  filePath: 'tests/shop/cart.spec.ts',
  error: 'Expected string: "3 items"\nReceived string: "0 items"',
  tags: ['api'],
  locks: [],
  browser: 'firefox',
  owner: null,
  priority: null,
  feature: 'checkout',
  externalId: 'TC-7',
};
const home: TestSearchSubject = {
  title: 'homepage loads',
  suitePath: [],
  filePath: 'tests/home.spec.ts',
  error: null,
  tags: [],
  browser: 'chromium',
};
const ALL = [login, cart, home];

function titles(query: string, fields = RUN_SEARCH_FIELDS): string[] {
  const matches = compileTestSearch(parseTestSearch(query, fields));
  return ALL.filter(matches).map((subject) => subject.title);
}

describe('tokenizeTestSearch', () => {
  test('splits words, qualifiers, phrases and exclusions with their offsets', () => {
    const tokens = tokenizeTestSearch('login file:auth.spec.ts -tag:slow "guest checkout" describe:"Sign in"');
    expect(tokens.map(({ field, value, negated, quoted }) => ({ field, value, negated, quoted }))).toEqual([
      { field: null, value: 'login', negated: false, quoted: false },
      { field: 'file', value: 'auth.spec.ts', negated: false, quoted: false },
      { field: 'tag', value: 'slow', negated: true, quoted: false },
      { field: null, value: 'guest checkout', negated: false, quoted: true },
      { field: 'describe', value: 'Sign in', negated: false, quoted: true },
    ]);
    expect(tokens[1]).toMatchObject({ start: 6, end: 23 });
  });

  test('reads aliases and keys in any case, and an unknown key as a free word', () => {
    const tokens = tokenizeTestSearch('PATH:a suite:b Test:c project:d status:failed');
    expect(tokens.map((token) => token.field)).toEqual(['file', 'describe', 'title', 'browser', null]);
    expect(tokens[4]!.value).toBe('status:failed');
  });

  test('reads a qualifier the list does not have as a free word', () => {
    const [token] = tokenizeTestSearch('error:timeout', CATALOG_SEARCH_FIELDS);
    expect(token).toMatchObject({ field: null, value: 'error:timeout' });
  });

  test('runs an unclosed quote to the end and unescapes quotes inside one', () => {
    expect(tokenizeTestSearch('title:"say \\"hi\\" twice').map((token) => token.value)).toEqual(['say "hi" twice']);
    expect(tokenizeTestSearch('"half open').map((token) => token.value)).toEqual(['half open']);
  });
});

describe('parseTestSearch', () => {
  test('leaves out incomplete terms and wildcard-only text', () => {
    expect(parseTestSearch('file: - * title:** tag:@').terms).toEqual([]);
  });

  test('drops the @ of a tag value', () => {
    expect(parseTestSearch('tag:@smoke').terms).toEqual([{ field: 'tag', value: 'smoke', negated: false }]);
  });
});

describe('compileTestSearch', () => {
  test('a free word looks in the title, the describe blocks, the file and the error', () => {
    expect(titles('header')).toEqual(['login via header']);
    expect(titles('authentication')).toEqual(['login via header']);
    expect(titles('shop/')).toEqual(['cart shows items']);
    expect(titles('"0 items"')).toEqual(['cart shows items']);
  });

  test('the catalog has no error text to look in', () => {
    expect(titles('timeout', CATALOG_SEARCH_FIELDS)).toEqual([]);
  });

  test('every word must match, in any field', () => {
    expect(titles('login auth.spec')).toEqual(['login via header']);
    expect(titles('login cart')).toEqual([]);
  });

  test('a qualifier matches its own field only', () => {
    expect(titles('title:header')).toEqual(['login via header']);
    expect(titles('title:auth')).toEqual([]);
    expect(titles('file:auth')).toEqual(['login via header']);
    expect(titles('describe:head')).toEqual(['login via header']);
    expect(titles('error:"0 items"')).toEqual(['cart shows items']);
  });

  test('a star matches any characters in a text field', () => {
    expect(titles('file:tests/*.spec.ts')).toEqual(['login via header', 'cart shows items', 'homepage loads']);
    expect(titles('file:shop*cart')).toEqual(['cart shows items']);
    expect(titles('title:login*header')).toEqual(['login via header']);
  });

  test('tag, lock, browser, owner, priority and feature match a whole value, ignoring case', () => {
    expect(titles('tag:SMOKE')).toEqual(['login via header']);
    expect(titles('tag:smo')).toEqual([]);
    expect(titles('lock:db')).toEqual(['login via header']);
    expect(titles('browser:chromium')).toEqual(['login via header', 'homepage loads']);
    expect(titles('project:firefox')).toEqual(['cart shows items']);
    expect(titles('owner:@team/identity')).toEqual(['login via header']);
    expect(titles('priority:high')).toEqual(['login via header']);
    expect(titles('feature:checkout')).toEqual(['cart shows items']);
  });

  test('id matches a whole external ID, and repeated it matches any of them', () => {
    expect(titles('id:tc-12')).toEqual(['login via header']);
    expect(titles('id:TC-1')).toEqual([]);
    expect(titles('id:TC-12 id:TC-7')).toEqual(['login via header', 'cart shows items']);
    expect(titles('-id:TC-12')).toEqual(['cart shows items', 'homepage loads']);
  });

  test('a repeated single-value qualifier widens, a repeated multi-value one narrows', () => {
    expect(titles('file:auth file:cart')).toEqual(['login via header', 'cart shows items']);
    expect(titles('browser:firefox browser:chromium')).toEqual([
      'login via header',
      'cart shows items',
      'homepage loads',
    ]);
    expect(titles('tag:smoke tag:auth')).toEqual(['login via header']);
    expect(titles('tag:smoke tag:api')).toEqual([]);
  });

  test('a minus excludes, and an excluded missing value keeps the test', () => {
    expect(titles('-file:auth')).toEqual(['cart shows items', 'homepage loads']);
    expect(titles('-login')).toEqual(['cart shows items', 'homepage loads']);
    expect(titles('-owner:@team/identity')).toEqual(['cart shows items', 'homepage loads']);
    expect(titles('-tag:smoke browser:chromium')).toEqual(['homepage loads']);
  });

  test('an empty query matches everything', () => {
    expect(titles('')).toEqual(['login via header', 'cart shows items', 'homepage loads']);
  });

  test('accents never matter, in the query or in the test', () => {
    const cafe: TestSearchSubject = {
      title: 'Café crème commande',
      suitePath: ['Préférences'],
      filePath: 'tests/café.spec.ts',
      tags: ['Été'],
      owner: 'José',
    };
    const matches = (query: string) => compileTestSearch(parseTestSearch(query))(cafe);
    expect(matches('cafe creme')).toBe(true);
    expect(matches('CAFÉ')).toBe(true);
    expect(matches('describe:preferences')).toBe(true);
    expect(matches('file:cafe*spec')).toBe(true);
    expect(matches('tag:ete owner:JOSE')).toBe(true);
    expect(matches('title:commandé')).toBe(true);
    expect(matches('-cafe')).toBe(false);
    expect(titles('lógín vía')).toEqual(['login via header']);
  });
});

describe('highlighting', () => {
  test('free words mark every text, qualifiers only their own, exclusions nothing', () => {
    const highlights = testSearchHighlights(parseTestSearch('login file:auth -cart describe:head tag:smoke'));
    expect(highlights).toEqual({
      title: ['login'],
      describe: ['login', 'head'],
      file: ['login', 'auth'],
      error: ['login'],
    });
  });

  test('ranges ignore case, follow wildcards and merge overlaps', () => {
    expect(highlightRanges('Login via header', ['login', 'HEAD'])).toEqual([
      [0, 5],
      [10, 14],
    ]);
    expect(highlightRanges('tests/shop/cart.spec.ts', ['shop*cart'])).toEqual([[6, 15]]);
    expect(highlightRanges('abcdef', ['abc', 'bcd'])).toEqual([[0, 4]]);
    expect(highlightRanges('abc', ['*', ''])).toEqual([]);
    // Stars at either end match nothing more, so they mark nothing more.
    expect(highlightRanges('tests/cart.spec.ts', ['*cart*'])).toEqual([[6, 10]]);
    // Every occurrence is marked, each span running from its first part to its last.
    expect(highlightRanges('a-b a-b', ['a*b'])).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  test('ranges ignore accents and cover a whole accented letter', () => {
    expect(highlightRanges('Café crème', ['cafe', 'CREME'])).toEqual([
      [0, 4],
      [5, 10],
    ]);
    expect(highlightRanges('resume', ['résumé'])).toEqual([[0, 6]]);
    // The accent of a decomposed `é` is marked with its letter.
    expect(highlightRanges('cafe\u0301 noir', ['cafe'])).toEqual([[0, 5]]);
    expect(highlightRanges('Łódź office', ['lodz*off'])).toEqual([[0, 8]]);
  });

  test('a value full of stars stays fast on a long text', () => {
    const text = `${'a'.repeat(20_000)}!`;
    const started = performance.now();
    expect(highlightRanges(text, ['a*a*a*a*a*a*a*a*a*a*a*a*b'])).toEqual([]);
    expect(titles('error:a*a*a*a*a*a*a*a*a*a*a*b')).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('formatting', () => {
  test('quotes a value with spaces, quotes or a leading minus', () => {
    expect(formatTestSearchValue('cart.spec.ts')).toBe('cart.spec.ts');
    expect(formatTestSearchValue('Guest checkout')).toBe('"Guest checkout"');
    expect(formatTestSearchValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(formatTestSearchValue('-flag')).toBe('"-flag"');
    expect(formatTestSearchTerm('describe', 'Sign in', true)).toBe('-describe:"Sign in"');
  });

  test('a formatted term reads back as the same value', () => {
    for (const value of ['Guest checkout', 'say "hi"', 'C:\\tests\\a b.ts', '-flag']) {
      const [token] = tokenizeTestSearch(formatTestSearchTerm('title', value));
      expect(token).toMatchObject({ field: 'title', value });
    }
  });
});

describe('completion', () => {
  const values = collectTestSearchValues(ALL);

  test('collects each value field with how many tests carry each value', () => {
    expect(values.describe).toEqual([
      { value: 'Authentication', count: 1 },
      { value: 'Cart', count: 1 },
      { value: 'Header', count: 1 },
    ]);
    expect(values.browser).toEqual([
      { value: 'chromium', count: 2 },
      { value: 'firefox', count: 1 },
    ]);
    expect(values.title).toBeUndefined();
  });

  test('an empty term offers every qualifier of the list', () => {
    const completion = completeTestSearch({ query: '', caret: 0, fields: CATALOG_SEARCH_FIELDS, values });
    expect(completion.suggestions.map((s) => s.key)).toEqual([
      'file',
      'describe',
      'title',
      'tag',
      'lock',
      'owner',
      'priority',
      'feature',
      'id',
    ]);
  });

  test('a qualifier offers the values containing what is typed, prefixes first', () => {
    const query = 'login file:spec';
    const completion = completeTestSearch({ query, caret: query.length, fields: RUN_SEARCH_FIELDS, values });
    expect(completion).toMatchObject({ start: 6, end: 15, field: 'file', negated: false });
    expect(completion.suggestions.map((s) => (s.kind === 'value' ? s.value : s.key))).toEqual([
      'tests/auth.spec.ts',
      'tests/home.spec.ts',
      'tests/shop/cart.spec.ts',
    ]);
    const prefixed = completeTestSearch({ query: 'browser:f', caret: 9, fields: RUN_SEARCH_FIELDS, values });
    expect(prefixed.suggestions.map((s) => (s.kind === 'value' ? s.value : s.key))).toEqual(['firefox']);
  });

  test('a typed value finds suggestions whatever their accents', () => {
    const accented = collectTestSearchValues([{ title: 't', suitePath: ['Préférences', 'Été'] }]);
    const completion = completeTestSearch({
      query: 'describe:PREF',
      caret: 13,
      fields: RUN_SEARCH_FIELDS,
      values: accented,
    });
    expect(completion.suggestions.map((s) => (s.kind === 'value' ? s.value : s.key))).toEqual(['Préférences']);
    const bare = completeTestSearch({ query: 'été', caret: 3, fields: RUN_SEARCH_FIELDS, values: accented });
    expect(bare.suggestions.map((s) => (s.kind === 'value' ? s.value : s.key))).toEqual(['Été']);
  });

  test('a bare word offers the qualifiers it starts, then values of any field', () => {
    // A value starting with the word, then one with a word starting with it, then one containing it.
    const completion = completeTestSearch({ query: 'ca', caret: 2, fields: RUN_SEARCH_FIELDS, values });
    expect(completion.suggestions.map((s) => (s.kind === 'value' ? `${s.key}:${s.value}` : `${s.key}:`))).toEqual([
      'describe:Cart',
      'file:tests/shop/cart.spec.ts',
      'describe:Authentication',
    ]);
    const keys = completeTestSearch({ query: 'fi', caret: 2, fields: RUN_SEARCH_FIELDS, values });
    expect(keys.suggestions[0]).toMatchObject({ kind: 'field', key: 'file' });
  });

  test('a value already in the query is not offered again', () => {
    const query = 'browser:chromium browser:';
    const completion = completeTestSearch({ query, caret: query.length, fields: RUN_SEARCH_FIELDS, values });
    expect(completion.suggestions.map((s) => (s.kind === 'value' ? s.value : s.key))).toEqual(['firefox']);
  });

  test('the term under the caret is the one completed', () => {
    const query = 'tag:sm login';
    const completion = completeTestSearch({ query, caret: 6, fields: RUN_SEARCH_FIELDS, values });
    expect(completion).toMatchObject({ start: 0, end: 6, field: 'tag' });
    expect(completion.suggestions).toEqual([{ kind: 'value', field: 'tag', key: 'tag', value: 'smoke', count: 1 }]);
  });

  test('applying a qualifier leaves the caret after its colon', () => {
    const completion = completeTestSearch({ query: 'login -de', caret: 9, fields: RUN_SEARCH_FIELDS, values });
    const describe = completion.suggestions.find((s) => s.key === 'describe')!;
    expect(applyTestSearchSuggestion('login -de', completion, describe)).toEqual({
      query: 'login -describe:',
      caret: 16,
    });
  });

  test('applying a value quotes it when needed and closes the term with a space', () => {
    const query = 'describe:auth login';
    const completion = completeTestSearch({ query, caret: 13, fields: RUN_SEARCH_FIELDS, values });
    const applied = applyTestSearchSuggestion(query, completion, {
      kind: 'value',
      field: 'describe',
      key: 'describe',
      value: 'Guest checkout',
      count: 1,
    });
    expect(applied).toEqual({ query: 'describe:"Guest checkout" login', caret: 26 });
    const atEnd = applyTestSearchSuggestion(
      'tag:sm',
      { start: 0, end: 6, negated: false },
      {
        kind: 'value',
        field: 'tag',
        key: 'tag',
        value: 'smoke',
        count: 1,
      },
    );
    expect(atEnd).toEqual({ query: 'tag:smoke ', caret: 10 });
  });
});
