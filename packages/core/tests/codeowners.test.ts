import { describe, test, expect } from 'vitest';
import {
  compileCodeowners,
  ownersForPath,
  parseCodeowners,
  pathPatternMatcher,
  pathPatternToRegExp,
  primaryOwnerForPath,
  type CompiledCodeowners,
} from '../src/codeowners';

function compile(content: string): CompiledCodeowners {
  return compileCodeowners(parseCodeowners(content));
}

describe('parseCodeowners', () => {
  test('reads pattern and owners', () => {
    expect(parseCodeowners('tests/ @qa-team @alice')).toEqual([
      { pattern: 'tests/', owners: ['@qa-team', '@alice'], line: 1 },
    ]);
  });

  test('ignores comments, blank lines and trailing comments', () => {
    const rules = parseCodeowners(['# ownership', '', 'tests/ @qa   # the QA team', '   '].join('\n'));
    expect(rules).toEqual([{ pattern: 'tests/', owners: ['@qa'], line: 3 }]);
  });

  test('drops a pattern with no owners', () => {
    expect(parseCodeowners('tests/')).toEqual([]);
  });

  test('accepts emails as owners', () => {
    expect(parseCodeowners('*.ts qa@example.com')[0]?.owners).toEqual(['qa@example.com']);
  });

  test('records the line number for display', () => {
    expect(parseCodeowners('\n\n*.ts @a')[0]?.line).toBe(3);
  });
});

describe('ownersForPath', () => {
  test('the last matching rule wins', () => {
    const compiled = compile(['* @default-team', 'tests/checkout/ @checkout-team'].join('\n'));
    expect(ownersForPath(compiled, 'tests/checkout/pay.spec.ts')).toEqual(['@checkout-team']);
    expect(ownersForPath(compiled, 'tests/other/thing.spec.ts')).toEqual(['@default-team']);
  });

  test('returns an empty array when nothing matches', () => {
    expect(ownersForPath(compile('docs/ @writers'), 'tests/a.spec.ts')).toEqual([]);
  });

  test('a bare name floats to any depth', () => {
    const compiled = compile('tests @qa');
    expect(ownersForPath(compiled, 'tests/a.spec.ts')).toEqual(['@qa']);
    expect(ownersForPath(compiled, 'apps/web/tests/a.spec.ts')).toEqual(['@qa']);
  });

  test('an extension pattern floats to any depth', () => {
    const compiled = compile('*.spec.ts @qa');
    expect(ownersForPath(compiled, 'a.spec.ts')).toEqual(['@qa']);
    expect(ownersForPath(compiled, 'tests/deep/a.spec.ts')).toEqual(['@qa']);
    expect(ownersForPath(compiled, 'tests/a.test.ts')).toEqual([]);
  });

  test('a leading slash anchors to the repository root', () => {
    const compiled = compile('/tests @qa');
    expect(ownersForPath(compiled, 'tests/a.spec.ts')).toEqual(['@qa']);
    expect(ownersForPath(compiled, 'apps/web/tests/a.spec.ts')).toEqual([]);
  });

  test('an interior slash anchors too', () => {
    const compiled = compile('apps/web/ @web');
    expect(ownersForPath(compiled, 'apps/web/tests/a.spec.ts')).toEqual(['@web']);
    expect(ownersForPath(compiled, 'packages/apps/web/a.spec.ts')).toEqual([]);
  });

  test('a directory owns everything beneath it', () => {
    const compiled = compile('/tests/checkout/ @checkout');
    expect(ownersForPath(compiled, 'tests/checkout/deep/nested/a.spec.ts')).toEqual(['@checkout']);
  });

  // `a/**/b` has to match `a/b`, which is why `**` cannot just become `.*`.
  test('** spans zero or more segments', () => {
    const compiled = compile('/apps/**/tests/ @qa');
    expect(ownersForPath(compiled, 'apps/tests/a.spec.ts')).toEqual(['@qa']);
    expect(ownersForPath(compiled, 'apps/web/tests/a.spec.ts')).toEqual(['@qa']);
    expect(ownersForPath(compiled, 'apps/web/admin/tests/a.spec.ts')).toEqual(['@qa']);
    expect(ownersForPath(compiled, 'apps/web/src/a.spec.ts')).toEqual([]);
  });

  test('a trailing ** matches everything below', () => {
    const compiled = compile('/apps/** @apps');
    expect(ownersForPath(compiled, 'apps/web/a.spec.ts')).toEqual(['@apps']);
  });

  test('* does not cross a directory separator', () => {
    const compiled = compile('/tests/*.spec.ts @qa');
    expect(ownersForPath(compiled, 'tests/a.spec.ts')).toEqual(['@qa']);
    expect(ownersForPath(compiled, 'tests/deep/a.spec.ts')).toEqual([]);
  });

  test('? matches exactly one character', () => {
    const compiled = compile('/tests/a?.spec.ts @qa');
    expect(ownersForPath(compiled, 'tests/ab.spec.ts')).toEqual(['@qa']);
    expect(ownersForPath(compiled, 'tests/abc.spec.ts')).toEqual([]);
  });

  test('a dot in a pattern is literal, not a wildcard', () => {
    const compiled = compile('/tests/a.spec.ts @qa');
    expect(ownersForPath(compiled, 'tests/axspecxts')).toEqual([]);
  });

  test('tolerates a leading ./ on the queried path', () => {
    expect(ownersForPath(compile('/tests/ @qa'), './tests/a.spec.ts')).toEqual(['@qa']);
  });

  test('* on its own owns the whole repository', () => {
    const compiled = compile('* @everyone');
    expect(ownersForPath(compiled, 'anything/at/all.ts')).toEqual(['@everyone']);
  });
});

describe('primaryOwnerForPath', () => {
  test('takes the first owner, which is the conventional primary', () => {
    expect(primaryOwnerForPath(compile('/tests/ @first @second'), 'tests/a.spec.ts')).toBe('@first');
  });

  test('is null when nothing matches', () => {
    expect(primaryOwnerForPath(compile('/docs/ @writers'), 'tests/a.spec.ts')).toBeNull();
  });
});

describe('path patterns', () => {
  const deepPath = Array.from({ length: 22 }, (_, i) => `d${i}`).join('/');

  test('reads consecutive ** as one, in constant time', () => {
    const pattern = '**/**/**/**/**/**/**/**/**/**/**/**/x';
    const started = performance.now();
    expect(pathPatternToRegExp(pattern).test(deepPath)).toBe(false);
    expect(pathPatternToRegExp(pattern).test('a/b/x')).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('the matcher matches what the regular expression matches', () => {
    let seed = 7;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return (seed >>> 16) % n;
    };
    const pick = <T>(items: T[]) => items[random(items.length)]!;
    const patternSegments = ['a', 'b', 'ab', '*', '**', 'a*', '*b', '?', 'a?b', '*a*', ''];
    const pathSegments = ['a', 'b', 'ab', 'aab', 'ba', 'abb', ''];
    for (let i = 0; i < 3000; i++) {
      const segments = Array.from({ length: 1 + random(4) }, () => pick(patternSegments));
      const pattern = `${pick(['', '/'])}${segments.join('/')}${pick(['', '/'])}`;
      const regex = pathPatternToRegExp(pattern);
      const matches = pathPatternMatcher(pattern);
      for (let j = 0; j < 10; j++) {
        const path = Array.from({ length: 1 + random(5) }, () => pick(pathSegments)).join('/');
        expect(matches(path), `${pattern} on ${path}`).toBe(regex.test(path));
      }
    }
  });

  test('the matcher takes no time on patterns a regular expression backtracks on', () => {
    const longSegment = 'a'.repeat(255);
    const manySegments = Array.from({ length: 120 }, () => 'a').join('/');
    const started = performance.now();
    expect(pathPatternMatcher('*a*a*a*a*a*a*a*a*a*a*b')(longSegment)).toBe(false);
    expect(pathPatternMatcher('a/**/a/**/a/**/a/**/a/**/a/**/b')(manySegments)).toBe(false);
    expect(pathPatternMatcher('**/a*/**/a*/**/a*/**/a*/**/x')(manySegments)).toBe(false);
    expect(pathPatternMatcher('**/**/**/**/**/**/**/**/**/**/**/**/x')(deepPath)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
