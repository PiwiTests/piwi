import { test, expect } from './fixtures';

// The API every backend implements, as the README's contract describes it, called without a page. A new backend
// passes these before the page specs.
test.describe('API contract', { tag: '@api' }, () => {
  const shopper = { Cookie: 'shop_user=alice%40example.com' };
  const shipping = { name: 'Alice Martin', address: '12 Harbour Street', city: 'La Rochelle', country: 'France' };

  test('lists the items and finds a user by id', async ({ request }) => {
    const items = await request.get('/api/items');
    expect(items.status()).toBe(200);
    expect(((await items.json()) as { name: string }[]).map((item) => item.name)).toEqual(['Alpha', 'Beta', 'Gamma']);

    const user = await request.get('/api/users/7');
    expect(await user.json()).toEqual({ id: 7, name: 'User 7' });
    const unknown = await request.get('/api/users/seven');
    expect(unknown.status()).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'No such user' });
  });

  test('checks the contact form on the server', async ({ request }) => {
    const sent = await request.post('/api/submit', { data: { email: 'ada@example.com', message: 'Hello' } });
    expect(sent.status()).toBe(200);
    const withoutEmail = await request.post('/api/submit', { data: { message: 'No email' } });
    expect(withoutEmail.status()).toBe(400);
  });

  test('serves the products, and a 404 for one it does not sell', async ({ request }) => {
    const products = await request.get('/api/products');
    expect(((await products.json()) as { slug: string }[]).map((product) => product.slug)).toEqual([
      'trail-shoes',
      'rain-jacket',
      'water-bottle',
    ]);
    expect(await (await request.get('/api/products/rain-jacket')).json()).toMatchObject({
      name: 'Rain jacket',
      price: 129,
    });
    expect((await request.get('/api/products/canoe')).status()).toBe(404);
    expect((await request.get('/shop/products/canoe')).status()).toBe(404);
  });

  test('prices an order and writes its summary', async ({ request }) => {
    const placed = await request.post('/api/orders', {
      headers: shopper,
      data: { items: ['trail-shoes', 'water-bottle', 'water-bottle'], shipping },
    });
    expect(placed.status()).toBe(201);
    expect(await placed.json()).toMatchObject({
      name: 'Alice Martin',
      count: 3,
      total: 127,
      summary: '3 item(s) on their way to La Rochelle, France.',
    });
  });

  test('refuses an order it cannot place', async ({ request }) => {
    const anonymous = await request.post('/api/orders', { data: { items: ['trail-shoes'], shipping } });
    expect(anonymous.status()).toBe(401);

    const empty = await request.post('/api/orders', { headers: shopper, data: { items: [], shipping } });
    expect(empty.status()).toBe(400);
    expect(await empty.json()).toEqual({ error: 'Your cart is empty.' });

    const unknown = await request.post('/api/orders', { headers: shopper, data: { items: ['canoe'], shipping } });
    expect(unknown.status()).toBe(400);

    const abroad = await request.post('/api/orders', {
      headers: shopper,
      data: { items: ['trail-shoes'], shipping: { ...shipping, country: 'Mars' } },
    });
    expect(abroad.status()).toBe(400);
  });
});
