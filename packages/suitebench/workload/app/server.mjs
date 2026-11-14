// The reference workload's app server: an orders console with a latency-shaped JSON API, served beside a slow
// "third-party" origin (analytics and a chat widget). No dependencies.
//
//   PORT          app origin port (default 4310); the vendor origin listens on PORT + 1
//   LATENCY       multiplier applied to every simulated delay (default 1; 0 serves without delays)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT ?? 4310);
const VENDOR_PORT = Number(process.env.VENDOR_PORT ?? PORT + 1);
const LATENCY = Number(process.env.LATENCY ?? 1);
const PASSWORD = 'bench-password';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const sleep = (base, jitter = 0) =>
  new Promise((resolve) => setTimeout(resolve, (base + Math.random() * jitter) * LATENCY));

// Seeded data, so every run starts from the same 1,200 orders.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANIES = [
  'Acme Corp', 'Globex', 'Initech', 'Umbrella Supply', 'Stark Industrial', 'Wayne Logistics', 'Hooli', 'Vandelay Imports',
  'Soylent Foods', 'Tyrell Systems', 'Cyberdyne', 'Wonka Confectionery', 'Gringotts Holdings', 'Oceanic Freight',
  'Monarch Labs', 'Pied Piper', 'Massive Dynamic', 'Aperture Science', 'Black Mesa', 'Nakatomi Trading', 'Dunder Paper',
  'Prestige Worldwide', 'Bluth Company', 'Sterling Cooper', 'Kramerica', 'Los Pollos', 'Gekko & Co', 'Virtucon',
  'Duff Brewing', 'Krusty Foods', 'Planet Express', 'Mom Corp', 'Spacely Sprockets', 'Cogswell Cogs', 'Oscorp',
  'Wernham Hogg', 'Paddy\'s Pub', 'Strickland Propane', 'Big Kahuna', 'Ollivanders', 'Zorg Industries', 'Weyland Corp',
];
const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
const STATUS_WEIGHTS = [0.12, 0.18, 0.2, 0.42, 0.08];

function seedOrders() {
  const random = mulberry32(42);
  const start = Date.UTC(2026, 9, 31, 18, 0, 0);
  const orders = [];
  for (let i = 1; i <= 1200; i++) {
    const customer = COMPANIES[Math.floor(random() * COMPANIES.length)];
    let pick = random();
    let status = STATUSES[STATUSES.length - 1];
    for (let s = 0; s < STATUSES.length; s++) {
      if (pick < STATUS_WEIGHTS[s]) {
        status = STATUSES[s];
        break;
      }
      pick -= STATUS_WEIGHTS[s];
    }
    const items = 1 + Math.floor(random() * 12);
    orders.push({
      id: i,
      number: `SO-${10000 + i}`,
      customer,
      email: `orders@${customer.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
      status,
      items,
      total: Math.round(items * (19 + random() * 240) * 100) / 100,
      notes: '',
      createdAt: new Date(start - i * 3_600_000 * 2.7).toISOString(),
    });
  }
  return orders;
}

const orders = seedOrders();
let nextId = orders.length + 1;
const activity = orders.slice(0, 8).map((order) => ({
  at: order.createdAt,
  text: `${order.customer} placed ${order.number}`,
}));
const sessions = new Map();
const exportJobs = new Map();

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function sessionOf(req) {
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '');
  return match ? sessions.get(match[1]) : undefined;
}

function validateOrder(input, partial = false) {
  const errors = {};
  if (!partial || 'customer' in input) {
    if (!String(input.customer ?? '').trim()) errors.customer = 'Customer is required';
  }
  if (!partial || 'email' in input) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(input.email ?? ''))) errors.email = 'Enter a valid email address';
  }
  if (!partial || 'items' in input) {
    const items = Number(input.items);
    if (!Number.isInteger(items) || items < 1 || items > 999) errors.items = 'Quantity must be between 1 and 999';
  }
  if ('status' in input && !STATUSES.includes(input.status)) errors.status = 'Unknown status';
  return errors;
}

function listOrders(params) {
  const q = (params.get('q') ?? '').trim().toLowerCase();
  const status = params.get('status') ?? '';
  const sort = params.get('sort') ?? 'createdAt';
  const dir = params.get('dir') === 'asc' ? 1 : -1;
  let rows = orders.filter(
    (order) =>
      (!q || order.customer.toLowerCase().includes(q) || order.number.toLowerCase().includes(q)) &&
      (!status || order.status === status),
  );
  rows = rows.toSorted((a, b) => {
    const left = a[sort];
    const right = b[sort];
    if (left === right) return (a.id - b.id) * dir;
    return (left < right ? -1 : 1) * dir;
  });
  const size = params.get('size') === 'all' ? rows.length || 1 : Number(params.get('size') ?? 25);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(Math.max(1, Number(params.get('page') ?? 1)), pages);
  return { total: rows.length, page, pages, rows: rows.slice((page - 1) * size, page * size) };
}

async function api(req, res, url) {
  const path = url.pathname;
  if (path === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    await sleep(320, 80);
    if (body.password !== PASSWORD || !String(body.email ?? '').includes('@')) {
      return send(res, 401, { error: 'Wrong email or password' });
    }
    const sid = randomUUID();
    sessions.set(sid, { email: body.email, settings: { notifications: true, digest: false, currency: 'USD' } });
    return send(res, 200, { email: body.email }, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
  }

  const session = sessionOf(req);
  if (!session) {
    await sleep(30);
    return send(res, 401, { error: 'Sign in first' });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    await sleep(40);
    return send(res, 204, undefined, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
  }
  if (path === '/api/me') {
    await sleep(50, 30);
    return send(res, 200, { email: session.email });
  }
  if (path === '/api/stats') {
    await sleep(380, 160);
    const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    let revenue = 0;
    for (const order of orders) {
      byStatus[order.status]++;
      if (order.status !== 'cancelled') revenue += order.total;
    }
    return send(res, 200, {
      orders: orders.length,
      revenue: Math.round(revenue),
      average: Math.round(revenue / orders.length),
      pending: byStatus.pending,
      byStatus,
    });
  }
  if (path === '/api/activity') {
    await sleep(220, 120);
    return send(res, 200, activity.slice(0, 8));
  }
  if (path === '/api/settings') {
    if (req.method === 'PUT') {
      const body = await readJson(req);
      await sleep(260, 80);
      session.settings = { ...session.settings, ...body };
    } else {
      await sleep(90, 40);
    }
    return send(res, 200, session.settings);
  }
  if (path === '/api/exports' && req.method === 'POST') {
    await sleep(140, 40);
    const id = randomUUID();
    exportJobs.set(id, Date.now());
    return send(res, 202, { id });
  }
  const exportMatch = /^\/api\/exports\/([\w-]+)$/.exec(path);
  if (exportMatch) {
    await sleep(60, 30);
    const startedAt = exportJobs.get(exportMatch[1]);
    if (!startedAt) return send(res, 404, { error: 'Unknown export' });
    const ready = Date.now() - startedAt > 1600 * LATENCY;
    return send(res, 200, { status: ready ? 'ready' : 'running', url: ready ? `/exports/${exportMatch[1]}.csv` : null });
  }
  if (path === '/api/orders' && req.method === 'GET') {
    await sleep(110, 140);
    return send(res, 200, listOrders(url.searchParams));
  }
  if (path === '/api/orders' && req.method === 'POST') {
    const body = await readJson(req);
    await sleep(190, 60);
    const errors = validateOrder(body);
    if (Object.keys(errors).length) return send(res, 422, { errors });
    const items = Number(body.items);
    const id = nextId++;
    const order = {
      id,
      number: `SO-${10000 + id}`,
      customer: String(body.customer).trim(),
      email: String(body.email),
      status: 'pending',
      items,
      total: Math.round(items * 49.5 * 100) / 100,
      notes: String(body.notes ?? ''),
      createdAt: new Date().toISOString(),
    };
    orders.unshift(order);
    activity.unshift({ at: order.createdAt, text: `${order.customer} placed ${order.number}` });
    return send(res, 201, order);
  }
  const orderMatch = /^\/api\/orders\/(\d+)$/.exec(path);
  if (orderMatch) {
    const id = Number(orderMatch[1]);
    // Looked up after every await: concurrent creates shift the array.
    const indexOf = () => orders.findIndex((order) => order.id === id);
    if (req.method === 'GET') {
      await sleep(90, 60);
      const index = indexOf();
      return index < 0 ? send(res, 404, { error: 'Order not found' }) : send(res, 200, orders[index]);
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      await sleep(210, 70);
      const index = indexOf();
      if (index < 0) return send(res, 404, { error: 'Order not found' });
      const errors = validateOrder(body, true);
      if (Object.keys(errors).length) return send(res, 422, { errors });
      const patch = {};
      for (const key of ['customer', 'email', 'status', 'notes']) if (key in body) patch[key] = body[key];
      if ('items' in body) patch.items = Number(body.items);
      orders[index] = { ...orders[index], ...patch };
      return send(res, 200, orders[index]);
    }
    if (req.method === 'DELETE') {
      await sleep(160, 50);
      const index = indexOf();
      if (index < 0) return send(res, 404, { error: 'Order not found' });
      orders.splice(index, 1);
      return send(res, 204);
    }
  }
  return send(res, 404, { error: 'Not found' });
}

async function serveFile(res, file, delay) {
  try {
    const body = await readFile(join(PUBLIC_DIR, file));
    await sleep(delay, delay / 2);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  if (url.pathname.startsWith('/exports/')) {
    await sleep(80);
    res.writeHead(200, { 'content-type': 'text/csv' });
    return res.end('number,customer,status,total\n');
  }
  const file = url.pathname.slice(1);
  if (/^[\w-]+\.(js|css|svg)$/.test(file)) return serveFile(res, file, 25);
  // Every other path is a client-side route.
  const html = (await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8')).replaceAll('__VENDOR_ORIGIN__', vendorOrigin(req));
  await sleep(40, 20);
  res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
  res.end(html);
});

function vendorOrigin(req) {
  const host = (req.headers.host ?? 'localhost').split(':')[0];
  // A different host name gives the vendor scripts their own origin, as a real third party has.
  return `http://${host === '127.0.0.1' ? 'localhost' : '127.0.0.1'}:${VENDOR_PORT}`;
}

const VENDOR_SCRIPTS = {
  '/analytics.js': { delay: 650, file: 'vendor-analytics.js' },
  '/widget.js': { delay: 900, file: 'vendor-widget.js' },
};

const vendor = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://vendor');
  const script = VENDOR_SCRIPTS[url.pathname];
  if (script) {
    const body = await readFile(join(PUBLIC_DIR, script.file));
    await sleep(script.delay, script.delay / 3);
    res.writeHead(200, { 'content-type': MIME['.js'], 'access-control-allow-origin': '*' });
    return res.end(body);
  }
  if (url.pathname === '/beacon') {
    await sleep(120, 80);
    res.writeHead(204, { 'access-control-allow-origin': '*' });
    return res.end();
  }
  res.writeHead(404);
  res.end();
});

app.listen(PORT, () => {
  vendor.listen(VENDOR_PORT, () => {
    console.log(`orders console on http://localhost:${PORT} (vendor origin port ${VENDOR_PORT}, latency x${LATENCY})`);
  });
});
