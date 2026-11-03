import { describe, test, expect } from 'vitest';
import { compileGlob, globMatcher } from '../src/glob';

describe('globMatcher', () => {
  test('a pattern without wildcards matches the whole text, nothing more', () => {
    const matches = globMatcher('main');
    expect(matches('main')).toBe(true);
    expect(matches('main-2')).toBe(false);
    expect(matches('xmain')).toBe(false);
    expect(matches('')).toBe(false);
  });

  test('* matches any run of characters, none and / included', () => {
    expect(globMatcher('release/*')('release/2.4/rc')).toBe(true);
    expect(globMatcher('release/*')('release/')).toBe(true);
    expect(globMatcher('feat-*-ui')('feat-login-ui')).toBe(true);
    expect(globMatcher('feat-*-ui')('feat-login-api')).toBe(false);
    expect(globMatcher('*')('')).toBe(true);
    expect(globMatcher('*a*b*')('xxaxxbxx')).toBe(true);
    expect(globMatcher('*a*b*')('xxbxxaxx')).toBe(false);
  });

  test('every other character matches itself', () => {
    expect(globMatcher('release-2.4*')('release-2x4')).toBe(false);
    expect(globMatcher('env(*)')('env(a)')).toBe(true);
    expect(globMatcher('a?c')('abc')).toBe(false);
    expect(globMatcher('a?c')('a?c')).toBe(true);
    expect(globMatcher('[ab]')('[ab]')).toBe(true);
  });

  test('? matches one character with questionMark', () => {
    const matches = globMatcher('a?c', { questionMark: true });
    expect(matches('abc')).toBe(true);
    expect(matches('a/c')).toBe(true);
    expect(matches('ac')).toBe(false);
    expect(matches('abbc')).toBe(false);
  });

  test('with segments, * stays within a segment and ** crosses them', () => {
    expect(globMatcher('src/*.ts', { segments: true })('src/a.ts')).toBe(true);
    expect(globMatcher('src/*.ts', { segments: true })('src/a/b.ts')).toBe(false);
    expect(globMatcher('src/**.ts', { segments: true })('src/a/b.ts')).toBe(true);
    expect(globMatcher('**/cart', { segments: true })('https://shop.test/a/cart')).toBe(true);
    expect(globMatcher('a?b', { segments: true, questionMark: true })('a/b')).toBe(false);
    expect(globMatcher('a?b', { segments: true, questionMark: true })('axb')).toBe(true);
  });

  test('case matters unless ignoreCase', () => {
    expect(globMatcher('Main*')('main-x')).toBe(false);
    expect(globMatcher('Main*', { ignoreCase: true })('mAIN-x')).toBe(true);
  });

  test('compileGlob matches the tokens it is given', () => {
    const matches = compileGlob([
      { kind: 'char', char: 'a' },
      { kind: 'run', slash: false },
      { kind: 'one', slash: true },
    ]);
    expect(matches('axy/')).toBe(true);
    expect(matches('a/y/')).toBe(false);
  });

  test('matches what the regular expression the pattern stands for matches', () => {
    let seed = 11;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return (seed >>> 16) % n;
    };
    const pick = <T>(items: readonly T[]) => items[random(items.length)]!;
    const escape = (char: string) => char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    // The regular expression each syntax stands for, built character by character.
    const regexOf = (pattern: string, segments: boolean, questionMark: boolean) => {
      let source = '';
      for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i]!;
        if (char === '*' && segments && pattern[i + 1] === '*') {
          source += '.*';
          i++;
        } else if (char === '*') source += segments ? '[^/]*' : '.*';
        else if (char === '?' && questionMark) source += segments ? '[^/]' : '.';
        else source += escape(char);
      }
      return new RegExp(`^${source}$`);
    };
    const patternChars = ['a', 'b', '/', '*', '*', '?', '.'];
    const textChars = ['a', 'b', '/', '?', '.'];
    for (const segments of [false, true]) {
      for (const questionMark of [false, true]) {
        for (let i = 0; i < 1500; i++) {
          const pattern = Array.from({ length: random(7) }, () => pick(patternChars)).join('');
          const regex = regexOf(pattern, segments, questionMark);
          const matches = globMatcher(pattern, { segments, questionMark });
          for (let j = 0; j < 8; j++) {
            const text = Array.from({ length: random(8) }, () => pick(textChars)).join('');
            expect(matches(text), `${pattern} on ${text} (${segments}, ${questionMark})`).toBe(regex.test(text));
          }
        }
      }
    }
  });

  test('takes no time on patterns a regular expression backtracks on', () => {
    const name = 'e'.repeat(26);
    const longName = 'a'.repeat(1000);
    // The fastest of three runs: a pause of the machine slows one of them, a backtracking matcher all three.
    let fastest = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      expect(globMatcher('*e*e*e*e*e*e*e*e*e*e*e*e*!')(name)).toBe(false);
      expect(globMatcher(`${'*a'.repeat(10)}*!`, { questionMark: true, ignoreCase: true })(longName)).toBe(false);
      expect(globMatcher(`${'**a*a'.repeat(10)}!`, { segments: true })(longName)).toBe(false);
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(fastest).toBeLessThan(50);
  });
});
