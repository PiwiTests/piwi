import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COVERAGE_SCOPE,
  compileCoverageAreas,
  compileCoverageScope,
  parseCoverageAreas,
  parseCoverageScope,
} from '../src/coverage-scope';

describe('compileCoverageScope', () => {
  it('leaves out tests, build output and generated sources by default', () => {
    const inScope = compileCoverageScope(DEFAULT_COVERAGE_SCOPE);
    expect(inScope('apps/web/src/cart.ts')).toBe(true);
    expect(inScope('src/Shop/Basket.cs')).toBe(true);
    for (const path of [
      'apps/web/src/cart.test.ts',
      'apps/web/tests/e2e/cart.spec.ts',
      'src/Shop.Tests/BasketTests.cs',
      'src/ShopTests/BasketTests.cs',
      'src/Shop/obj/Debug/Generated.cs',
      'src/Shop/bin/Release/x.cs',
      'src/Shop/Resources.Designer.cs',
      'src/Shop/Grpc.g.cs',
    ]) {
      expect(inScope(path), path).toBe(false);
    }
  });

  it('counts only what an include pattern names, and an exclude wins over it', () => {
    const inScope = compileCoverageScope({ include: ['apps/web/src/', 'src/**/*.cs'], exclude: ['src/Legacy/'] });
    expect(inScope('apps/web/src/cart.ts')).toBe(true);
    expect(inScope('src/Shop/Basket.cs')).toBe(true);
    expect(inScope('apps/docs/index.md')).toBe(false);
    expect(inScope('src/Legacy/Old.cs')).toBe(false);
  });
});

describe('parseCoverageScope', () => {
  it('keeps each pattern once, without blanks and comments, and a missing list as empty', () => {
    expect(parseCoverageScope({ include: [' src/ ', '', '# a comment', 'src/'] })).toEqual({
      include: ['src/'],
      exclude: [],
    });
  });

  it('refuses a list that is not one of strings, a negation and a pattern too long', () => {
    expect(parseCoverageScope({ include: 'src/' })).toBeNull();
    expect(parseCoverageScope({ exclude: [1] })).toBeNull();
    expect(parseCoverageScope({ exclude: ['!src/keep.ts'] })).toBeNull();
    expect(parseCoverageScope({ include: ['a'.repeat(301)] })).toBeNull();
    expect(parseCoverageScope([])).toBeNull();
  });
});

describe('coverage areas', () => {
  it('reads named areas, each with its patterns', () => {
    expect(
      parseCoverageAreas([
        { name: ' front ', include: ['apps/web/', '# comment', ''] },
        { name: 'back', include: ['src/Api/**'] },
      ]),
    ).toEqual([
      { name: 'front', include: ['apps/web/'] },
      { name: 'back', include: ['src/Api/**'] },
    ]);
    expect(parseCoverageAreas([])).toEqual([]);
  });

  it('refuses a nameless, patternless or repeated area, and more than twenty', () => {
    expect(parseCoverageAreas([{ name: '', include: ['a/'] }])).toBeNull();
    expect(parseCoverageAreas([{ name: 'front', include: [] }])).toBeNull();
    expect(parseCoverageAreas([{ name: '-x', include: ['a/'] }])).toBeNull();
    expect(
      parseCoverageAreas([
        { name: 'Front', include: ['a/'] },
        { name: 'front', include: ['b/'] },
      ]),
    ).toBeNull();
    expect(parseCoverageAreas(Array.from({ length: 21 }, (_, i) => ({ name: `a${i}`, include: ['a/'] })))).toBeNull();
    expect(parseCoverageAreas({ name: 'front' })).toBeNull();
  });

  it('puts a file in the first area that matches it', () => {
    const areaOf = compileCoverageAreas([
      { name: 'web', include: ['apps/web/'] },
      { name: 'front', include: ['apps/'] },
    ]);
    expect(areaOf('apps/web/src/cart.ts')).toBe('web');
    expect(areaOf('apps/admin/main.ts')).toBe('front');
    expect(areaOf('src/Api/Program.cs')).toBeNull();
  });
});
