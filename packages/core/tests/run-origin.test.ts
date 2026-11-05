import { describe, expect, test } from 'vitest';
import { parseRunInteractive, parseRunOrigin, parseRunOriginRef, RUN_ORIGIN_KINDS } from '../src/wire';

describe('parseRunOrigin', () => {
  test('keeps every known kind, with and without a ref', () => {
    for (const kind of RUN_ORIGIN_KINDS) {
      expect(parseRunOrigin({ kind })).toEqual({ kind });
      expect(parseRunOrigin({ kind, ref: ' 42 ' })).toEqual({ kind, ref: '42' });
    }
  });

  test('rebuilds the object with the kind first and nothing else', () => {
    const parsed = parseRunOrigin({ ref: 'abc', extra: 1, kind: 'bisect' });
    expect(parsed).toEqual({ kind: 'bisect', ref: 'abc' });
    expect(Object.keys(parsed!)).toEqual(['kind', 'ref']);
  });

  test('rejects an unknown kind or a non-object', () => {
    expect(parseRunOrigin({ kind: 'nightly' })).toBeNull();
    expect(parseRunOrigin('ci')).toBeNull();
    expect(parseRunOrigin(null)).toBeNull();
    expect(parseRunOrigin([{ kind: 'ci' }])).toBeNull();
  });

  test('drops a ref with characters outside the allowed set or too long', () => {
    expect(parseRunOrigin({ kind: 'ci-rerun', ref: 'a"b' })).toEqual({ kind: 'ci-rerun' });
    expect(parseRunOriginRef('x'.repeat(201))).toBeUndefined();
    expect(parseRunOriginRef('%')).toBeUndefined();
    expect(parseRunOriginRef(17)).toBe('17');
    expect(parseRunOriginRef('cluster/12#a@b:c.d_e-f')).toBe('cluster/12#a@b:c.d_e-f');
  });
});

describe('parseRunInteractive', () => {
  test('keeps the hub’s client and the run’s ref there, and nothing else', () => {
    const parsed = parseRunInteractive({ ref: 'terminal-41-1730000000000', extra: 1, client: ' Visual Studio Code ' });
    expect(parsed).toEqual({ client: 'Visual Studio Code', ref: 'terminal-41-1730000000000' });
    expect(Object.keys(parsed!)).toEqual(['client', 'ref']);
    expect(parseRunInteractive({ client: null, ref: 'desktop-3' })).toEqual({ client: null, ref: 'desktop-3' });
  });

  test('reads a client that is not short text on one line as none', () => {
    for (const client of [
      undefined,
      7,
      '',
      '   ',
      'x'.repeat(201),
      'Code\nInjected',
      'Code\u0000',
      'Code\u0085',
      'Code\u202eedoC',
    ]) {
      expect(parseRunInteractive({ client, ref: 'ed-1' }), JSON.stringify(client)).toEqual({
        client: null,
        ref: 'ed-1',
      });
    }
    expect(parseRunInteractive({ client: 'x'.repeat(200), ref: 'ed-1' })?.client).toHaveLength(200);
  });

  test('rejects a ref no hub names a run by, and a non-object', () => {
    for (const ref of [undefined, '', 'a b', 'cluster/12', 'x'.repeat(65), 12]) {
      expect(parseRunInteractive({ client: 'editor', ref }), JSON.stringify(ref)).toBeNull();
    }
    expect(parseRunInteractive('ed-1')).toBeNull();
    expect(parseRunInteractive(null)).toBeNull();
    expect(parseRunInteractive([{ ref: 'ed-1' }])).toBeNull();
  });
});
