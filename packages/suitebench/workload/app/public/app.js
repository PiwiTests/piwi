// The orders console: a small single-page app with the shapes real suites meet (a session check on every load,
// skeletons while data loads, a debounced search, a large table, dialogs and toasts that animate, a polled job).
const app = document.getElementById('app');
const toasts = document.getElementById('toasts');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401 && path !== '/api/login') {
    navigate('/login', true);
    throw new Error('signed out');
  }
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw Object.assign(new Error(data?.error ?? 'Request failed'), { status: response.status, data });
  return data;
}

function toast(message) {
  const element = document.createElement('div');
  element.className = 'toast';
  element.textContent = message;
  toasts.append(element);
  setTimeout(() => {
    element.classList.add('leaving');
    setTimeout(() => element.remove(), reducedMotion ? 0 : 220);
  }, 4000);
}

function navigate(path, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  route();
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link || event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});
window.addEventListener('popstate', route);

let me = null;
let renderToken = 0;

async function route() {
  const token = ++renderToken;
  const path = location.pathname;
  if (path === '/login') return renderLogin();
  if (!me) {
    try {
      me = await api('/api/me');
    } catch {
      return;
    }
  }
  if (token !== renderToken) return;
  const page =
    path === '/' ? renderDashboard
    : path === '/orders' ? renderOrders
    : path === '/orders/new' ? renderNewOrder
    : /^\/orders\/\d+$/.test(path) ? renderOrder
    : path === '/settings' ? renderSettings
    : renderNotFound;
  shell(path);
  await page(document.getElementById('view'), token);
}

function shell(path) {
  const nav = [
    ['/', 'Dashboard'],
    ['/orders', 'Orders'],
    ['/settings', 'Settings'],
  ]
    .map(([href, label]) => {
      const current = href === '/' ? path === '/' : path.startsWith(href);
      return `<a href="${href}" data-link ${current ? 'aria-current="page"' : ''}>${label}</a>`;
    })
    .join('');
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="/" data-link><img src="/logo.svg" alt="" width="24" height="24" /> Orders console</a>
      <nav aria-label="Main">${nav}</nav>
      <span class="user">${escape(me.email)}</span>
      <button type="button" class="ghost" id="sign-out">Sign out</button>
    </header>
    <main id="view" class="view"></main>`;
  document.getElementById('sign-out').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    me = null;
    navigate('/login');
  });
}

function renderLogin() {
  me = null;
  app.innerHTML = `
    <main class="login">
      <form id="login-form" class="card" novalidate>
        <h1>Sign in</h1>
        <label>Email <input name="email" type="email" autocomplete="username" required /></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
        <p class="error" id="login-error" hidden></p>
        <button type="submit" class="primary">Sign in</button>
      </form>
    </main>`;
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Signing in…';
    const data = Object.fromEntries(new FormData(form));
    try {
      me = await api('/api/login', { method: 'POST', body: data });
      navigate('/');
    } catch (error) {
      const message = document.getElementById('login-error');
      message.textContent = error.message;
      message.hidden = false;
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });
}

async function renderDashboard(view, token) {
  view.innerHTML = `
    <h1>Dashboard</h1>
    <section class="kpis" aria-label="Key figures">
      ${['Orders', 'Revenue', 'Average order', 'Pending'].map((label) => `<div class="kpi"><span>${label}</span><strong class="skeleton">&nbsp;</strong></div>`).join('')}
    </section>
    <div class="columns">
      <section class="card">
        <h2>Orders by status</h2>
        <canvas id="chart" width="520" height="220" aria-label="Orders by status chart" role="img"></canvas>
      </section>
      <section class="card">
        <h2>Recent activity</h2>
        <ul id="activity" class="activity" aria-busy="true"><li class="skeleton">&nbsp;</li><li class="skeleton">&nbsp;</li></ul>
      </section>
    </div>`;
  const [stats, activity] = await Promise.all([api('/api/stats'), api('/api/activity')]);
  if (token !== renderToken) return;
  const values = [stats.orders.toLocaleString('en-US'), money.format(stats.revenue), money.format(stats.average), String(stats.pending)];
  view.querySelectorAll('.kpi strong').forEach((element, index) => {
    element.classList.remove('skeleton');
    element.textContent = values[index];
  });
  const list = document.getElementById('activity');
  list.removeAttribute('aria-busy');
  list.innerHTML = activity.map((item) => `<li><time>${date.format(new Date(item.at))}</time> ${escape(item.text)}</li>`).join('');
  drawChart(document.getElementById('chart'), stats.byStatus);
}

function drawChart(canvas, byStatus) {
  const context = canvas.getContext('2d');
  const max = Math.max(...Object.values(byStatus));
  const colors = ['#d97706', '#2563eb', '#7c3aed', '#059669', '#9ca3af'];
  const started = performance.now();
  const duration = reducedMotion ? 0 : 450;
  canvas.dataset.state = 'animating';
  const frame = (now) => {
    const progress = duration ? Math.min(1, (now - started) / duration) : 1;
    context.clearRect(0, 0, canvas.width, canvas.height);
    STATUSES.forEach((status, index) => {
      const height = (byStatus[status] / max) * 170 * progress;
      const x = 24 + index * 100;
      context.fillStyle = colors[index];
      context.fillRect(x, 190 - height, 64, height);
      context.fillStyle = '#374151';
      context.font = '12px system-ui';
      context.fillText(status, x, 210);
    });
    if (progress < 1) requestAnimationFrame(frame);
    else canvas.dataset.state = 'ready';
  };
  requestAnimationFrame(frame);
}

async function renderOrders(view, token) {
  const params = new URLSearchParams(location.search);
  const state = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    sort: params.get('sort') ?? 'createdAt',
    dir: params.get('dir') ?? 'desc',
    page: Number(params.get('page') ?? 1),
    size: params.get('size') ?? '25',
  };
  const column = (key, label) => `<th scope="col" data-key="${key}"><button type="button" class="sort" data-sort="${key}">${label}</button></th>`;
  view.innerHTML = `
    <div class="title-row">
      <h1>Orders</h1>
      <div class="actions">
        <button type="button" id="export">Export CSV</button>
        <a class="button primary" href="/orders/new" data-link>New order</a>
      </div>
    </div>
    <p id="export-status" class="muted" aria-live="polite"></p>
    <div class="filters">
      <label>Search orders <input id="search" type="search" placeholder="Customer or number" value="${escape(state.q)}" /></label>
      <label>Status
        <select id="status">
          <option value="">All statuses</option>
          ${STATUSES.map((status) => `<option value="${status}" ${state.status === status ? 'selected' : ''}>${status[0].toUpperCase() + status.slice(1)}</option>`).join('')}
        </select>
      </label>
      <label>Rows
        <select id="size">
          ${['25', '50', 'all'].map((size) => `<option value="${size}" ${state.size === size ? 'selected' : ''}>${size === 'all' ? 'All' : size}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="table-wrap">
      <table id="orders">
        <caption class="sr-only">Orders</caption>
        <thead><tr>${column('number', 'Number')}${column('customer', 'Customer')}<th scope="col">Status</th>${column('items', 'Items')}${column('total', 'Total')}${column('createdAt', 'Created')}</tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <nav class="pager" aria-label="Pagination">
      <button type="button" id="prev">Previous</button>
      <span id="page-label"></span>
      <button type="button" id="next">Next</button>
    </nav>`;

  const table = document.getElementById('orders');
  const tbody = table.querySelector('tbody');
  let loadToken = 0;
  let pages = 1;

  async function load() {
    const current = ++loadToken;
    table.setAttribute('aria-busy', 'true');
    const query = new URLSearchParams(Object.entries(state).filter(([, value]) => value !== '' && value !== undefined));
    history.replaceState(null, '', `/orders?${query}`);
    const result = await api(`/api/orders?${query}`);
    if (current !== loadToken || token !== renderToken) return;
    pages = result.pages;
    tbody.innerHTML = result.rows.length
      ? result.rows
          .map(
            (order) => `<tr>
              <td><a href="/orders/${order.id}" data-link>${order.number}</a></td>
              <td>${escape(order.customer)}</td>
              <td><span class="badge ${order.status}">${order.status}</span></td>
              <td class="num">${order.items}</td>
              <td class="num">${money.format(order.total)}</td>
              <td>${date.format(new Date(order.createdAt))}</td>
            </tr>`,
          )
          .join('')
      : '<tr><td colspan="6" class="empty">No orders match these filters</td></tr>';
    document.getElementById('page-label').textContent = `Page ${result.page} of ${result.pages} · ${result.total} orders`;
    document.getElementById('prev').disabled = result.page <= 1;
    document.getElementById('next').disabled = result.page >= result.pages;
    table.querySelectorAll('th[data-key]').forEach((th) => {
      th.setAttribute('aria-sort', th.dataset.key === state.sort ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
    table.removeAttribute('aria-busy');
  }

  let debounce;
  document.getElementById('search').addEventListener('input', (event) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = event.target.value;
      state.page = 1;
      load();
    }, 300);
  });
  document.getElementById('status').addEventListener('change', (event) => {
    state.status = event.target.value;
    state.page = 1;
    load();
  });
  document.getElementById('size').addEventListener('change', (event) => {
    state.size = event.target.value;
    state.page = 1;
    load();
  });
  document.getElementById('prev').addEventListener('click', () => {
    state.page = Math.max(1, state.page - 1);
    load();
  });
  document.getElementById('next').addEventListener('click', () => {
    state.page = Math.min(pages, state.page + 1);
    load();
  });
  table.querySelectorAll('button.sort').forEach((button) =>
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      state.dir = state.sort === key && state.dir === 'asc' ? 'desc' : 'asc';
      state.sort = key;
      state.page = 1;
      load();
    }),
  );
  document.getElementById('export').addEventListener('click', async () => {
    const status = document.getElementById('export-status');
    status.textContent = 'Preparing export…';
    const job = await api('/api/exports', { method: 'POST' });
    const poll = async () => {
      if (token !== renderToken) return;
      const result = await api(`/api/exports/${job.id}`);
      if (result.status === 'ready') status.innerHTML = `Export ready. <a href="${result.url}">Download export</a>`;
      else setTimeout(poll, 500);
    };
    setTimeout(poll, 500);
  });
  await load();
}

function orderForm(order = {}) {
  return `
    <label>Customer <input name="customer" value="${escape(order.customer ?? '')}" aria-describedby="customer-error" /></label>
    <p class="error" id="customer-error"></p>
    <label>Email <input name="email" type="email" value="${escape(order.email ?? '')}" aria-describedby="email-error" /></label>
    <p class="error" id="email-error"></p>
    <label>Quantity <input name="items" type="number" min="1" value="${escape(order.items ?? 1)}" aria-describedby="items-error" /></label>
    <p class="error" id="items-error"></p>
    ${order.id ? `<label>Status <select name="status">${STATUSES.map((status) => `<option ${order.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select></label>` : ''}
    <label>Notes <textarea name="notes" rows="3">${escape(order.notes ?? '')}</textarea></label>`;
}

function readForm(form) {
  const data = Object.fromEntries(new FormData(form));
  data.items = Number(data.items);
  return data;
}

function showErrors(form, errors) {
  for (const name of ['customer', 'email', 'items']) {
    const input = form.elements[name];
    const message = form.querySelector(`#${name}-error`);
    message.textContent = errors[name] ?? '';
    if (errors[name]) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function clientErrors(data) {
  const errors = {};
  if (!String(data.customer ?? '').trim()) errors.customer = 'Customer is required';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(data.email ?? ''))) errors.email = 'Enter a valid email address';
  if (!Number.isInteger(data.items) || data.items < 1 || data.items > 999) errors.items = 'Quantity must be between 1 and 999';
  return errors;
}

function renderNewOrder(view) {
  view.innerHTML = `
    <h1>New order</h1>
    <form id="new-order" class="card form" novalidate>
      ${orderForm()}
      <div class="actions"><a href="/orders" data-link class="button">Cancel</a><button type="submit" class="primary">Create order</button></div>
    </form>`;
  const form = document.getElementById('new-order');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = readForm(form);
    const errors = clientErrors(data);
    showErrors(form, errors);
    if (Object.keys(errors).length) return;
    try {
      const order = await api('/api/orders', { method: 'POST', body: data });
      toast(`Order ${order.number} created`);
      navigate(`/orders/${order.id}`);
    } catch (error) {
      if (error.data?.errors) showErrors(form, error.data.errors);
    }
  });
}

function closeDialog(dialog) {
  dialog.classList.add('closing');
  setTimeout(() => dialog.close(), reducedMotion ? 0 : 200);
}

async function renderOrder(view, token) {
  view.innerHTML = '<p class="skeleton wide">&nbsp;</p>';
  const id = Number(location.pathname.split('/').pop());
  let order;
  try {
    order = await api(`/api/orders/${id}`);
  } catch (error) {
    if (error.status === 404) return renderNotFound(view);
    throw error;
  }
  if (token !== renderToken) return;
  const render = () => {
    view.innerHTML = `
      <p><a href="/orders" data-link>← All orders</a></p>
      <div class="title-row">
        <h1>${order.number}</h1>
        <div class="actions"><button type="button" id="edit">Edit</button><button type="button" id="delete" class="danger">Delete</button></div>
      </div>
      <dl class="card details">
        <dt>Customer</dt><dd data-field="customer">${escape(order.customer)}</dd>
        <dt>Email</dt><dd data-field="email">${escape(order.email)}</dd>
        <dt>Status</dt><dd data-field="status"><span class="badge ${order.status}">${order.status}</span></dd>
        <dt>Quantity</dt><dd data-field="items">${order.items}</dd>
        <dt>Total</dt><dd data-field="total">${money.format(order.total)}</dd>
        <dt>Notes</dt><dd data-field="notes">${escape(order.notes || '—')}</dd>
      </dl>
      <dialog id="edit-dialog" aria-labelledby="edit-title">
        <form method="dialog" id="edit-form" class="form" novalidate>
          <h2 id="edit-title">Edit ${order.number}</h2>
          ${orderForm(order)}
          <div class="actions"><button type="button" id="cancel-edit">Cancel</button><button type="submit" class="primary">Save changes</button></div>
        </form>
      </dialog>
      <dialog id="delete-dialog" aria-labelledby="delete-title">
        <h2 id="delete-title">Delete ${order.number}?</h2>
        <p>This removes the order for every user.</p>
        <div class="actions"><button type="button" id="cancel-delete">Keep order</button><button type="button" id="confirm-delete" class="danger">Delete order</button></div>
      </dialog>`;
    const editDialog = document.getElementById('edit-dialog');
    const deleteDialog = document.getElementById('delete-dialog');
    const form = document.getElementById('edit-form');
    document.getElementById('edit').addEventListener('click', () => {
      editDialog.classList.remove('closing');
      editDialog.showModal();
    });
    document.getElementById('cancel-edit').addEventListener('click', () => closeDialog(editDialog));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = readForm(form);
      const errors = clientErrors(data);
      showErrors(form, errors);
      if (Object.keys(errors).length) return;
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        order = await api(`/api/orders/${id}`, { method: 'PATCH', body: data });
        closeDialog(editDialog);
        setTimeout(render, reducedMotion ? 0 : 200);
        toast('Order updated');
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Save changes';
        if (error.data?.errors) showErrors(form, error.data.errors);
      }
    });
    document.getElementById('delete').addEventListener('click', () => {
      deleteDialog.classList.remove('closing');
      deleteDialog.showModal();
    });
    document.getElementById('cancel-delete').addEventListener('click', () => closeDialog(deleteDialog));
    document.getElementById('confirm-delete').addEventListener('click', async () => {
      await api(`/api/orders/${id}`, { method: 'DELETE' });
      deleteDialog.close();
      toast(`Order ${order.number} deleted`);
      navigate('/orders');
    });
  };
  render();
}

async function renderSettings(view, token) {
  view.innerHTML = '<h1>Settings</h1><p class="skeleton wide">&nbsp;</p>';
  const settings = await api('/api/settings');
  if (token !== renderToken) return;
  view.innerHTML = `
    <h1>Settings</h1>
    <form id="settings" class="card form">
      <label class="check"><input type="checkbox" name="notifications" ${settings.notifications ? 'checked' : ''} /> Email notifications</label>
      <label class="check"><input type="checkbox" name="digest" ${settings.digest ? 'checked' : ''} /> Weekly digest</label>
      <label>Currency
        <select name="currency">${['USD', 'EUR', 'GBP', 'JPY'].map((currency) => `<option ${settings.currency === currency ? 'selected' : ''}>${currency}</option>`).join('')}</select>
      </label>
      <div class="actions"><button type="submit" class="primary">Save settings</button></div>
    </form>`;
  const form = document.getElementById('settings');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    await api('/api/settings', {
      method: 'PUT',
      body: { notifications: form.elements.notifications.checked, digest: form.elements.digest.checked, currency: form.elements.currency.value },
    });
    button.disabled = false;
    toast('Settings saved');
  });
}

function renderNotFound(view) {
  view.innerHTML = '<h1>Page not found</h1><p><a href="/" data-link>Back to the dashboard</a></p>';
}

route();
