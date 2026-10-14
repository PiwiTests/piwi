// The shop's pages, on top of app.js. The browser keeps the shop's state: the signed-in shopper in the `shop_user`
// cookie, the cart (one product slug per item) in local storage. The products come from the backend, which also
// places the orders.
const shop = {
  user: () => decodeURIComponent((document.cookie.match(/(?:^|; )shop_user=([^;]*)/) || [])[1] || ''),
  cart: () => JSON.parse(localStorage.getItem('shop_cart') || '[]'),
  setCart: (items) => localStorage.setItem('shop_cart', JSON.stringify(items)),

  /** The JSON body of a GET, or the message to show when the backend answers an error. */
  async load(url, what) {
    const { ok, status, body } = await sample.request(url);
    if (ok) return { body };
    return { error: status === 404 ? `No such ${what}.` : `Could not load the ${what} (${status}).` };
  },

  /** Two letters standing for a product where a picture would be. */
  initials: (name) =>
    name
      .split(' ')
      .map((word) => word[0])
      .join('')
      .toUpperCase(),
};

/**
 * A shop page's behavior: it fills in the shop bar first, and a page that needs a shopper sends a visitor to the
 * sign-in page.
 */
function shopPage(behavior, { signedIn = true } = {}) {
  return () => {
    if (signedIn && !shop.user()) {
      location.replace('/shop/login?next=' + encodeURIComponent(location.pathname));
      return;
    }
    document.getElementById('cart-count').textContent = String(shop.cart().length);
    if (shop.user()) {
      document.getElementById('shopper').textContent = shop.user();
      const signOut = document.getElementById('sign-out');
      signOut.hidden = false;
      signOut.addEventListener('click', () => {
        document.cookie = 'shop_user=; path=/; max-age=0';
        location.assign('/shop/login');
      });
    }
    return behavior();
  };
}

sample.pages['shop-login'] = shopPage(
  () => {
    document.getElementById('sign-in').addEventListener('submit', (event) => {
      event.preventDefault();
      const email = document.getElementById('email').value.trim();
      if (!document.getElementById('password').value) {
        document.getElementById('error').textContent = 'Enter your password.';
        return;
      }
      document.cookie = 'shop_user=' + encodeURIComponent(email) + '; path=/';
      const next = new URLSearchParams(location.search).get('next');
      location.assign(next && next.startsWith('/') && !next.startsWith('//') ? next : '/shop');
    });
  },
  { signedIn: false },
);

sample.pages['shop-products'] = shopPage(async () => {
  const added = sessionStorage.getItem('shop_added');
  sessionStorage.removeItem('shop_added');
  if (added) document.getElementById('added').textContent = added + ' added to the cart';

  const { body: products, error } = await shop.load('/api/products', 'products');
  if (error) {
    document.getElementById('products-error').textContent = error;
    return;
  }
  document.getElementById('products').replaceChildren(
    ...products.map((product) => {
      const card = sample.element('li', 'card product');
      const title = sample.element('h2');
      const link = sample.element('a', '', product.name);
      link.href = '/shop/products/' + encodeURIComponent(product.slug);
      title.append(link);
      const thumb = sample.element('div', 'thumb', shop.initials(product.name));
      thumb.setAttribute('aria-hidden', 'true');
      card.append(
        thumb,
        title,
        sample.element('p', 'muted', product.description),
        sample.element('p', 'price', sample.price(product.price)),
      );
      return card;
    }),
  );
});

sample.pages['shop-product'] = shopPage(async () => {
  const slug = decodeURIComponent(location.pathname.split('/').pop());
  const { body: product, error } = await shop.load('/api/products/' + encodeURIComponent(slug), 'product');
  if (error) {
    document.getElementById('product-error').textContent = error;
    return;
  }
  document.title = product.name + ' · Piwi Sample';
  document.getElementById('name').textContent = product.name;
  document.getElementById('thumb').textContent = shop.initials(product.name);
  document.getElementById('price').textContent = sample.price(product.price);
  document.getElementById('description').textContent = product.description;
  const add = document.getElementById('add');
  add.disabled = false;
  add.addEventListener('click', () => {
    const quantity = Number(document.getElementById('quantity').value);
    shop.setCart([...shop.cart(), ...Array(quantity).fill(product.slug)]);
    sessionStorage.setItem('shop_added', product.name);
    location.assign('/shop');
  });
});

sample.pages['shop-cart'] = shopPage(async () => {
  const cart = shop.cart();
  const total = document.getElementById('total');
  if (cart.length === 0) {
    total.textContent = 'Your cart is empty.';
    return;
  }
  const { body: products, error } = await shop.load('/api/products', 'products');
  if (error) {
    document.getElementById('cart-error').textContent = error;
    return;
  }
  const lines = products
    .map((product) => ({ product, quantity: cart.filter((slug) => slug === product.slug).length }))
    .filter((line) => line.quantity > 0);
  document.getElementById('items').replaceChildren(
    ...lines.map(({ product, quantity }) => {
      const row = sample.element('li');
      row.append(
        sample.element('span', '', `${product.name} × ${quantity}`),
        sample.element('span', '', sample.price(product.price * quantity)),
      );
      return row;
    }),
  );
  const sum = lines.reduce((amount, { product, quantity }) => amount + product.price * quantity, 0);
  total.textContent = 'Total: ' + sample.price(sum);
  const checkout = document.getElementById('checkout');
  checkout.disabled = false;
  checkout.addEventListener('click', () => location.assign('/shop/checkout'));
});

sample.pages['shop-checkout'] = shopPage(() => {
  const form = document.getElementById('shipping');
  const error = document.getElementById('order-error');
  const submit = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    const { ok, status, body } = await sample.request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: shop.cart(), shipping: Object.fromEntries(new FormData(form)) }),
    });
    if (!ok) {
      error.textContent = body?.error || `The order was not placed (${status}).`;
      submit.disabled = false;
      return;
    }
    sessionStorage.setItem('shop_order', JSON.stringify(body));
    shop.setCart([]);
    location.assign('/shop/done');
  });
});

sample.pages['shop-done'] = shopPage(() => {
  const order = JSON.parse(sessionStorage.getItem('shop_order') || 'null');
  if (!order) return;
  document.getElementById('thanks').textContent = 'Thank you, ' + order.name + '!';
  document.getElementById('summary').textContent = order.summary;
  document.getElementById('order').textContent = `Order ${order.id} · Total ${sample.price(order.total)}`;
});

sample.pages['shop-orders'] = shopPage(async () => {
  const { body: orders, error } = await shop.load('/api/orders', 'orders');
  if (error) {
    document.getElementById('orders-error').textContent = error;
    return;
  }
  document.getElementById('empty').hidden = orders.length > 0;
  document.getElementById('orders').replaceChildren(
    ...orders.map((order) => {
      const row = sample.element('li');
      row.append(
        sample.element('span', '', `Order ${order.id} · ${order.count} item(s) to ${order.city}, ${order.country}`),
        sample.element('span', '', sample.price(order.total)),
      );
      return row;
    }),
  );
});
