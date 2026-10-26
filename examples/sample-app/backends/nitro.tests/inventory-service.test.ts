import { describe, expect, it } from 'vitest';
import { report } from '../nitro/services/inventory-service';

describe('the stock report', () => {
  it('reports the stock from the cached prices when the feed fails', () => {
    expect(report()).toEqual({ items: 3, cached: true });
  });
});
