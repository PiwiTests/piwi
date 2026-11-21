import { describe, it, expect } from 'vitest';
import { rankedToStructured } from '../src/internal/ai/compile.js';

describe('rankedToStructured', () => {
  it('maps each builder method to positional Playwright args', () => {
    expect(rankedToStructured({ locator: '', method: 'getByLabel', args: { label: 'Email' }, score: 85 })).toEqual({
      method: 'getByLabel',
      args: ['Email'],
    });
    expect(
      rankedToStructured({ locator: '', method: 'getByRole', args: { role: 'heading', name: 'Hi', level: 2 }, score: 90 }),
    ).toEqual({ method: 'getByRole', args: ['heading', { name: 'Hi', level: 2 }] });
  });

  it('declines anchored-chain candidates (flattened in a later phase)', () => {
    expect(
      rankedToStructured({ locator: '', method: 'getByRole', args: { role: 'button', anchorTestId: 'bar' }, score: 70 }),
    ).toBeNull();
  });
});
