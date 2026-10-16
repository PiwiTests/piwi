import { describe, expect, it } from 'vitest';
import { DEFAULT_COVERAGE_SCOPE, compileCoverageScope, parseCoverageScope } from '../src/coverage-scope';

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
