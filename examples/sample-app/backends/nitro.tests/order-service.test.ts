import { describe, expect, it } from 'vitest';
import { forShopper, place, type Shipping } from '../nitro/services/order-service';

// The checks an order goes through. The end-to-end suite places a good order; these tests reach the refusals no user
// path in it takes, so the combined coverage shows both kinds of line.
const home: Shipping = { name: 'Ada', address: '1 Main Street', city: 'Paris', country: 'France' };

describe('placing an order', () => {
  it('refuses an empty cart', () => {
    expect(place('ada@example.com', { items: [], shipping: home })).toEqual({ problem: 'Your cart is empty.' });
  });

  it('refuses a product the shop does not sell', () => {
    expect(place('ada@example.com', { items: ['umbrella'], shipping: home })).toEqual({
      problem: 'The shop does not sell umbrella.',
    });
  });

  it('refuses a country it does not ship to', () => {
    expect(place('ada@example.com', { items: ['trail-shoes'], shipping: { ...home, country: 'Peru' } })).toEqual({
      problem: 'The shop does not ship to Peru.',
    });
  });

  it('places an order and lists it for its shopper', () => {
    const result = place('ada@example.com', { items: ['trail-shoes', 'water-bottle'], shipping: home });

    expect('order' in result && result.order.total).toBe(108);
    expect(forShopper('ada@example.com')).toEqual(['order' in result && result.order]);
    expect(forShopper('bob@example.com')).toEqual([]);
  });
});
