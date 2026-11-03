import { describe, test, expect } from 'vitest';
import {
  createDeclaredMatcher,
  declaredPatternLimitError,
  manifestLimitError,
  MAX_DECLARED_PATTERN_LENGTH,
  MAX_SEGMENT_PARAMETERS,
} from '#shared/graph';
import { parseOpenApiSpec } from '#shared/openapi';

/**
 * A declared segment mixing literals and parameters (`v{version}`,
 * `{name}.{ext?}`) matches exactly what the regular expression it stands for
 * matches, in steps that grow with the segment's length times the pattern's;
 * patterns past the limits are skipped.
 */

const MIXED_PARAM = /(\{[^{}]*\}|\[\[[^\][]*\]\]|\[[^\][]*\])/;

function comparable(segment: string): string {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
}

/** The regular expression a mixed segment stands for: each parameter `.+`, a last optional one `(?:<literal>.+)?`. */
function referenceRegExp(segment: string): RegExp {
  const parts = segment.split(MIXED_PARAM);
  const pieces: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 0) {
      pieces.push(comparable(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      continue;
    }
    const inner = part.slice(1, -1);
    const optional = part.startsWith('[[') || inner.endsWith('?') || inner.includes('=');
    if (optional && i === parts.length - 2 && parts[i + 1] === '') pieces.push(`(?:${pieces.pop() ?? ''}.+)?`);
    else pieces.push('.+');
  }
  return new RegExp(`^${pieces.join('')}$`);
}

/** Whether a route declared as `/x/<segment>/y` serves the observed `/x/<observed>/y`. */
function serves(segment: string, observed: string): boolean {
  const match = createDeclaredMatcher([
    { kind: 'route', key: 'GET /x/declared/y', attrs: { declared: true, patterns: [`/x/${segment}/y`] } },
  ]);
  return match('route', `GET /x/${observed}/y`).length > 0;
}

/** A seeded generator, so a failing case reads the same on every run. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const LITERAL_UNITS = ['a', 'b', '-', '.', 'A', '%2F', 'é', '_'];
const OBSERVED_UNITS = ['a', 'b', '-', '.', '%2F', '%0A', 'é', '_', '%'];
const PARAMS = ['{p}', '{p?}', '[q]', '[[q]]', '{}', '{n:int}', '{v=1}'];

describe('a segment mixing literals and parameters', () => {
  test('matches what the regular expression it stands for matches', () => {
    const random = prng(20261103);
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
    const text = (units: readonly string[], max: number) =>
      Array.from({ length: Math.floor(random() * (max + 1)) }, () => pick(units)).join('');
    let compared = 0;
    let matched = 0;
    for (let n = 0; n < 1500; n++) {
      const count = 1 + Math.floor(random() * 4);
      const literals = Array.from({ length: count + 1 }, () => text(LITERAL_UNITS, 3));
      const params = Array.from({ length: count }, () => pick(PARAMS));
      if (count === 1 && literals[0] === '' && literals[1] === '') continue;
      const segment = literals.map((literal, i) => literal + (params[i] ?? '')).join('');
      const reference = referenceRegExp(segment);
      // Random texts, and the segment filled in with a value per parameter, the last optional one sometimes left out.
      const filled = literals.map((literal, i) => literal + (i < count ? text(OBSERVED_UNITS, 3) || 'a' : '')).join('');
      const shortened = literals
        .slice(0, -2)
        .map((literal) => literal + text(OBSERVED_UNITS, 2))
        .join('');
      for (const observed of [text(OBSERVED_UNITS, 8), text(OBSERVED_UNITS, 4), filled, shortened]) {
        if (observed === '') continue;
        const expected = reference.test(comparable(observed));
        expect(serves(segment, observed), `${segment} against ${observed}`).toBe(expected);
        compared++;
        if (expected) matched++;
      }
    }
    expect(compared).toBeGreaterThan(4000);
    expect(matched).toBeGreaterThan(500);
  });

  test('a parameter takes a percent-encoded slash but no line terminator, as `.` does', () => {
    expect(serves('{name}:cancel', 'jobs%2F42:cancel')).toBe(true);
    expect(serves('{name}:cancel', 'jobs%0A42:cancel')).toBe(false);
    expect(serves('{name}.{ext?}', 'report')).toBe(true);
    expect(serves('{name}.{ext}', 'report')).toBe(false);
  });

  test('a segment of many parameters matches in linear steps', () => {
    const segment = `${Array.from({ length: 16 }, (_, i) => `{p${i}}`).join('')}z`;
    const started = performance.now();
    expect(serves(segment, 'a'.repeat(29))).toBe(false);
    expect(serves(segment, `${'a'.repeat(200)}z`)).toBe(true);
    expect(serves(segment, 'a'.repeat(2000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('declared pattern limits', () => {
  const params = (count: number) => Array.from({ length: count }, (_, i) => `{p${i}}`).join('-');

  test(`a pattern holds at most ${MAX_DECLARED_PATTERN_LENGTH} characters and ${MAX_SEGMENT_PARAMETERS} parameters in a segment`, () => {
    expect(declaredPatternLimitError(`/x/${params(MAX_SEGMENT_PARAMETERS)}`)).toBeNull();
    expect(declaredPatternLimitError(`/x/${params(MAX_SEGMENT_PARAMETERS + 1)}`)).toContain(
      `at most ${MAX_SEGMENT_PARAMETERS} parameters`,
    );
    expect(declaredPatternLimitError(`/${params(10)}/${params(10)}`)).toBeNull();
    const long = `/${'a'.repeat(MAX_DECLARED_PATTERN_LENGTH - 1)}`;
    expect(declaredPatternLimitError(long)).toBeNull();
    expect(declaredPatternLimitError(`${long}b`)).toContain(`at most ${MAX_DECLARED_PATTERN_LENGTH} characters`);
  });

  test('a manifest names the first pattern past a limit', () => {
    expect(manifestLimitError({ routes: [{ method: 'GET', pattern: '/a/{b}' }], pages: [{ pattern: '/c' }] })).toBe(
      null,
    );
    expect(
      manifestLimitError({
        routes: [{ method: 'GET', pattern: '/a' }],
        pages: [{ pattern: '/c' }, { pattern: `/x/${params(MAX_SEGMENT_PARAMETERS + 1)}` }],
      }),
    ).toBe(`A segment of a declared pattern holds at most ${MAX_SEGMENT_PARAMETERS} parameters: pages[1].pattern`);
  });

  test('matching skips a stored pattern past a limit', () => {
    const over = `/x/${params(MAX_SEGMENT_PARAMETERS + 1)}`;
    const within = `/x/${params(MAX_SEGMENT_PARAMETERS)}`;
    const match = createDeclaredMatcher([
      { kind: 'page', key: '/x/over', attrs: { declared: true, patterns: [over] } },
      { kind: 'page', key: '/x/within', attrs: { declared: true, patterns: [within] } },
      { kind: 'page', key: '/x/long', attrs: { declared: true, patterns: [`/x/{a}${'b'.repeat(2100)}`] } },
    ]);
    expect(match('page', `/x/${Array.from({ length: MAX_SEGMENT_PARAMETERS + 1 }, () => 'v').join('-')}`)).toEqual([
      '/x/within',
    ]);
    expect(match('page', `/x/a${'b'.repeat(2100)}`)).toEqual([]);
  });

  test('an OpenAPI document leaves out a path past a limit', () => {
    const manifest = parseOpenApiSpec({
      paths: {
        '/ok/{id}': { get: {} },
        [`/over/${params(MAX_SEGMENT_PARAMETERS + 1)}`]: { get: {} },
        [`/long/${'a'.repeat(MAX_DECLARED_PATTERN_LENGTH)}`]: { get: {} },
      },
    });
    expect(manifest.routes?.map((r) => r.pattern)).toEqual(['/ok/{id}']);
  });
});
