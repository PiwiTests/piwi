import { describe, it, expect } from 'vitest';
import { parseLocatorChain } from '@piwitests/core/locator-chain';
import { generateAnchoredAlternatives, mergeCandidates, ANCHOR_KIND_SCORES } from '../src/anchor-alternatives.js';
import type { PickedAnchorInfo } from '../src/overlay-anchors.js';

function anchor(overrides: Partial<PickedAnchorInfo>): PickedAnchorInfo {
  return {
    tag: 'div',
    depth: 1,
    testId: null,
    id: null,
    ariaLabel: null,
    role: null,
    scopedLeafCount: 1,
    ...overrides,
  };
}

describe('generateAnchoredAlternatives', () => {
  const leaf = { role: 'button', level: null };

  it('emits a testid-anchored chain in the standard flat-args shape', () => {
    const alts = generateAnchoredAlternatives(leaf, [anchor({ tag: 'form', testId: 'signup-form', testIdCount: 1 })]);
    expect(alts).toHaveLength(1);
    expect(alts[0]!.locator).toBe(`getByTestId('signup-form').getByRole('button')`);
    expect(alts[0]!.method).toBe('getByRole');
    expect(alts[0]!.args).toEqual({ role: 'button', anchorTestId: 'signup-form' });
    expect(alts[0]!.score).toBe(ANCHOR_KIND_SCORES.testid);
  });

  it('falls through the hook ladder: id, then labeled role, then bare role', () => {
    const byId = generateAnchoredAlternatives(leaf, [anchor({ id: 'sidebar', idCount: 1 })]);
    expect(byId[0]!.locator).toBe(`locator('#sidebar').getByRole('button')`);
    expect(byId[0]!.args).toEqual({ role: 'button', anchorSelector: '#sidebar' });
    expect(byId[0]!.score).toBe(ANCHOR_KIND_SCORES.id);

    const byLabel = generateAnchoredAlternatives(leaf, [
      anchor({ tag: 'nav', role: 'navigation', ariaLabel: 'Main', labeledRoleCount: 1, roleCount: 3 }),
    ]);
    expect(byLabel[0]!.locator).toBe(`getByRole('navigation', { name: 'Main' }).getByRole('button')`);
    // The anchor's label must never ride under `name` — the server's
    // fingerprint reader reserves that for the leaf's accessible name.
    expect(byLabel[0]!.args).toEqual({ role: 'button', anchorRole: 'navigation', anchorName: 'Main' });
    expect(byLabel[0]!.score).toBe(ANCHOR_KIND_SCORES.labeledRole);

    const byRole = generateAnchoredAlternatives(leaf, [anchor({ tag: 'nav', role: 'navigation', roleCount: 1 })]);
    expect(byRole[0]!.locator).toBe(`getByRole('navigation').getByRole('button')`);
    expect(byRole[0]!.score).toBe(ANCHOR_KIND_SCORES.role);
  });

  it('carries the heading level into the leaf part', () => {
    const alts = generateAnchoredAlternatives({ role: 'heading', level: 2 }, [
      anchor({ testId: 'panel', testIdCount: 1 }),
    ]);
    expect(alts[0]!.locator).toBe(`getByTestId('panel').getByRole('heading', { level: 2 })`);
    expect(alts[0]!.args).toEqual({ role: 'heading', level: 2, anchorTestId: 'panel' });
  });

  it('drops anchors whose subtree does not isolate the leaf, or with no unique hook', () => {
    expect(
      generateAnchoredAlternatives(leaf, [anchor({ testId: 'list', testIdCount: 1, scopedLeafCount: 4 })]),
    ).toEqual([]);
    expect(generateAnchoredAlternatives(leaf, [anchor({ testId: 'dup', testIdCount: 3 })])).toEqual([]);
    // Auto-generated ids never anchor.
    expect(generateAnchoredAlternatives(leaf, [anchor({ id: 'radix-3f9a2b1c', idCount: 1 })])).toEqual([]);
  });

  it('adds a combined chain when several anchors isolate exactly one element', () => {
    const outer = anchor({ tag: 'main', depth: 5, role: 'main', roleCount: 1, scopedLeafCount: 6 });
    const inner = anchor({ tag: 'form', depth: 2, testId: 'signup-form', testIdCount: 1, scopedLeafCount: 1 });
    const alts = generateAnchoredAlternatives(leaf, [inner, outer], 1);
    const chain = alts.find((a) => Array.isArray(a.args.anchorChain));
    expect(chain).toBeDefined();
    expect(chain!.locator).toBe(`getByRole('main').getByTestId('signup-form').getByRole('button')`);
    // Flat args describe the innermost anchor; chain scores as its weakest segment.
    expect(chain!.args.anchorTestId).toBe('signup-form');
    expect(chain!.score).toBe(ANCHOR_KIND_SCORES.role);
    // No combined chain without the whole-chain uniqueness proof.
    const without = generateAnchoredAlternatives(leaf, [inner, outer], 3);
    expect(without.find((a) => Array.isArray(a.args.anchorChain))).toBeUndefined();
  });

  it('returns nothing for a role-less leaf', () => {
    expect(generateAnchoredAlternatives({ role: null, level: null }, [anchor({ id: 'x', idCount: 1 })])).toEqual([]);
  });
});

describe('generateAnchoredAlternatives with hostile attributes', () => {
  it('quotes a raw role so every candidate parses as a locator with the role as one string', () => {
    const role = "button'), require('child_process').execSync('id'), ('";
    const alts = generateAnchoredAlternatives({ role, level: null }, [
      anchor({ testId: 'form\nline', testIdCount: 1 }),
      anchor({ role, ariaLabel: 'Main\u2028', labeledRoleCount: 1 }),
    ]);
    expect(alts.length).toBeGreaterThan(0);
    for (const alt of alts) {
      expect(alt.locator).not.toMatch(/[\n\r\u2028\u2029]/);
      const chain = parseLocatorChain(alt.locator);
      const leafCall = chain.calls[chain.calls.length - 1]!;
      expect(leafCall.method).toBe('getByRole');
      expect(leafCall.args).toEqual([{ type: 'string', value: role }]);
    }
  });
});

describe('mergeCandidates', () => {
  it('dedupes by locator (first list wins) and re-sorts by score', () => {
    const base = [
      { locator: `getByTestId('a')`, method: 'getByTestId', args: { testId: 'a' }, score: 100 },
      { locator: `getByText('Pay')`, method: 'getByText', args: { text: 'Pay' }, score: 75 },
    ];
    const extra = [
      { locator: `getByText('Pay')`, method: 'getByText', args: { text: 'Pay' }, score: 99 },
      { locator: `locator('#f').getByRole('button')`, method: 'getByRole', args: { role: 'button' }, score: 74 },
    ];
    const merged = mergeCandidates(base, extra);
    expect(merged.map((m) => m.locator)).toEqual([
      `getByTestId('a')`,
      `getByText('Pay')`,
      `locator('#f').getByRole('button')`,
    ]);
    expect(merged[1]!.score).toBe(75);
  });
});
