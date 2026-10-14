/**
 * Single source of truth for every demo failure story.
 *
 * A "story" is one failure cluster told end-to-end: the spec source that fails,
 * the exact failing line/column, the Playwright error text (built in the same
 * format the reporter's `buildErrorText` produces), the captured source
 * snippets (same format as the reporter's `readSourceSnippet`), the ARIA
 * snapshot of the failing page, the themed evidence (console/network/server
 * logs), the app source files and suspect commit that explain the failure, and
 * the suggested-fix patch (derived from those same source lines, so
 * `validatePatch` always reports `applies`).
 *
 * Consumed by:
 *  - `scripts/generate-demo-seed.mjs` (Node) — seeds errors, snippets, line
 *    numbers, evidence, clusters and diagnoses from the stories
 *  - `app/demo/demo-scm.ts` — builds the canned repos (source files, commits,
 *    suspect SHAs) from the same data
 *  - `app/demo/simulator.ts` — replays the exact same error text so simulated
 *    failures fingerprint into the seeded clusters
 *  - `tests/unit/demo-seed-consistency.test.ts` — asserts all of the above
 *    stays coherent
 *
 * Plain ESM + JSDoc (not TypeScript) because the seed script runs under plain
 * Node; types for TS consumers live in `failure-stories.d.mts`.
 */

// ── Source-snippet helpers (mirror reporter/src/internal/support/source-snippet.ts) ──

/**
 * Render a line-numbered snippet of `lines` around `anchor`, marking the
 * failing line with `> ` and the declaration line with `* ` — the exact format
 * the reporter's `readSourceSnippet` produces.
 *
 * @param {string[]} lines Full file content as an array of lines (1-based indexing via position).
 * @param {{ declLine?: number | null, failingLine?: number | null, context: number }} opts
 * @returns {string}
 */
export function renderSnippet(lines, { declLine = null, failingLine = null, context }) {
  const anchor = failingLine ?? declLine ?? 1;
  const start = Math.max(0, anchor - context - 1);
  const end = Math.min(lines.length, anchor + context);
  return lines
    .slice(start, end)
    .map((l, i) => {
      const lineNum = start + i + 1;
      const hasFailingLine = failingLine != null;
      const isFailing = hasFailingLine && lineNum === failingLine;
      const isDecl = lineNum === declLine && !isFailing;
      let marker = '  ';
      if (isFailing) marker = '> ';
      else if (isDecl) marker = hasFailingLine ? '* ' : '> ';
      return `${marker}${String(lineNum).padStart(4)} | ${l}`;
    })
    .join('\n');
}

/**
 * 1-based line number of the first (or nth) line containing `needle`.
 * Throws when absent so a story can never silently drift from its source.
 *
 * @param {string[]} lines @param {string} needle @param {number} [nth]
 * @returns {number}
 */
export function lineOf(lines, needle, nth = 0) {
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      if (seen === nth) return i + 1;
      seen++;
    }
  }
  throw new Error(`lineOf: needle not found in source: ${needle}`);
}

// ── Error-text builders (mirror reporter/src/internal/collect/error-text.ts output) ──

const ESC = '\u001b';
/** Wrap a value in the green/red SGR codes Playwright's expect output uses. */
const green = (s) => `${ESC}[32m${s}${ESC}[39m`;
const red = (s) => `${ESC}[31m${s}${ESC}[39m`;

/**
 * Render stack-frame lines the way `buildErrorText` stores them: 4-space
 * indent, optional enclosing function name, always `file:line:column`.
 *
 * @param {Array<{ file: string, line: number, column: number, fn?: string }>} frames
 */
function renderFrames(frames) {
  return frames
    .map((f) => (f.fn ? `    at ${f.fn} (${f.file}:${f.line}:${f.column})` : `    at ${f.file}:${f.line}:${f.column}`))
    .join('\n');
}

/**
 * A test-timeout capture: Playwright reports the bare test timeout as the
 * primary error and the interrupted action (with its call log) as a secondary
 * error; the reporter joins them with `\n---\n` (see error-text.ts).
 *
 * @param {{ timeoutMs: number, action: string, callLog: string[], frames: Array<{file: string, line: number, column: number, fn?: string}> }} p
 */
export function buildTestTimeoutError({ timeoutMs, action, callLog, frames }) {
  return [
    `Test timeout of ${timeoutMs}ms exceeded.`,
    '---',
    `${action}: Test timeout of ${timeoutMs}ms exceeded.`,
    'Call log:',
    ...callLog.map((l) => `  - ${l}`),
    '',
    renderFrames(frames),
  ].join('\n');
}

/**
 * An action that exceeded its own (explicit or config) timeout — Playwright
 * throws a TimeoutError whose message carries the call log.
 *
 * @param {{ action: string, timeoutMs: number, callLog: string[], frames: Array<{file: string, line: number, column: number, fn?: string}> }} p
 */
export function buildActionTimeoutError({ action, timeoutMs, callLog, frames }) {
  return [
    `TimeoutError: ${action}: Timeout ${timeoutMs}ms exceeded.`,
    'Call log:',
    ...callLog.map((l) => `  - ${l}`),
    '',
    renderFrames(frames),
  ].join('\n');
}

/**
 * A value assertion (`expect(x).toBe(y)` and friends) — no call log, the
 * reporter appends the synthetic frame directly after the Received line.
 *
 * @param {{ matcherLine: string, body: string[], frames: Array<{file: string, line: number, column: number, fn?: string}> }} p
 */
export function buildValueAssertionError({ matcherLine, body, frames }) {
  return [`Error: ${matcherLine}`, '', ...body, renderFrames(frames)].join('\n');
}

/**
 * A web-first assertion (`expect(locator).toBeVisible()` etc., Playwright ≥1.49
 * format): Locator/Expected/Received/Timeout header, then a call log.
 *
 * @param {{ matcher: string, locator: string, expected: string, received: string, timeoutMs: number,
 *           callLog: string[], frames: Array<{file: string, line: number, column: number, fn?: string}>, ansi?: boolean }} p
 */
export function buildWebAssertionError({ matcher, locator, expected, received, timeoutMs, callLog, frames, ansi }) {
  const exp = ansi ? green(expected) : expected;
  const rec = ansi ? red(received) : received;
  return [
    `Error: ${matcher} failed`,
    '',
    `Locator:  ${locator}`,
    `Expected: ${exp}`,
    `Received: ${rec}`,
    `Timeout:  ${timeoutMs}ms`,
    '',
    'Call log:',
    ...callLog.map((l) => (l.startsWith(' ') ? `  ${l}` : `  - ${l}`)),
    '',
    renderFrames(frames),
  ].join('\n');
}

/**
 * A strict-mode violation: the resolved elements are listed with `aka`
 * suggestions, followed by the call log.
 *
 * @param {{ action: string, selector: string, elements: string[], callLog: string[], frames: Array<{file: string, line: number, column: number, fn?: string}> }} p
 */
export function buildStrictModeError({ action, selector, elements, callLog, frames }) {
  return [
    `Error: ${action}: Error: strict mode violation: ${selector} resolved to ${elements.length} elements:`,
    ...elements.map((el, i) => `    ${i + 1}) ${el}`),
    '',
    'Call log:',
    ...callLog.map((l) => `  - ${l}`),
    '',
    renderFrames(frames),
  ].join('\n');
}

/**
 * A page/browser crash interrupting an action.
 *
 * @param {{ action: string, callLog: string[], frames: Array<{file: string, line: number, column: number, fn?: string}> }} p
 */
export function buildCrashError({ action, callLog, frames }) {
  return [
    `Error: ${action}: Target page, context or browser has been closed`,
    'Call log:',
    ...callLog.map((l) => `  - ${l}`),
    '',
    renderFrames(frames),
  ].join('\n');
}

// ── Unified-diff derivation (keeps suggested-fix patches glued to the sources) ──

/**
 * Build a unified diff from the file's actual source lines, so the hunk
 * headers and context can never drift from the content `validatePatch` checks
 * it against.
 *
 * One edit gives one hunk. Several edits give one hunk each, and edits whose
 * context lines overlap or touch share a hunk, the way `git diff` groups them.
 *
 * @param {string} file Repo-relative path.
 * @param {string[]} source Full file content as lines.
 * @param {PatchEdit | PatchEdit[]} edits One edit, or several on distinct lines.
 * @returns {string}
 *
 * @typedef {{ at: number, remove?: number, add?: string[], context?: number }} PatchEdit
 *   `at` — 1-based line where the change starts; `remove` — how many lines are
 *   deleted there (default 0); `add` — lines inserted in their place;
 *   `context` — unchanged lines shown around the change (default 1).
 */
export function derivePatch(file, source, edits) {
  const changes = (Array.isArray(edits) ? edits : [edits])
    .map(({ at, remove = 0, add = [], context = 1 }) => ({
      at,
      remove,
      add,
      // The 1-based first and last source lines the hunk shows for this edit.
      from: Math.max(1, at - context),
      to: Math.min(source.length, at - 1 + remove + context),
    }))
    .sort((a, b) => a.at - b.at);

  /** @type {Array<{ from: number, to: number, changes: typeof changes }>} */
  const hunks = [];
  for (const change of changes) {
    const last = hunks.at(-1);
    if (last && change.from <= last.to + 1) {
      last.to = Math.max(last.to, change.to);
      last.changes.push(change);
    } else {
      hunks.push({ from: change.from, to: change.to, changes: [change] });
    }
  }

  const out = [`--- a/${file}`, `+++ b/${file}`];
  // Lines added minus lines removed by the hunks already written.
  let shift = 0;
  for (const hunk of hunks) {
    const body = [];
    let line = hunk.from;
    let added = 0;
    let removed = 0;
    for (const change of hunk.changes) {
      for (; line < change.at; line++) body.push(` ${source[line - 1]}`);
      for (let i = 0; i < change.remove; i++, line++) body.push(`-${source[line - 1]}`);
      body.push(...change.add.map((l) => `+${l}`));
      added += change.add.length;
      removed += change.remove;
    }
    for (; line <= hunk.to; line++) body.push(` ${source[line - 1]}`);
    const oldCount = hunk.to - hunk.from + 1;
    out.push(`@@ -${hunk.from},${oldCount} +${hunk.from + shift},${oldCount - removed + added} @@`, ...body);
    shift += added - removed;
  }
  return out.join('\n');
}

/**
 * The file `derivePatch` turns `source` into: each edit's lines removed and
 * its added lines in their place.
 *
 * @param {string[]} source @param {PatchEdit[]} edits On distinct lines.
 * @returns {string[]}
 */
function applyEdits(source, edits) {
  const out = [...source];
  for (const { at, remove = 0, add = [] } of [...edits].sort((a, b) => b.at - a.at)) out.splice(at - 1, remove, ...add);
  return out;
}

// ── Spec & app sources ──────────────────────────────────────────────────────
// Every file the stories reference, as line arrays. These are the exact
// contents `demo-scm.ts` serves as "Source files", the snippets are cut from
// them, and the error stack frames/line numbers point into them.

const CHECKOUT_SPEC = [
  "import { test, expect } from '@playwright/test';",
  "import { fillPaymentDetails } from '../helpers/payment';",
  '',
  "test.describe('Checkout', () => {",
  '  test.beforeEach(async ({ page }) => {',
  "    await page.goto('/checkout');",
  '  });',
  '',
  "  test('should complete checkout with credit card', async ({ page }) => {",
  "    await page.getByLabel('Email address').fill('buyer@example.com');",
  '    await fillPaymentDetails(page);',
  "    await expect(page.getByText('Order confirmed')).toBeVisible();",
  '  });',
  '',
  "  test('should complete checkout with PayPal', async ({ page }) => {",
  "    await page.getByLabel('Email address').fill('buyer@example.com');",
  "    await page.getByRole('button', { name: 'Continue with PayPal' }).click();",
  '    await fillPaymentDetails(page);',
  "    await expect(page.getByText('Order confirmed')).toBeVisible();",
  '  });',
  '',
  "  test('should complete checkout with Apple Pay', async ({ page }) => {",
  "    await page.getByLabel('Email address').fill('buyer@example.com');",
  "    await page.getByRole('button', { name: 'Apple Pay' }).click();",
  "    await expect(page.getByText('Order confirmed')).toBeVisible();",
  '  });',
  '',
  "  test('should show error for expired card', async ({ page }) => {",
  "    await page.getByLabel('Email address').fill('buyer@example.com');",
  "    await page.getByLabel('Card number').fill('4000 0000 0000 0069');",
  "    await page.getByLabel('Expiry date').fill('01/20');",
  "    await page.getByRole('button', { name: 'Pay' }).click();",
  "    await expect(page.getByText('Your card has expired')).toBeVisible();",
  '  });',
  '',
  "  test('should show error for invalid CVV', async ({ page }) => {",
  "    await page.getByLabel('Card number').fill('4242 4242 4242 4242');",
  "    await page.getByLabel('CVV').fill('12');",
  "    await page.getByRole('button', { name: 'Pay' }).click();",
  "    await expect(page.getByText('Check your CVV')).toBeVisible();",
  '  });',
  '});',
];

const PAYMENT_HELPER = [
  "import type { Page } from '@playwright/test';",
  '',
  "export const TEST_CARD = '4242 4242 4242 4242';",
  '',
  '/**',
  ' * Fills the payment form and submits it.',
  ' *',
  ' * The Pay button stays disabled until the checkout price quote resolves,',
  ' * so the final click waits on the button becoming enabled.',
  ' */',
  'export async function fillPaymentDetails(page: Page) {',
  "  await page.getByLabel('Card number').fill(TEST_CARD);",
  "  await page.getByLabel('Expiry date').fill('12/30');",
  "  await page.getByLabel('CVV').fill('123');",
  '  // Pay stays disabled until the async price quote resolves',
  "  await page.getByRole('button', { name: 'Pay' }).click();",
  '}',
];

const CHECKOUT_FORM_VUE = [
  '<script setup lang="ts">',
  "import { ref, onMounted } from 'vue';",
  "import { loadPaymentProvider } from '~/lib/payment-provider';",
  '',
  'const ready = ref(false);',
  '',
  'onMounted(async () => {',
  '  // New payment provider SDK is fetched from a third-party CDN before the',
  '  // form becomes interactive. On a slow CI runner this can take several seconds.',
  '  await loadPaymentProvider();',
  '  ready.value = true;',
  '});',
  '</script>',
  '',
  '<template>',
  '  <form class="checkout-form" data-testid="checkout-form">',
  '    <PaymentFields />',
  '    <button type="submit" data-testid="checkout-pay" :disabled="!ready">Pay now</button>',
  '  </form>',
  '</template>',
];

const AUTH_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Auth', () => {",
  "  test('POST /auth/login returns 200 with valid credentials', async ({ request }) => {",
  "    const res = await request.post('/auth/login', {",
  "      data: { email: 'user@example.com', password: 'correct-horse-battery' },",
  '    });',
  '    expect(res.status()).toBe(200);',
  '  });',
  '',
  "  test('POST /auth/login returns 401 with invalid credentials', async ({ request }) => {",
  "    const res = await request.post('/auth/login', {",
  "      data: { email: 'user@example.com', password: 'wrong' },",
  '    });',
  '    expect(res.status()).toBe(401);',
  '  });',
  '',
  "  test('GET /auth/me returns current user', async ({ request }) => {",
  "    const login = await request.post('/auth/login', {",
  "      data: { email: 'user@example.com', password: 'correct-horse-battery' },",
  '    });',
  '    expect(login.status()).toBe(200);',
  "    const me = await request.get('/auth/me', {",
  '      headers: { Authorization: `Bearer ${(await login.json()).token}` },',
  '    });',
  '    expect(me.status()).toBe(200);',
  '  });',
  '});',
];

const AUTH_HANDLER = [
  "import { verifyCredentials } from '../services/credentials';",
  "import { signSession } from '../services/session';",
  '',
  'export async function loginHandler(req, res) {',
  '  const { email, password } = req.body;',
  '  // Refactor regression: verifyCredentials now returns null (not throws) on a',
  '  // missing user, and this path dereferences user.id without a guard → 500.',
  '  const user = await verifyCredentials(email, password);',
  '  const token = signSession(user.id);',
  '  return res.status(200).json({ token });',
  '}',
];

const ORDERS_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Orders', () => {",
  "  test('POST /orders creates order', async ({ request }) => {",
  "    const res = await request.post('/orders', { data: { items: [{ sku: 'SKU-100', qty: 2 }] } });",
  '    expect(res.status()).toBe(201);',
  '  });',
  '',
  "  test('GET /orders/:id returns order details', async ({ request }) => {",
  "    const res = await request.get('/orders/1001');",
  '    expect(res.status()).toBe(200);',
  '  });',
  '',
  "  test('PUT /orders/:id/status updates order status', async ({ request }) => {",
  "    const res = await request.put('/orders/1001/status', { data: { status: 'confirmed' } });",
  '    const body = await res.json();',
  "    expect(body.status).toContain('confirmed');",
  '  });',
  '});',
];

const ORDERS_SERVICE = [
  "import { db } from '../db';",
  '',
  'const TRANSITIONS = {',
  "  draft: ['payment_pending'],",
  "  payment_pending: ['confirmed', 'cancelled'],",
  "  confirmed: ['shipped'],",
  '};',
  '',
  'export async function updateOrderStatus(id, requested) {',
  '  const order = await db.orders.get(id);',
  '  // Regression: the payment webhook no longer advances payment_pending →',
  '  // confirmed before this runs, so the requested transition is rejected and',
  '  // the order is returned unchanged.',
  '  const allowed = TRANSITIONS[order.status] ?? [];',
  '  if (!allowed.includes(requested)) return order;',
  '  return db.orders.update(id, { status: requested });',
  '}',
];

const BUTTON_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Button', () => {",
  '  test.beforeEach(async ({ page }) => {',
  "    await page.goto('/components/button');",
  '  });',
  '',
  "  test('Button primary variant renders correctly', async ({ page }) => {",
  '    // The gallery renders every variant side by side',
  "    await page.getByRole('button').click();",
  "    await expect(page.locator('.btn-primary')).toHaveClass(/is-active/);",
  '  });',
  '',
  "  test('Button disabled state renders correctly', async ({ page }) => {",
  "    await expect(page.getByRole('button', { name: 'Disabled' })).toBeDisabled();",
  '  });',
  '',
  "  test('Button loading state renders correctly', async ({ page }) => {",
  "    await expect(page.getByRole('button', { name: 'Loading' })).toHaveAttribute('aria-busy', 'true');",
  '  });',
  '});',
];

const BUTTON_PAGE_VUE = [
  '<template>',
  '  <section class="button-gallery">',
  '    <AppButton variant="primary">Primary</AppButton>',
  '    <AppButton variant="secondary" disabled>Disabled</AppButton>',
  '    <AppButton variant="secondary" loading>Loading…</AppButton>',
  '  </section>',
  '</template>',
];

const MODAL_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Modal', () => {",
  "  test('Modal opens and closes correctly', async ({ page }) => {",
  "    await page.goto('/components/modal');",
  "    await page.getByRole('button', { name: 'Open modal' }).click();",
  "    await page.waitForSelector('.modal.is-open');",
  "    await page.getByRole('button', { name: 'Close' }).click();",
  "    await expect(page.locator('.modal')).toBeHidden();",
  '  });',
  '',
  "  test('Modal with large content scrolls correctly', async ({ page }) => {",
  "    await page.goto('/components/modal?content=long');",
  "    await page.getByRole('button', { name: 'Open modal' }).click();",
  "    await page.waitForSelector('.modal.is-open');",
  "    await page.locator('.modal-body').evaluate((el) => el.scrollTo(0, 9999));",
  "    await expect(page.locator('.modal-footer')).toBeInViewport();",
  '  });',
  '});',
];

const MODAL_CONTROLLER = [
  'export class ModalController {',
  '  constructor(root) {',
  '    this.root = root;',
  '    // Regression: `focusTrap` is created lazily on first open(), but the',
  "    // teleport refactor moved the trap's mount target out of `root`, so",
  '    // `this.trap` stays undefined and open() throws before adding the class.',
  '  }',
  '',
  '  open() {',
  '    this.trap.activate();',
  "    this.root.classList.add('is-open');",
  '  }',
  '}',
];

const MOBILE_NAV_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Navigation', () => {",
  "  test('Tab bar navigation works correctly', async ({ page }) => {",
  "    await page.goto('https://m.shop.example.com/');",
  "    await page.getByRole('tab', { name: 'Browse' }).click();",
  "    await expect(page.getByRole('heading', { name: 'Browse' })).toBeVisible();",
  '  });',
  '',
  "  test('Back gesture navigates correctly', async ({ page }) => {",
  "    await page.goto('https://m.shop.example.com/products/42');",
  '    await page.goBack();',
  '    await expect(page).toHaveURL(/\\/products$/);',
  '  });',
  '});',
];

const MOBILE_LANDING_VUE = [
  '<template>',
  '  <main>',
  '    <img',
  '      src="/hero-4k.png"',
  '      alt="Hero"',
  '      class="hero"',
  '    />',
  '    <Nav />',
  '    <ProductGrid />',
  '  </main>',
  '</template>',
];

const MOBILE_FORMS_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Forms', () => {",
  "  test('Text input shows keyboard on focus', async ({ page }) => {",
  "    await page.goto('https://m.shop.example.com/checkout');",
  "    await page.getByLabel('Delivery notes').fill('Leave at the door');",
  "    await expect(page.locator('.keyboard-spacer')).toBeVisible();",
  '  });',
  '',
  "  test('Date picker works correctly', async ({ page }) => {",
  "    await page.goto('https://m.shop.example.com/checkout');",
  "    await page.getByLabel('Delivery date').tap();",
  "    await expect(page.getByRole('dialog', { name: 'Choose date' })).toBeVisible();",
  '  });',
  '});',
];

const SIGNATURE_PAD = [
  'const DPR = window.devicePixelRatio || 1;',
  '',
  'export function mountSignaturePad(canvas) {',
  '  // Regression: the pad now allocates a full-resolution backing store for the',
  '  // whole page height. On a 3× mobile device this is a ~180 MB canvas — WebKit',
  '  // on iOS kills the page (Playwright sees the target closing mid-action).',
  '  canvas.width = window.innerWidth * DPR;',
  '  canvas.height = document.body.scrollHeight * DPR;',
  "  return canvas.getContext('2d');",
  '}',
];

const REPORTS_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Reports', () => {",
  "  test('renders the revenue chart', async ({ page }) => {",
  "    await page.goto('/reports/monthly');",
  "    await expect(page.getByRole('img', { name: 'Revenue chart' })).toBeVisible();",
  '  });',
  '',
  "  test('exports the monthly report as CSV', async ({ page }) => {",
  "    await page.goto('/reports/monthly');",
  "    const download = page.waitForEvent('download');",
  "    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();",
  "    await page.getByRole('button', { name: 'Export CSV' }).click();",
  "    expect((await download).suggestedFilename()).toBe('monthly-report.csv');",
  '  });',
  '});',
];

const THEME_CSS = [
  '.export-btn {',
  '  color: var(--text-primary);',
  '  background: var(--surface-raised);',
  '}',
  '',
  '@media (prefers-color-scheme: dark) {',
  '  .export-btn {',
  '    /* Regression: the dark-theme sweep set the raised surface to the page',
  '       background and hid "secondary" actions until hover — the Export button',
  '       is invisible (and unclickable) in dark mode. */',
  '    visibility: hidden;',
  '  }',
  '}',
];

const USERS_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Users', () => {",
  "  test('Users table paginates 25 rows per page', async ({ page }) => {",
  "    await page.goto('/users');",
  '    // Header row + 25 data rows',
  "    await expect(page.getByRole('row')).toHaveCount(26);",
  '  });',
  '',
  "  test('invites a user by email', async ({ page }) => {",
  "    await page.goto('/users');",
  "    await page.getByRole('button', { name: 'Invite user' }).click();",
  "    await page.getByLabel('Email address').fill('new.admin@example.com');",
  "    await page.getByRole('button', { name: 'Send invite' }).click();",
  "    await expect(page.getByText('Invite sent')).toBeVisible();",
  '  });',
  '',
  "  test('filters users by role', async ({ page }) => {",
  "    await page.goto('/users');",
  "    await page.getByRole('combobox', { name: 'Role' }).selectOption('admin');",
  "    await expect(page.getByRole('row', { name: /admin/i }).first()).toBeVisible();",
  '  });',
  '});',
];

/**
 * The users endpoints of the web dashboard's ASP.NET Core API (`api/`), which
 * the dashboard's origin routes `/api/users` to.
 */
const USERS_ENDPOINTS_PATH = 'api/Users/UsersEndpoints.cs';

/**
 * The users endpoints as they were before the server-driven pagination
 * commit: `ListUsers` returned every user in one page, and the table paginated
 * them itself.
 */
const USERS_ENDPOINTS_BEFORE_PAGINATION = [
  'using AdminDashboard.Api.Data;',
  'using Microsoft.AspNetCore.Http.HttpResults;',
  'using Microsoft.EntityFrameworkCore;',
  '',
  'namespace AdminDashboard.Api.Users;',
  '',
  'public sealed record UserRow(int Id, string Name, string Email, string Role);',
  '',
  'public sealed record UserPage(IReadOnlyList<UserRow> Rows, int Page, int PageSize, int Total);',
  '',
  'public sealed record UpdateUserRequest(string? Name, string? Role);',
  '',
  'public static class UsersEndpoints',
  '{',
  '    private static readonly string[] Roles = ["admin", "editor", "viewer"];',
  '',
  '    public static RouteGroupBuilder MapUsersEndpoints(this IEndpointRouteBuilder app)',
  '    {',
  '        var users = app.MapGroup("/api/users").RequireAuthorization("admin");',
  '        users.MapGet("", ListUsers);',
  '        users.MapPatch("/{id:int}", UpdateUser);',
  '        users.MapDelete("/{id:int}", DeactivateUser);',
  '        return users;',
  '    }',
  '',
  '    public static async Task<Ok<UserPage>> ListUsers(',
  '        AdminDb db,',
  '        string? role = null,',
  '        CancellationToken ct = default)',
  '    {',
  '        var query = db.Users.AsNoTracking().Where(u => u.DeactivatedAt == null);',
  '        if (role is not null)',
  '            query = query.Where(u => u.Role == role);',
  '',
  '        var ordered = query.OrderBy(u => u.Name).Select(u => new UserRow(u.Id, u.Name, u.Email, u.Role));',
  '        var rows = await ordered.ToListAsync(ct);',
  '        return TypedResults.Ok(new UserPage(rows, 1, rows.Count, rows.Count));',
  '    }',
  '',
  '    public static async Task<Results<Ok<UserRow>, NotFound, ValidationProblem>> UpdateUser(',
  '        int id,',
  '        UpdateUserRequest request,',
  '        AdminDb db,',
  '        CancellationToken ct = default)',
  '    {',
  '        if (request.Role is not null && !Roles.Contains(request.Role))',
  '            return TypedResults.ValidationProblem(new Dictionary<string, string[]>',
  '            {',
  '                ["role"] = [$"Role must be one of {string.Join(", ", Roles)}."],',
  '            });',
  '',
  '        var user = await db.Users.FindAsync([id], ct);',
  '        if (user is null || user.DeactivatedAt is not null)',
  '            return TypedResults.NotFound();',
  '',
  '        user.Name = request.Name?.Trim() ?? user.Name;',
  '        user.Role = request.Role ?? user.Role;',
  '        await db.SaveChangesAsync(ct);',
  '        return TypedResults.Ok(new UserRow(user.Id, user.Name, user.Email, user.Role));',
  '    }',
  '',
  '    public static async Task<Results<NoContent, NotFound>> DeactivateUser(',
  '        int id,',
  '        AdminDb db,',
  '        TimeProvider clock,',
  '        CancellationToken ct = default)',
  '    {',
  '        var user = await db.Users.FindAsync([id], ct);',
  '        if (user is null)',
  '            return TypedResults.NotFound();',
  '',
  '        user.DeactivatedAt ??= clock.GetUtcNow();',
  '        await db.SaveChangesAsync(ct);',
  '        return TypedResults.NoContent();',
  '    }',
  '}',
];

/**
 * The server-driven pagination commit: `ListUsers` takes the page and an
 * optional page size, and a request that names no page size gets the API's
 * default of 50 rows, where the table shows 25. Written with git's three lines
 * of context, as the host's patch shows it.
 *
 * @type {PatchEdit[]}
 */
const USERS_PAGINATION_EDITS = [
  {
    at: lineOf(USERS_ENDPOINTS_BEFORE_PAGINATION, 'private static readonly string[] Roles'),
    add: ['    private const int DefaultPageSize = 50;', ''],
    context: 3,
  },
  {
    at: lineOf(USERS_ENDPOINTS_BEFORE_PAGINATION, 'string? role = null,'),
    add: ['        int page = 1,', '        int? pageSize = null,'],
    context: 3,
  },
  {
    at: lineOf(USERS_ENDPOINTS_BEFORE_PAGINATION, 'var rows = await ordered.ToListAsync(ct);'),
    remove: 2,
    add: [
      '        var size = pageSize ?? DefaultPageSize;',
      '        var rows = await ordered.Skip((page - 1) * size).Take(size).ToListAsync(ct);',
      '        return TypedResults.Ok(new UserPage(rows, page, size, await query.CountAsync(ct)));',
    ],
    context: 3,
  },
];

/** The users endpoints at the head of the canned history, with the pagination commit applied. */
const USERS_ENDPOINTS = applyEdits(USERS_ENDPOINTS_BEFORE_PAGINATION, USERS_PAGINATION_EDITS);

/** The pagination commit's patch, as the host gives it: the hunks, without the file headers. */
const USERS_PAGINATION_PATCH = derivePatch(
  USERS_ENDPOINTS_PATH,
  USERS_ENDPOINTS_BEFORE_PAGINATION,
  USERS_PAGINATION_EDITS,
)
  .split('\n')
  .slice(2)
  .join('\n');

/**
 * The git blob id of the users endpoints at the head, as `git hash-object`
 * gives it for `sourceText`: the canned history names it on the file's change,
 * and the server coverage of the story's run names it on the file, so the two
 * refer to the same version. `demo-suspect-lines.test.ts` recomputes it.
 */
const USERS_ENDPOINTS_BLOB = '9eccc2710a72897ea23a202703c1c9068909bbb4';

/**
 * The server coverage one request to `GET /api/users` records of the users
 * endpoints: `ListUsers` as the function that ran, and the lines of its
 * statements, with the role filter's when the request names a role. The
 * compiler marks statements only, so the signature, the constant and the
 * blank lines never count as executed.
 *
 * @param {{ role?: boolean }} [request]
 * @returns {import('./failure-stories.d.mts').StoryServerCoverage}
 */
function listUsersCoverage({ role = false } = {}) {
  const line = (needle) => lineOf(USERS_ENDPOINTS, needle);
  const start = line('ListUsers(');
  const end = USERS_ENDPOINTS.indexOf('    }', start) + 1;
  const statements = [
    'var query = db.Users',
    'if (role is not null)',
    ...(role ? ['query = query.Where(u => u.Role == role);'] : []),
    'var ordered = query',
    'var size = pageSize',
    'var rows = await ordered',
    'return TypedResults.Ok(new UserPage',
  ];
  /** @type {Array<[number, number]>} */
  const lines = [];
  for (const n of statements.map(line).sort((a, b) => a - b)) {
    const last = lines.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else lines.push([n, n]);
  }
  return {
    path: USERS_ENDPOINTS_PATH,
    runtime: 'server',
    blob: USERS_ENDPOINTS_BLOB,
    functions: [[start, end]],
    lines,
  };
}

const LOGIN_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Login', () => {",
  "  test('signs in with SSO redirect', async ({ page }) => {",
  "    await page.goto('/login');",
  "    await page.getByRole('button', { name: 'Continue with SSO' }).click();",
  '    await expect(page).toHaveURL(/\\/dashboard$/);',
  '  });',
  '',
  "  test('shows an error for a revoked account', async ({ page }) => {",
  "    await page.goto('/login?sso=revoked');",
  "    await expect(page.getByText('Your account has been deactivated')).toBeVisible();",
  '  });',
  '});',
];

const SETTINGS_SPEC = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test.describe('Settings', () => {",
  "  test('updates the organization name', async ({ page }) => {",
  "    await page.goto('/settings/organization');",
  "    await page.getByLabel('Organization name').fill('Acme Corp');",
  "    await page.getByRole('button', { name: 'Save' }).click();",
  "    await expect(page.getByText('Settings saved')).toBeVisible();",
  '  });',
  '',
  "  test('rotates the API token', async ({ page }) => {",
  "    await page.goto('/settings/api');",
  "    await page.getByRole('button', { name: 'Rotate token' }).click();",
  "    await page.getByTestId('confirm-rotate').click();",
  "    await expect(page.getByText('New token generated')).toBeVisible();",
  '  });',
  '',
  "  test('toggles dark mode', async ({ page }) => {",
  "    await page.goto('/settings/organization');",
  "    await page.getByRole('link', { name: 'Appearance' }).click();",
  "    await page.getByRole('switch', { name: 'Dark mode' }).click();",
  "    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');",
  '  });',
  '});',
];

/** Every authored source file, keyed by repo-relative path. */
export const SOURCE_FILES = {
  'tests/checkout/checkout.spec.ts': CHECKOUT_SPEC,
  'tests/helpers/payment.ts': PAYMENT_HELPER,
  'src/components/CheckoutForm.vue': CHECKOUT_FORM_VUE,
  'tests/api/auth.spec.ts': AUTH_SPEC,
  'src/routes/auth.ts': AUTH_HANDLER,
  'tests/api/orders.spec.ts': ORDERS_SPEC,
  'src/services/orders.ts': ORDERS_SERVICE,
  'tests/ui/button.spec.ts': BUTTON_SPEC,
  'src/pages/components/button.vue': BUTTON_PAGE_VUE,
  'tests/ui/modal.spec.ts': MODAL_SPEC,
  'src/components/modal-controller.ts': MODAL_CONTROLLER,
  'tests/mobile/navigation.spec.ts': MOBILE_NAV_SPEC,
  'src/pages/index.vue': MOBILE_LANDING_VUE,
  'tests/mobile/forms.spec.ts': MOBILE_FORMS_SPEC,
  'src/lib/signature-pad.ts': SIGNATURE_PAD,
  'tests/admin/reports.spec.ts': REPORTS_SPEC,
  'src/styles/theme.css': THEME_CSS,
  'tests/admin/users.spec.ts': USERS_SPEC,
  [USERS_ENDPOINTS_PATH]: USERS_ENDPOINTS,
  'tests/admin/login.spec.ts': LOGIN_SPEC,
  'tests/admin/settings.spec.ts': SETTINGS_SPEC,
};

/** Full file content (string) for a path in SOURCE_FILES. */
export function sourceText(path) {
  const lines = SOURCE_FILES[path];
  if (!lines) throw new Error(`sourceText: unknown source file ${path}`);
  return lines.join('\n') + '\n';
}

// ── Authored failure-time DOM snapshots ─────────────────────────────────────
// Full-page DOM snapshots for the locator-centric stories, served by the demo
// dom-snapshot mirror as if they had been extracted from the case's trace ZIP
// (source 'dom', with a viewport for the picker's proportional zoom). The
// committed trace ZIPs are genuine recordings but of deliberately tiny fixture
// pages — too bare for the locator picker to feel real — so each story that
// showcases healing carries an authored page that matches its ARIA snapshot,
// its captured element attributes, and its seeded alternative locators.
// Coherence is enforced by tests/unit/demo-seed-consistency.test.ts (every
// named ARIA candidate must appear in the page).

/** Shared viewport for authored snapshots — the picker scales to fit. */
const DOM_SNAPSHOT_VIEWPORT = { width: 1280, height: 720 };

/** Cluster 1 — checkout page mid-payment: quote pending, Pay disabled. */
const CHECKOUT_PAY_DOM = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Checkout — Shop</title><style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1f2430; background: #f6f7f9; }
  header { background: #101828; color: #fff; padding: 14px 32px; font-weight: 600; }
  .layout { display: grid; grid-template-columns: 1fr 320px; gap: 24px; max-width: 980px; margin: 32px auto; }
  form { background: #fff; border: 1px solid #e4e7ec; border-radius: 10px; padding: 24px; }
  label { display: block; font-weight: 600; margin: 14px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #cfd4dc; border-radius: 6px; font: inherit; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  button { margin-top: 20px; width: 100%; padding: 11px; border: 0; border-radius: 6px; background: #4353ff; color: #fff; font: inherit; font-weight: 600; }
  button[disabled] { background: #b6bcf5; }
  .quote { margin-top: 10px; color: #98652b; background: #fdf3e3; border: 1px solid #f5dcae; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
  aside { background: #fff; border: 1px solid #e4e7ec; border-radius: 10px; padding: 20px; height: fit-content; }
  aside h2 { margin: 0 0 12px; font-size: 16px; }
  .line { display: flex; justify-content: space-between; padding: 4px 0; }
  .total { font-weight: 700; border-top: 1px solid #e4e7ec; margin-top: 8px; padding-top: 10px; }
</style></head><body>
<header>Shop — Secure checkout</header>
<div class="layout">
  <form id="checkout" data-testid="checkout-form" aria-label="Checkout">
    <label for="checkout-email">Email address</label>
    <input id="checkout-email" data-testid="email-input" type="email" name="email" placeholder="your@email.com" autocomplete="email" />
    <label for="card-number">Card number</label>
    <input id="card-number" data-testid="card-number" name="cardNumber" placeholder="4242 4242 4242 4242" inputmode="numeric" />
    <div class="row">
      <div>
        <label for="card-expiry">Expiry date</label>
        <input id="card-expiry" data-testid="card-expiry" name="cardExpiry" placeholder="MM / YY" />
      </div>
      <div>
        <label for="card-cvv">CVV</label>
        <input id="card-cvv" data-testid="card-cvv" name="cardCvv" placeholder="123" />
      </div>
    </div>
    <button type="submit" id="checkout-pay" data-testid="checkout-pay" disabled>Pay now</button>
    <p class="quote">Waiting for the final price quote — payment unlocks once it arrives.</p>
  </form>
  <aside>
    <h2>Order summary</h2>
    <div class="line"><span>Wireless keyboard</span><span>$ 89.00</span></div>
    <div class="line"><span>USB-C hub</span><span>$ 39.00</span></div>
    <div class="line"><span>Shipping</span><span>$ 6.50</span></div>
    <div class="line total"><span>Total</span><span>$ 134.50</span></div>
  </aside>
</div>
</body></html>`;

/** Cluster 2 — the restructured contact step: email input replaced by a contact-method combobox. */
const CHECKOUT_CONTACT_DOM = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Checkout — Shop</title><style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1f2430; background: #f6f7f9; }
  header { background: #101828; color: #fff; padding: 14px 32px; font-weight: 600; }
  form { background: #fff; border: 1px solid #e4e7ec; border-radius: 10px; padding: 24px; max-width: 620px; margin: 32px auto; }
  label { display: block; font-weight: 600; margin: 14px 0 4px; }
  input, select { width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid #cfd4dc; border-radius: 6px; font: inherit; background: #fff; }
  .field { padding: 2px 0; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  button { margin-top: 20px; width: 100%; padding: 11px; border: 0; border-radius: 6px; background: #4353ff; color: #fff; font: inherit; font-weight: 600; }
</style></head><body>
<header>Shop — Secure checkout</header>
<form id="checkout" data-testid="checkout-form" aria-label="Checkout">
  <div class="field" data-testid="email-field">
    <label for="contact-method">Contact method</label>
    <select id="contact-method" name="contactMethod">
      <option>Email</option>
      <option>Phone</option>
      <option>SMS</option>
    </select>
  </div>
  <label for="card-number">Card number</label>
  <input id="card-number" data-testid="card-number" name="cardNumber" placeholder="4242 4242 4242 4242" inputmode="numeric" />
  <div class="row">
    <div>
      <label for="card-expiry">Expiry date</label>
      <input id="card-expiry" data-testid="card-expiry" name="cardExpiry" placeholder="MM / YY" />
    </div>
    <div>
      <label for="card-cvv">CVV</label>
      <input id="card-cvv" data-testid="card-cvv" name="cardCvv" placeholder="123" />
    </div>
  </div>
  <button type="submit" id="checkout-pay" data-testid="checkout-pay">Pay now</button>
</form>
</body></html>`;

/** Cluster 6 — the button gallery whose variants all match getByRole('button'). */
const BUTTON_GALLERY_DOM = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Components / Button</title><style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #23262f; background: #fff; }
  header { border-bottom: 1px solid #e6e8ec; padding: 16px 32px; }
  h1 { font-size: 18px; margin: 0; }
  section { padding: 32px; display: flex; gap: 16px; align-items: center; }
  .btn { padding: 10px 18px; border-radius: 8px; border: 1px solid transparent; font: inherit; font-weight: 600; }
  .btn-primary { background: #4353ff; color: #fff; }
  .btn[disabled] { background: #eceef2; color: #9aa0ab; }
  .btn-loading { background: #4353ff66; color: #fff; }
</style></head><body>
<header><h1>Components / Button</h1></header>
<section>
  <button class="btn btn-primary" data-testid="primary-btn">Primary</button>
  <button class="btn" disabled>Disabled</button>
  <button class="btn btn-loading">Loading…</button>
</section>
</body></html>`;

/** Cluster 9 — the admin reports page in dark mode; Export CSV is in the DOM but hidden. */
const REPORTS_DARK_DOM = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Monthly report — Admin</title><style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; background: #0f1115; color: #e6e8ee; }
  nav { background: #161a22; padding: 24px 0; }
  nav a { display: block; padding: 10px 24px; color: #aab2c0; text-decoration: none; }
  nav a[aria-current] { color: #fff; background: #232a36; }
  main { padding: 28px 36px; }
  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0 auto 0 0; }
  button { padding: 8px 14px; border-radius: 6px; border: 1px solid #2c3442; background: #1b212c; color: #e6e8ee; font: inherit; }
  .export-btn { background: #2f6feb; border-color: #2f6feb; color: #fff; visibility: hidden; }
  img { width: 100%; max-width: 720px; border-radius: 8px; background: #161a22; }
  table { border-collapse: collapse; margin-top: 24px; min-width: 420px; }
  caption { text-align: left; font-weight: 600; padding-bottom: 8px; }
  th, td { border-bottom: 1px solid #232a36; padding: 8px 14px; text-align: left; }
</style></head><body>
<nav aria-label="Admin">
  <a href="/dashboard">Dashboard</a>
  <a href="/reports/monthly" aria-current="page">Reports</a>
  <a href="/users">Users</a>
</nav>
<main>
  <div class="toolbar">
    <h1>Monthly report</h1>
    <button type="button">Toggle theme</button>
    <button type="button">Refresh data</button>
    <button type="button" class="export-btn" hidden>Export CSV</button>
  </div>
  <img alt="Revenue chart" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='720' height='240'%3E%3Crect width='720' height='240' fill='%23161a22'/%3E%3Cpolyline points='20,200 140,150 260,170 380,110 500,120 620,60 700,80' fill='none' stroke='%232f6feb' stroke-width='4'/%3E%3C/svg%3E" />
  <table>
    <caption>Totals</caption>
    <thead><tr><th>Month</th><th>Revenue</th></tr></thead>
    <tbody>
      <tr><td>June</td><td>$ 48,120</td></tr>
      <tr><td>May</td><td>$ 44,930</td></tr>
    </tbody>
  </table>
</main>
</body></html>`;

// ── Failure stories ─────────────────────────────────────────────────────────

const checkoutPayLocator = "getByRole('button', { name: 'Pay' })";
const payClickLine = lineOf(PAYMENT_HELPER, ".getByRole('button', { name: 'Pay' }).click()");

const PAY_CALL_LOG = [
  `waiting for ${checkoutPayLocator}`,
  'locator resolved to <button disabled type="submit" data-testid="checkout-pay">Pay now</button>',
  'attempting click action',
  'waiting for element to be visible, enabled and stable',
  'element is not enabled',
  'retrying click action',
  'waiting 20ms',
  'waiting for element to be visible, enabled and stable',
  'element is not enabled',
  'retrying click action',
  'waiting 100ms',
];

/**
 * @typedef {{ file: string, line: number, column: number, fn?: string }} StoryFrame
 * @typedef {{ title: string, category: string, subtitle?: string, params?: Record<string, string>, location?: string, duration?: number, hook?: 'beforeEach' }} StoryStep
 * @typedef {StoryStep & { timeoutMs: number | null, timeout: 'test' | 'action' | 'expect' | null, location: string }} FailingCall
 * @typedef {{ title: string, failingLine: number, column: number, frames: StoryFrame[], error: string, call: FailingCall, before?: StoryStep[] }} FailingCase
 */

// ── The failing call, as the step Playwright reports for it ──
// `timeout` names whose timeout the error reports: the test's, the action's or
// the expect's; null when the call failed without one.

const testTimeout = (ms) => ({ timeoutMs: ms, timeout: 'test' });
const actionTimeout = (ms) => ({ timeoutMs: ms, timeout: 'action' });
const expectTimeout = (ms) => ({ timeoutMs: ms, timeout: 'expect' });
const noTimeout = { timeoutMs: null, timeout: null };

const clickCall = (locator, timeout = noTimeout) => ({
  title: 'Click',
  category: 'action',
  subtitle: locator,
  params: { locator },
  ...timeout,
});
const fillCall = (locator, value, timeout = noTimeout) => ({
  title: `Fill "${value}"`,
  category: 'input',
  subtitle: locator,
  params: { locator, value },
  ...timeout,
});
const waitForSelectorCall = (locator, timeout = noTimeout) => ({
  title: 'Wait for selector',
  category: 'wait',
  subtitle: locator,
  params: { locator },
  ...timeout,
});
const navigateCall = (url, absoluteUrl, timeout = noTimeout) => ({
  title: 'Navigate',
  category: 'navigation',
  subtitle: url,
  params: { url: absoluteUrl },
  ...timeout,
});
const expectCall = (matcher, locator, timeout = noTimeout) => ({
  title: `Expect "${matcher}"`,
  category: 'assertion',
  ...(locator ? { subtitle: locator, params: { locator } } : {}),
  ...timeout,
});

/**
 * Build a failing case entry: frames innermost-first; the error carries them.
 * `call` is the failing call's step, located at the innermost frame; `before`,
 * when given, lists the steps the test ran before it, in order.
 */
function failingCase(title, specFile, failingLine, column, buildErr, extraInnerFrames, { call, before } = {}) {
  const frames = [...(extraInnerFrames ?? []), { file: specFile, line: failingLine, column }];
  const inner = frames[0];
  return {
    title,
    failingLine,
    column,
    frames,
    error: buildErr(frames),
    call: { ...call, location: `${inner.file}:${inner.line}:${inner.column}` },
    ...(before ? { before } : {}),
  };
}

/** `file:line:col` of a call in an authored source: the line holding `needle`, the column of `method(`. */
function callSite(file, needle, method, nth = 0) {
  const line = lineOf(SOURCE_FILES[file], needle, nth);
  return `${file}:${line}:${SOURCE_FILES[file][line - 1].indexOf(`${method}(`) + 1}`;
}

/**
 * The steps a checkout test runs before the helper's Pay click, as Playwright
 * reports them: the beforeEach navigation, the email of the `nth` test that
 * fills it, `extra` steps of the test itself, then the helper's card fields.
 * Durations are typical for a CI runner, in ms.
 *
 * @param {number} nth @param {StoryStep[]} [extra]
 * @returns {StoryStep[]}
 */
function checkoutStepsBefore(nth, extra = []) {
  const spec = 'tests/checkout/checkout.spec.ts';
  const helper = 'tests/helpers/payment.ts';
  const field = (label, value, needle, file, duration, n = 0) => ({
    ...fillCall(`getByLabel('${label}')`, value),
    location: callSite(file, needle, 'fill', n),
    duration,
  });
  return [
    {
      ...navigateCall('/checkout', 'https://shop.example.com/checkout'),
      location: callSite(spec, "await page.goto('/checkout');", 'goto'),
      duration: 900,
      hook: 'beforeEach',
    },
    field(
      'Email address',
      'buyer@example.com',
      "await page.getByLabel('Email address').fill('buyer@example.com');",
      spec,
      420,
      nth,
    ),
    ...extra,
    field('Card number', '4242 4242 4242 4242', "await page.getByLabel('Card number').fill(TEST_CARD);", helper, 380),
    field('Expiry date', '12/30', "await page.getByLabel('Expiry date').fill('12/30');", helper, 260),
    field('CVV', '123', "await page.getByLabel('CVV').fill('123');", helper, 240),
  ];
}

export const FAILURE_STORIES = [
  {
    key: 'checkout-pay-timeout',
    clusterId: 1,
    projectId: 1,
    specFile: 'tests/checkout/checkout.spec.ts',
    locator: checkoutPayLocator,
    /** The locator call site healing snapshots are keyed on (innermost frame). */
    captureLocation: `tests/helpers/payment.ts:${payClickLine}:51`,
    failingCases: [
      failingCase(
        'should complete checkout with credit card',
        'tests/checkout/checkout.spec.ts',
        lineOf(CHECKOUT_SPEC, 'await fillPaymentDetails(page);', 0),
        9,
        (frames) => buildTestTimeoutError({ timeoutMs: 30000, action: 'locator.click', callLog: PAY_CALL_LOG, frames }),
        [{ file: 'tests/helpers/payment.ts', line: payClickLine, column: 51, fn: 'fillPaymentDetails' }],
        { call: clickCall(checkoutPayLocator, testTimeout(30000)), before: checkoutStepsBefore(0) },
      ),
      failingCase(
        'should complete checkout with PayPal',
        'tests/checkout/checkout.spec.ts',
        lineOf(CHECKOUT_SPEC, 'await fillPaymentDetails(page);', 1),
        9,
        (frames) => buildTestTimeoutError({ timeoutMs: 30000, action: 'locator.click', callLog: PAY_CALL_LOG, frames }),
        [{ file: 'tests/helpers/payment.ts', line: payClickLine, column: 51, fn: 'fillPaymentDetails' }],
        {
          call: clickCall(checkoutPayLocator, testTimeout(30000)),
          before: checkoutStepsBefore(1, [
            {
              ...clickCall("getByRole('button', { name: 'Continue with PayPal' })"),
              location: callSite(
                'tests/checkout/checkout.spec.ts',
                "getByRole('button', { name: 'Continue with PayPal' }).click()",
                'click',
              ),
              duration: 650,
            },
          ]),
        },
      ),
    ],
    aria:
      '- document:\n  - form "Checkout":\n    - textbox "Email address"\n    - textbox "Card number"\n' +
      '    - textbox "Expiry date"\n    - textbox "CVV"\n    - button "Pay now" [disabled]',
    // The page as it last passed: the pay button was named "Pay" and enabled.
    // Diffed against the failure it reads as a renamed, now-disabled button —
    // exactly why the `name: 'Pay'` locator stopped matching.
    baselineAria:
      '- document:\n  - form "Checkout":\n    - textbox "Email address"\n    - textbox "Card number"\n' +
      '    - textbox "Expiry date"\n    - textbox "CVV"\n    - button "Pay"',
    domSnapshot: { viewport: DOM_SNAPSHOT_VIEWPORT, html: CHECKOUT_PAY_DOM },
    evidence: {
      consoleOnFail: [
        {
          type: 'warning',
          text: '[checkout] price quote still pending after 20s — Pay stays disabled',
          location: 'https://shop.example.com/assets/checkout-D4kXqz.js:1:48211',
          // The page's own timer, 20 s into the quote request.
          intoSlowRequestMs: 20040,
        },
      ],
      // The quote starts once the card fields are filled and is still in
      // flight when the test timeout stops the Pay click.
      failingNetwork: [
        {
          method: 'POST',
          url: 'https://shop.example.com/api/checkout/quote',
          status: 200,
          duration: 28400,
          resourceType: 'fetch',
        },
      ],
      // The payment authorization the Pay click sends never goes out.
      unreachedNetwork: [{ method: 'POST', url: 'https://shop.example.com/api/payments/authorize' }],
      // A confirm dialog left open at the failure moment blocks the page until
      // it is dismissed, so the Pay action never resolves.
      dialogOnFail: {
        type: 'confirm',
        message: 'Your session is about to expire. Stay signed in?',
      },
      pageStateDropKeys: ['quote'],
      // The CVV the helper typed last still holds focus, caret after its three
      // digits, when the test timeout stops the Pay click.
      pageInteraction: {
        focus: {
          element: { path: 'html:1/body:1/div:1/form:1/div:1/div:2/input:1', label: 'input#card-cvv' },
          visible: true,
          selection: [3, 3],
        },
      },
    },
    appFiles: ['tests/helpers/payment.ts', 'src/components/CheckoutForm.vue'],
    suspectSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
    diagnosis: {
      seeded: true,
      kind: 'timeout-interaction',
      area: 'checkout / payment',
      fix: {
        description:
          'Wait for the price quote the Pay button depends on, and give the flow the time the quote takes on CI.',
        file: 'tests/helpers/payment.ts',
        patch: derivePatch('tests/helpers/payment.ts', PAYMENT_HELPER, [
          {
            at: lineOf(PAYMENT_HELPER, "import type { Page } from '@playwright/test';"),
            remove: 1,
            add: ["import { test, type Page } from '@playwright/test';"],
            context: 3,
          },
          {
            at: lineOf(PAYMENT_HELPER, "await page.getByLabel('Card number').fill(TEST_CARD);"),
            add: ['  test.slow();', "  const quoteResponse = page.waitForResponse('**/api/checkout/quote');"],
            context: 3,
          },
          { at: payClickLine, add: ['  await quoteResponse;'], context: 3 },
        ]),
      },
    },
    media: {
      screenshot: 'checkout-error-banner.png',
      trace: 'checkout-pay-timeout.zip',
      video: 'checkout-pay-timeout.webm',
      visualDiffBaseline: 'checkout-order-confirmed.png',
    },
    firing: { startAgo: 5, chance: 0.75 },
  },

  {
    key: 'checkout-email-renamed',
    clusterId: 2,
    projectId: 1,
    specFile: 'tests/checkout/checkout.spec.ts',
    locator: "getByLabel('Email address')",
    captureLocation: `tests/checkout/checkout.spec.ts:${lineOf(CHECKOUT_SPEC, "await page.getByLabel('Email address').fill('buyer@example.com');", 2)}:10`,
    failingCases: [
      failingCase(
        'should complete checkout with Apple Pay',
        'tests/checkout/checkout.spec.ts',
        lineOf(CHECKOUT_SPEC, "await page.getByLabel('Email address').fill('buyer@example.com');", 2),
        10,
        (frames) =>
          buildActionTimeoutError({
            action: 'locator.fill',
            timeoutMs: 10000,
            callLog: [`waiting for getByLabel('Email address')`],
            frames,
          }),
        [],
        {
          call: fillCall("getByLabel('Email address')", 'buyer@example.com', actionTimeout(10000)),
          before: [
            {
              ...navigateCall('/checkout', 'https://shop.example.com/checkout'),
              location: callSite('tests/checkout/checkout.spec.ts', "await page.goto('/checkout');", 'goto'),
              duration: 900,
              hook: 'beforeEach',
            },
          ],
        },
      ),
    ],
    aria:
      '- document:\n  - form "Checkout":\n    - combobox "Contact method"\n    - textbox "Card number"\n' +
      '    - textbox "Expiry date"\n    - textbox "CVV"\n    - button "Pay now"',
    domSnapshot: { viewport: DOM_SNAPSHOT_VIEWPORT, html: CHECKOUT_CONTACT_DOM },
    evidence: {},
    appFiles: [],
    suspectSha: 'ee12ab34cd56ef7890a1b2c3d4e5f60718293a4c',
    diagnosis: {
      seeded: false,
      kind: 'stale-locator',
      area: 'checkout / contact details',
      fix: {
        description: 'Anchor the field to its stable per-field wrapper instead of the renamed label.',
        file: 'tests/checkout/checkout.spec.ts',
        patch: derivePatch('tests/checkout/checkout.spec.ts', CHECKOUT_SPEC, {
          at: lineOf(CHECKOUT_SPEC, "await page.getByLabel('Email address').fill('buyer@example.com');", 2),
          remove: 1,
          add: ["    await page.getByTestId('email-field').getByRole('textbox').fill('buyer@example.com');"],
        }),
      },
    },
    media: { screenshot: 'checkout-contact-restructured.png', trace: 'email-label-renamed.zip' },
    firing: { startAgo: 2, chance: 0.9 },
  },

  {
    key: 'auth-login-500',
    clusterId: 3,
    projectId: 2,
    specFile: 'tests/api/auth.spec.ts',
    locator: null,
    failingCases: [
      failingCase(
        'POST /auth/login returns 200 with valid credentials',
        'tests/api/auth.spec.ts',
        lineOf(AUTH_SPEC, 'expect(res.status()).toBe(200);'),
        26,
        (frames) =>
          buildValueAssertionError({
            matcherLine: 'expect(received).toBe(expected) // Object.is equality',
            body: ['Expected: 200', 'Received: 500'],
            frames,
          }),
        [],
        { call: expectCall('toBe') },
      ),
      failingCase(
        'GET /auth/me returns current user',
        'tests/api/auth.spec.ts',
        lineOf(AUTH_SPEC, 'expect(login.status()).toBe(200);'),
        28,
        (frames) =>
          buildValueAssertionError({
            matcherLine: 'expect(received).toBe(expected) // Object.is equality',
            body: ['Expected: 200', 'Received: 500'],
            frames,
          }),
        [],
        { call: expectCall('toBe') },
      ),
    ],
    aria: null,
    evidence: {
      failingNetwork: [
        {
          method: 'POST',
          url: 'https://api.shop.example.com/auth/login',
          status: 500,
          duration: 210,
          resourceType: 'fetch',
          serverLogs: [
            {
              timestamp: 1745568000000,
              level: 'error',
              category: 'http',
              message: 'POST /auth/login — 500 Internal Server Error',
              stack:
                "TypeError: Cannot read properties of null (reading 'id')\n    at loginHandler (src/routes/auth.ts:9:29)\n    at Layer.handle (node_modules/express/lib/router/layer.js:95:5)",
            },
            {
              timestamp: 1745568000010,
              level: 'warn',
              category: 'auth',
              message: 'verifyCredentials returned null for user@example.com',
            },
          ],
        },
      ],
    },
    appFiles: ['src/routes/auth.ts'],
    suspectSha: 'f1e2d3c4b5a6079887766554433221100ffeeddc',
    diagnosis: {
      seeded: true,
      kind: 'http-500',
      area: 'authentication / login',
      fix: {
        description:
          'Restore the missing-user guard the refactor dropped, so the handler returns 401 instead of dereferencing null.',
        file: 'src/routes/auth.ts',
        patch: derivePatch('src/routes/auth.ts', AUTH_HANDLER, {
          at: lineOf(AUTH_HANDLER, 'const token = signSession(user.id);'),
          add: ['  if (!user) {', "    return res.status(401).json({ error: 'Invalid credentials' });", '  }'],
        }),
      },
    },
    media: {},
    firing: { startAgo: 4, chance: 0.8 },
  },

  {
    key: 'orders-status-transition',
    clusterId: 4,
    projectId: 2,
    specFile: 'tests/api/orders.spec.ts',
    locator: null,
    failingCases: [
      failingCase(
        'PUT /orders/:id/status updates order status',
        'tests/api/orders.spec.ts',
        lineOf(ORDERS_SPEC, "expect(body.status).toContain('confirmed');"),
        25,
        (frames) =>
          buildValueAssertionError({
            matcherLine: 'expect(received).toContain(expected) // indexOf',
            body: ['Expected substring: "confirmed"', 'Received string:    "payment_pending"'],
            frames,
          }),
        [],
        { call: expectCall('toContain') },
      ),
    ],
    aria: null,
    evidence: {
      failingNetwork: [
        {
          method: 'PUT',
          url: 'https://api.shop.example.com/orders/1001/status',
          status: 200,
          duration: 96,
          resourceType: 'fetch',
        },
      ],
    },
    appFiles: ['src/services/orders.ts'],
    suspectSha: '2837465564738291a0b1c2d3e4f5060718293a4b',
    diagnosis: {
      seeded: false,
      kind: 'assertion-mismatch',
      area: 'orders / status transitions',
      fix: {
        description: 'Allow the payment_pending → confirmed transition again when the payment is already captured.',
        file: 'src/services/orders.ts',
        patch: derivePatch('src/services/orders.ts', ORDERS_SERVICE, {
          at: lineOf(ORDERS_SERVICE, 'if (!allowed.includes(requested)) return order;'),
          remove: 1,
          add: ['  if (!allowed.includes(requested)) throw new ConflictError(`${order.status} → ${requested}`);'],
        }),
      },
    },
    media: {},
    firing: { startAgo: 1, chance: 1 },
  },

  {
    key: 'modal-never-opens',
    clusterId: 5,
    projectId: 3,
    specFile: 'tests/ui/modal.spec.ts',
    locator: "locator('.modal.is-open')",
    failingCases: [
      failingCase(
        'Modal opens and closes correctly',
        'tests/ui/modal.spec.ts',
        lineOf(MODAL_SPEC, "await page.waitForSelector('.modal.is-open');", 0),
        16,
        (frames) =>
          buildActionTimeoutError({
            action: 'page.waitForSelector',
            timeoutMs: 5000,
            callLog: ["waiting for locator('.modal.is-open') to be visible"],
            frames,
          }),
        [],
        { call: waitForSelectorCall("locator('.modal.is-open')", actionTimeout(5000)) },
      ),
      failingCase(
        'Modal with large content scrolls correctly',
        'tests/ui/modal.spec.ts',
        lineOf(MODAL_SPEC, "await page.waitForSelector('.modal.is-open');", 1),
        16,
        (frames) =>
          buildActionTimeoutError({
            action: 'page.waitForSelector',
            timeoutMs: 5000,
            callLog: ["waiting for locator('.modal.is-open') to be visible"],
            frames,
          }),
        [],
        { call: waitForSelectorCall("locator('.modal.is-open')", actionTimeout(5000)) },
      ),
    ],
    aria: '- document:\n  - main:\n    - heading "Modal"\n    - button "Open modal"',
    evidence: {
      consoleOnFail: [
        {
          type: 'error',
          text: "Uncaught TypeError: Cannot read properties of undefined (reading 'activate')\n    at ModalController.open (https://design.example.com/assets/modal-C7hQx2.js:2:1381)",
          location: 'https://design.example.com/assets/modal-C7hQx2.js:2:1381',
        },
      ],
    },
    appFiles: ['src/components/modal-controller.ts'],
    suspectSha: '5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f',
    diagnosis: {
      seeded: false,
      kind: 'js-error',
      area: 'UI components / modal',
      fix: {
        description:
          'Create the focus trap before activating it, so open() no longer throws on the teleported mount target.',
        file: 'src/components/modal-controller.ts',
        patch: derivePatch('src/components/modal-controller.ts', MODAL_CONTROLLER, {
          at: lineOf(MODAL_CONTROLLER, 'this.trap.activate();'),
          remove: 1,
          add: ['    this.trap ??= createFocusTrap(this.root);', '    this.trap.activate();'],
        }),
      },
    },
    media: { screenshot: 'components-modal-stuck.png' },
    firing: { startAgo: 6, chance: 0.6 },
    // The browser coverage of the newest run the cluster fails in: the modal
    // tests run the modal controller, the button tests the button page. Of the
    // two files changed since the oldest commit, the failing tests reached only
    // the controller, so it is the cluster's one suspect.
    coverage: {
      'tests/ui/modal.spec.ts': ['src/components/modal-controller.ts'],
      'tests/ui/button.spec.ts': ['src/pages/components/button.vue'],
    },
  },

  {
    key: 'button-strict-mode',
    clusterId: 6,
    projectId: 3,
    specFile: 'tests/ui/button.spec.ts',
    locator: "getByRole('button')",
    captureLocation: `tests/ui/button.spec.ts:${lineOf(BUTTON_SPEC, "await page.getByRole('button').click();")}:16`,
    failingCases: [
      failingCase(
        'Button primary variant renders correctly',
        'tests/ui/button.spec.ts',
        lineOf(BUTTON_SPEC, "await page.getByRole('button').click();"),
        37,
        (frames) =>
          buildStrictModeError({
            action: 'locator.click',
            selector: "getByRole('button')",
            elements: [
              `<button class="btn btn-primary">Primary</button> aka getByRole('button', { name: 'Primary' })`,
              `<button disabled class="btn btn-secondary">Disabled</button> aka getByRole('button', { name: 'Disabled' })`,
              `<button class="btn btn-secondary" aria-busy="true">Loading…</button> aka getByRole('button', { name: 'Loading…' })`,
            ],
            callLog: ["waiting for getByRole('button')"],
            frames,
          }),
        [],
        { call: clickCall("getByRole('button')") },
      ),
    ],
    aria: '- document:\n  - section:\n    - button "Primary"\n    - button "Disabled" [disabled]\n    - button "Loading…"',
    domSnapshot: { viewport: DOM_SNAPSHOT_VIEWPORT, html: BUTTON_GALLERY_DOM },
    evidence: {},
    appFiles: ['src/pages/components/button.vue'],
    suspectSha: '3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d',
    diagnosis: {
      seeded: true,
      kind: 'strict-mode',
      area: 'UI components / button',
      fix: {
        description: 'Scope the locator to a specific variant with a name filter so it matches exactly one button.',
        file: 'tests/ui/button.spec.ts',
        patch: derivePatch('tests/ui/button.spec.ts', BUTTON_SPEC, {
          at: lineOf(BUTTON_SPEC, "await page.getByRole('button').click();"),
          remove: 1,
          add: ["    await page.getByRole('button', { name: 'Primary' }).click();"],
        }),
      },
    },
    media: {
      screenshot: 'button-gallery-strict.png',
      trace: 'button-strict-mode.zip',
      video: 'button-strict-mode.webm',
    },
    firing: { startAgo: 8, chance: 0.5 },
  },

  {
    key: 'mobile-goto-timeout',
    clusterId: 7,
    projectId: 4,
    specFile: 'tests/mobile/navigation.spec.ts',
    locator: null,
    failingCases: [
      failingCase(
        'Tab bar navigation works correctly',
        'tests/mobile/navigation.spec.ts',
        lineOf(MOBILE_NAV_SPEC, "await page.goto('https://m.shop.example.com/');"),
        14,
        (frames) =>
          buildActionTimeoutError({
            action: 'page.goto',
            timeoutMs: 30000,
            callLog: ['navigating to "https://m.shop.example.com/", waiting until "load"'],
            frames,
          }),
        [],
        {
          call: navigateCall('https://m.shop.example.com/', 'https://m.shop.example.com/', actionTimeout(30000)),
          before: [],
        },
      ),
      failingCase(
        'Back gesture navigates correctly',
        'tests/mobile/navigation.spec.ts',
        lineOf(MOBILE_NAV_SPEC, "await page.goto('https://m.shop.example.com/products/42');"),
        14,
        (frames) =>
          buildActionTimeoutError({
            action: 'page.goto',
            timeoutMs: 30000,
            callLog: ['navigating to "https://m.shop.example.com/products/42", waiting until "load"'],
            frames,
          }),
        [],
        {
          call: navigateCall(
            'https://m.shop.example.com/products/42',
            'https://m.shop.example.com/products/42',
            actionTimeout(30000),
          ),
          before: [],
        },
      ),
    ],
    aria: '- document:\n  - navigation "Loading…"\n  - img "Hero"',
    evidence: {
      // The landing page requests its hero once its script runs, and the
      // image is still loading when the navigation gives up on "load".
      failingNetwork: [
        {
          method: 'GET',
          url: 'https://m.shop.example.com/hero-4k.png',
          status: 200,
          duration: 27800,
          resourceType: 'image',
          contentType: 'image/png',
          intoStepMs: 2400,
        },
      ],
    },
    appFiles: ['src/pages/index.vue'],
    suspectSha: '6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    diagnosis: {
      seeded: true,
      kind: 'goto-timeout',
      area: 'mobile navigation',
      fix: {
        description: 'Raise the navigation timeout for the mobile profile while the asset weight is addressed.',
        file: 'tests/mobile/navigation.spec.ts',
        patch: derivePatch('tests/mobile/navigation.spec.ts', MOBILE_NAV_SPEC, {
          at: lineOf(MOBILE_NAV_SPEC, "await page.goto('https://m.shop.example.com/');"),
          remove: 1,
          add: ["    await page.goto('https://m.shop.example.com/', { timeout: 60000 });"],
        }),
      },
    },
    media: { screenshot: 'mobile-nav-loading.png', video: 'mobile-nav-timeout.webm' },
    firing: { startAgo: 3, chance: 0.8 },
  },

  {
    key: 'mobile-webkit-crash',
    clusterId: 8,
    projectId: 4,
    specFile: 'tests/mobile/forms.spec.ts',
    locator: "getByLabel('Delivery notes')",
    failingCases: [
      failingCase(
        'Text input shows keyboard on focus',
        'tests/mobile/forms.spec.ts',
        lineOf(MOBILE_FORMS_SPEC, "await page.getByLabel('Delivery notes').fill('Leave at the door');"),
        47,
        (frames) =>
          buildCrashError({
            action: 'locator.fill',
            callLog: [
              "waiting for getByLabel('Delivery notes')",
              'locator resolved to <textarea id="delivery-notes"></textarea>',
              'fill("Leave at the door")',
              'attempting fill action',
            ],
            frames,
          }),
        [],
        { call: fillCall("getByLabel('Delivery notes')", 'Leave at the door') },
      ),
    ],
    // The page is gone after the crash — nothing to snapshot.
    aria: null,
    evidence: { noPageArtifacts: true },
    appFiles: ['src/lib/signature-pad.ts'],
    suspectSha: '8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2',
    diagnosis: {
      seeded: false,
      kind: 'crash',
      area: 'mobile forms',
      fix: {
        description:
          'Cap the signature-pad backing store to the visible viewport so WebKit stops killing the page on 3× devices.',
        file: 'src/lib/signature-pad.ts',
        patch: derivePatch('src/lib/signature-pad.ts', SIGNATURE_PAD, {
          at: lineOf(SIGNATURE_PAD, 'canvas.height = document.body.scrollHeight * DPR;'),
          remove: 1,
          add: ['  canvas.height = window.innerHeight * DPR;'],
        }),
      },
    },
    media: {},
    firing: { startAgo: 2, chance: 0.7 },
  },

  {
    key: 'dark-mode-export-hidden',
    clusterId: 9,
    projectId: 5,
    specFile: 'tests/admin/reports.spec.ts',
    locator: "getByRole('button', { name: 'Export CSV' })",
    /**
     * The locator is never acted on — it only ever appears in
     * `expect(…).toBeVisible()` — so its healing snapshot comes from the
     * reporter's assertion capture, keyed at the expect() call site (the
     * error's innermost frame).
     */
    captureLocation: `tests/admin/reports.spec.ts:${lineOf(REPORTS_SPEC, "await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();")}:18`,
    failingCases: [
      failingCase(
        'exports the monthly report as CSV',
        'tests/admin/reports.spec.ts',
        lineOf(REPORTS_SPEC, "await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();"),
        18,
        (frames) =>
          buildWebAssertionError({
            matcher: 'expect(locator).toBeVisible()',
            locator: "getByRole('button', { name: 'Export CSV' })",
            expected: 'visible',
            received: 'hidden',
            timeoutMs: 5000,
            callLog: [
              'Expect "toBeVisible" with timeout 5000ms',
              "waiting for getByRole('button', { name: 'Export CSV' })",
              '  9 × locator resolved to <button hidden class="export-btn">Export CSV</button>',
              '    - unexpected value "hidden"',
            ],
            frames,
            ansi: true,
          }),
        [],
        { call: expectCall('toBeVisible', "getByRole('button', { name: 'Export CSV' })", expectTimeout(5000)) },
      ),
    ],
    aria:
      '- document:\n  - navigation "Admin":\n    - link "Dashboard"\n    - link "Reports"\n    - link "Users"\n' +
      '  - main:\n    - heading "Monthly report" [level=1]\n    - button "Toggle theme"\n    - button "Refresh data"\n' +
      '    - img "Revenue chart"\n    - table "Totals":\n      - row "Month Revenue"\n      - row "June $ 48,120"',
    domSnapshot: { viewport: DOM_SNAPSHOT_VIEWPORT, html: REPORTS_DARK_DOM },
    evidence: {},
    appFiles: ['src/styles/theme.css'],
    suspectSha: '9a8b7c6d5e4f30211203f4e5d6c7b8a99a8b7c6d',
    diagnosis: {
      seeded: false,
      kind: 'env-visibility',
      area: 'reports / dark mode',
      fix: {
        description: 'Restore the raised surface for secondary actions in dark mode instead of hiding them.',
        file: 'src/styles/theme.css',
        patch: derivePatch('src/styles/theme.css', THEME_CSS, {
          at: lineOf(THEME_CSS, 'visibility: hidden;'),
          remove: 1,
          add: ['    background: var(--surface-raised-dark);'],
        }),
      },
    },
    media: { screenshot: 'admin-dark-dashboard.png', trace: 'admin-dark-dashboard.zip' },
    firing: { startAgo: 2, chance: 1, requiresColorScheme: 'dark' },
  },

  {
    key: 'users-table-page-size',
    clusterId: 10,
    projectId: 5,
    specFile: 'tests/admin/users.spec.ts',
    locator: "getByRole('row')",
    failingCases: [
      failingCase(
        'Users table paginates 25 rows per page',
        'tests/admin/users.spec.ts',
        lineOf(USERS_SPEC, "await expect(page.getByRole('row')).toHaveCount(26);"),
        44,
        (frames) =>
          buildWebAssertionError({
            matcher: 'expect(locator).toHaveCount(expected)',
            locator: "getByRole('row')",
            expected: '26',
            received: '51',
            timeoutMs: 5000,
            callLog: [
              'Expect "toHaveCount" with timeout 5000ms',
              "waiting for getByRole('row')",
              '  9 × locator resolved to 51 elements',
              '    - unexpected value "51"',
            ],
            frames,
          }),
        [],
        { call: expectCall('toHaveCount', "getByRole('row')", expectTimeout(5000)) },
      ),
    ],
    aria: '- document:\n  - main:\n    - heading "Users"\n    - table "Users":\n      - row "Name Email Role"\n      - row "Ada Lovelace ada@example.com admin"',
    // The page as it last passed: a rows-per-page control and pagination that
    // vanished on the failure, which is why every row renders at once.
    baselineAria:
      '- document:\n  - main:\n    - heading "User directory"\n    - button "Rows per page: 25"\n' +
      '    - table "Users":\n      - row "Name Email Role"\n      - row "Ada Lovelace ada@example.com admin"\n' +
      '    - navigation "Pagination":\n      - button "Next page"',
    evidence: {
      failingNetwork: [
        {
          method: 'GET',
          url: 'https://admin.example.com/api/users?page=1',
          status: 200,
          duration: 340,
          resourceType: 'fetch',
        },
      ],
    },
    appFiles: [USERS_ENDPOINTS_PATH],
    suspectSha: 'c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7',
    diagnosis: {
      seeded: true,
      kind: 'assertion-mismatch',
      area: 'users table / pagination',
      fix: {
        description: 'Restore the dashboard page size the server-driven pagination change overrode.',
        file: USERS_ENDPOINTS_PATH,
        patch: derivePatch(USERS_ENDPOINTS_PATH, USERS_ENDPOINTS, {
          at: lineOf(USERS_ENDPOINTS, 'private const int DefaultPageSize = 50;'),
          remove: 1,
          add: ['    private const int DefaultPageSize = 25;'],
        }),
      },
    },
    media: { screenshot: 'admin-users-table.png' },
    firing: { startAgo: 4, chance: 0.85 },
    // The server coverage of the newest run the cluster fails in, recorded
    // from a coverage build of the ASP.NET Core API: the three users tests
    // request `GET /api/users`, and the other tests make no request to it. Of
    // the pagination commit's changed lines, the statements that page the
    // query ran in the failing test and in the two passing ones.
    coverage: {
      'tests/admin/users.spec.ts › Users table paginates 25 rows per page': [listUsersCoverage()],
      'tests/admin/users.spec.ts › invites a user by email': [listUsersCoverage()],
      'tests/admin/users.spec.ts › filters users by role': [listUsersCoverage({ role: true })],
    },
  },
];

/**
 * The coverage one test of a story's covered run recorded: the entries of its
 * spec file, then those of the test itself (`<spec file> › <title>`).
 *
 * @param {import('./failure-stories.d.mts').FailureStory} story
 * @param {string} file @param {string} title
 * @returns {import('./failure-stories.d.mts').StoryCoverageFile[]}
 */
export function storyCoverageFiles(story, file, title) {
  return [...(story.coverage?.[file] ?? []), ...(story.coverage?.[`${file} › ${title}`] ?? [])];
}

// ── Derived captured artifacts (testSource / testSourceFrames) ──────────────

/**
 * The legacy single-string `testSource` for a failing case — line-numbered,
 * context 30 around the failing line, declaration marked (mirrors
 * `readSourceSnippet(file, declLine, 30, failingLine)`).
 *
 * @param {{ specFile: string }} story
 * @param {{ failingLine: number }} failing
 * @param {number} declLine
 */
export function buildTestSource(story, failing, declLine) {
  return renderSnippet(SOURCE_FILES[story.specFile], {
    declLine,
    failingLine: failing.failingLine,
    context: 30,
  });
}

/**
 * The `test_source_frames` array for a failing case — one frame per in-project
 * stack frame, innermost first, context 8 (mirrors `collectSourceFrames`).
 *
 * @param {{ frames: Array<{file: string, line: number}> }} failing
 */
export function buildSourceFrames(failing) {
  return failing.frames.map((f) => ({
    file: f.file,
    line: f.line,
    snippet: renderSnippet(SOURCE_FILES[f.file], { declLine: f.line, failingLine: f.line, context: 8 }),
  }));
}

// ── Failure timing (where a story's failing step and evidence sit in its execution) ──

/** How long the test runs on after its failing call: the after hooks and fixture teardown, in ms. */
export const FAILURE_TEARDOWN_MS = 250;

/** A request at least this slow is in flight through the failing step (the clue engine's default threshold). */
const SLOW_STORY_REQUEST_MS = 1500;

/**
 * How long a failing call lasts, in ms: until the test timeout for a test
 * timeout (`at` is when the call started, in ms from the test start), its own
 * timeout for an action or expect timeout, `fallbackMs` when it failed without one.
 *
 * @param {FailingCall} call @param {number} at @param {number} fallbackMs
 */
export function failingCallDuration(call, at, fallbackMs) {
  if (call.timeout === 'test') return Math.max(1, call.timeoutMs - at);
  if (call.timeout === 'action' || call.timeout === 'expect') return call.timeoutMs;
  return fallbackMs;
}

/**
 * The failing call as a stored step, failed with the first line of the case's
 * error, starting `at` ms from the test start.
 *
 * @param {FailingCase} failing @param {number} at @param {number} duration
 */
export function failingStep(failing, at, duration) {
  const { title, category, subtitle, params, location } = failing.call;
  return {
    title,
    duration,
    category,
    at,
    ...(subtitle ? { subtitle } : {}),
    ...(params ? { params } : {}),
    location,
    failed: true,
    error: { message: failing.error.split('\n')[0] },
  };
}

/** An authored duration at `scale`, in ms. */
const scaledMs = (duration, scale) => Math.round((duration ?? 0) * scale);

/**
 * The steps of a failing case that carries its authored steps, ending with the
 * failing call: each with `at`, in ms from the test start, and its `duration`.
 * The first starts at `startMs`, once the test's fixtures are set up; `scale`
 * stretches the authored durations, as a slower or faster runner would. Null
 * when the case carries none.
 *
 * @param {FailingCase} failing @param {{ scale?: number, startMs?: number, fallbackMs?: number }} [opts]
 */
export function authoredFailureSteps(failing, { scale = 1, startMs = 0, fallbackMs = 500 } = {}) {
  if (!failing.before) return null;
  let at = startMs;
  // The step as the reporter sends it: no timeout keys, no hook marker.
  const steps = failing.before.map(({ duration, timeoutMs: _ms, timeout: _kind, hook: _hook, ...step }) => {
    const ms = scaledMs(duration, scale);
    const out = { title: step.title, duration: ms, category: step.category, at, ...step };
    at += ms;
    return out;
  });
  steps.push(failingStep(failing, at, failingCallDuration(failing.call, at, fallbackMs)));
  return steps;
}

/**
 * How long the beforeEach hook of a case with authored steps runs, in ms at
 * `scale`: the authored steps it holds, 0 when its spec has no beforeEach.
 *
 * @param {FailingCase} failing @param {{ scale?: number }} [opts]
 */
export function authoredBeforeEachMs(failing, { scale = 1 } = {}) {
  return (failing.before ?? [])
    .filter((step) => step.hook === 'beforeEach')
    .reduce((sum, step) => sum + scaledMs(step.duration, scale), 0);
}

/**
 * Where a story's own evidence sits around its failing step, in ms from the
 * test start: a slow request starts `intoStepMs` (default 30 ms) into the step
 * and is still in flight through it, any other request ends 40 ms before the
 * step starts; a console entry with `intoSlowRequestMs` is logged that long
 * after the slow request started, any other 250 ms before the step; the dialog
 * closes 150 ms before the failure.
 *
 * @param {FailureStory} story @param {{ at: number, duration: number }} step
 * @returns {{ requests: number[], console: number[], dialogClosedAt: number }}
 */
export function storyEvidenceTimes(story, step) {
  const network = story.evidence.failingNetwork ?? [];
  const requests = network.map((req) =>
    req.duration >= SLOW_STORY_REQUEST_MS ? step.at + (req.intoStepMs ?? 30) : Math.max(0, step.at - 40 - req.duration),
  );
  const slowIndex = network.findIndex((req) => req.duration >= SLOW_STORY_REQUEST_MS);
  const console = (story.evidence.consoleOnFail ?? []).map((entry, i) =>
    entry.intoSlowRequestMs != null && slowIndex >= 0
      ? requests[slowIndex] + entry.intoSlowRequestMs
      : Math.max(0, step.at - 250 + i * 40),
  );
  return { requests, console, dialogClosedAt: step.at + step.duration - 150 };
}

// ── Simulator exports ───────────────────────────────────────────────────────
// The simulator replays these verbatim so live runs fingerprint into the
// seeded clusters (same message head + same selector ⇒ same fingerprint).

export const SIMULATOR_ERRORS = {
  /** Joins cluster 1 (checkout Pay timeout). */
  checkoutPayTimeout: FAILURE_STORIES[0].failingCases[0].error,
  checkoutPayTimeoutPaypal: FAILURE_STORIES[0].failingCases[1].error,
  /** Joins cluster 2 (renamed email label — locator healing showcase). */
  emailLabelRenamed: FAILURE_STORIES[1].failingCases[0].error,
};

/** Story lookup by cluster id. */
export function storyByClusterId(clusterId) {
  return FAILURE_STORIES.find((s) => s.clusterId === clusterId) ?? null;
}

/**
 * The story a seeded test case belongs to, resolved by the case's identity
 * (project + spec file + title). Used by the demo dom-snapshot mirror to serve
 * a story's authored failure-time DOM for any of its failing cases.
 */
export function storyForCase(projectId, filePath, title) {
  return (
    FAILURE_STORIES.find(
      (s) => s.projectId === projectId && s.specFile === filePath && s.failingCases.some((fc) => fc.title === title),
    ) ?? null
  );
}

// ── Demo projects ───────────────────────────────────────────────────────────
// The five demo projects with their test cases (file + title + declaration
// location — Playwright's `test.location` points at the `test(` call), browser
// profiles, and per-project evidence themes. The seed generator, the simulator
// and the consistency test all read the same lists.

/** Declaration line of `test('<title>', …)` in an authored source file. */
function decl(sourceLines, title) {
  return lineOf(sourceLines, `test('${title.replace(/'/g, "\\'")}'`);
}

const DESKTOP = { deviceScaleFactor: 1, isMobile: false, hasTouch: false };

export const DEMO_PROJECTS = [
  {
    id: 1,
    name: 'e2e-checkout',
    baseUrl: 'https://shop.example.com',
    cases: [
      {
        file: 'tests/checkout/checkout.spec.ts',
        title: 'should complete checkout with credit card',
        declLine: decl(CHECKOUT_SPEC, 'should complete checkout with credit card'),
        declColumn: 3,
      },
      {
        file: 'tests/checkout/checkout.spec.ts',
        title: 'should complete checkout with PayPal',
        declLine: decl(CHECKOUT_SPEC, 'should complete checkout with PayPal'),
        declColumn: 3,
      },
      {
        file: 'tests/checkout/checkout.spec.ts',
        title: 'should complete checkout with Apple Pay',
        declLine: decl(CHECKOUT_SPEC, 'should complete checkout with Apple Pay'),
        declColumn: 3,
      },
      {
        file: 'tests/checkout/checkout.spec.ts',
        title: 'should show error for expired card',
        declLine: decl(CHECKOUT_SPEC, 'should show error for expired card'),
        declColumn: 3,
      },
      {
        file: 'tests/checkout/checkout.spec.ts',
        title: 'should show error for invalid CVV',
        declLine: decl(CHECKOUT_SPEC, 'should show error for invalid CVV'),
        declColumn: 3,
      },
      { file: 'tests/checkout/cart.spec.ts', title: 'should add item to cart', declLine: 4, declColumn: 3 },
      { file: 'tests/checkout/cart.spec.ts', title: 'should remove item from cart', declLine: 11, declColumn: 3 },
      { file: 'tests/checkout/cart.spec.ts', title: 'should update item quantity', declLine: 18, declColumn: 3 },
      { file: 'tests/checkout/cart.spec.ts', title: 'should apply discount code', declLine: 25, declColumn: 3 },
      {
        file: 'tests/checkout/cart.spec.ts',
        title: 'should display cart total correctly',
        declLine: 33,
        declColumn: 3,
      },
      {
        file: 'tests/checkout/address.spec.ts',
        title: 'should fill and save shipping address',
        declLine: 4,
        declColumn: 3,
      },
      {
        file: 'tests/checkout/address.spec.ts',
        title: 'should validate required address fields',
        declLine: 13,
        declColumn: 3,
      },
    ],
    suites: {
      'tests/checkout/checkout.spec.ts': { suitePath: ['Checkout'], mode: 'parallel', annotations: [] },
      'tests/checkout/cart.spec.ts': { suitePath: ['Cart'], mode: 'serial', annotations: [] },
      'tests/checkout/address.spec.ts': { suitePath: ['Address'], mode: 'default', annotations: [] },
    },
    browsers: [
      {
        projectName: 'Chromium',
        browserName: 'chromium',
        channel: null,
        viewport: { width: 1280, height: 720 },
        ...DESKTOP,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        colorScheme: 'light',
      },
      {
        projectName: 'Firefox',
        browserName: 'firefox',
        channel: null,
        viewport: { width: 1280, height: 720 },
        ...DESKTOP,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        colorScheme: 'light',
      },
      {
        projectName: 'Chrome Stable',
        browserName: 'chromium',
        channel: 'chrome',
        viewport: { width: 1280, height: 720 },
        ...DESKTOP,
        locale: 'en-US',
        timezoneId: 'America/New_York',
        colorScheme: 'light',
      },
    ],
    /** Which browser config each run uses, cycled by run index (newest first). */
    browserRotation: [0, 0, 1, 0, 2, 0, 1, 0],
    network: [
      { method: 'GET', url: 'https://shop.example.com/api/cart', status: 200, duration: 62, resourceType: 'fetch' },
      {
        method: 'POST',
        url: 'https://shop.example.com/api/checkout/quote',
        status: 200,
        duration: 240,
        resourceType: 'fetch',
      },
      {
        method: 'POST',
        url: 'https://shop.example.com/api/payments/authorize',
        status: 201,
        duration: 380,
        resourceType: 'fetch',
      },
      {
        method: 'GET',
        url: 'https://cdn.pay.example.com/sdk.js',
        status: 200,
        duration: 850,
        resourceType: 'script',
        contentType: 'text/javascript',
      },
    ],
    consolePassing: [
      {
        type: 'log',
        text: '[analytics] page view: /checkout',
        location: 'https://shop.example.com/assets/analytics-Bh2kQ9.js:1:2210',
      },
    ],
    webVitals: true,
    pageState: {
      url: 'https://shop.example.com/checkout',
      localStorage: [
        { key: 'cart', length: 182 },
        { key: 'theme', length: 5 },
        { key: 'quote', length: 64 },
      ],
      sessionStorage: [{ key: 'checkout-session', length: 36 }],
      cookies: [
        { name: 'sid', domain: '.shop.example.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
        { name: 'ab_variant', domain: '.shop.example.com', path: '/', httpOnly: false, secure: true },
      ],
    },
    // Steps in the Playwright 1.63 shape: a bare verb title with the target
    // carried in `subtitle`, plus curated `params`. The other demo projects keep
    // the 1.61 shape (target folded into the title, no params) so both render.
    stepTitles: [
      {
        title: 'Navigate',
        subtitle: '/checkout',
        category: 'navigation',
        weight: 900,
        params: { url: 'https://shop.example.com/checkout' },
      },
      {
        title: 'Fill "ada@example.com"',
        subtitle: "getByLabel('Email')",
        category: 'input',
        weight: 800,
        params: { locator: "getByLabel('Email')", value: 'ada@example.com' },
        // The call site, and the page it ran on as the capture fixtures record it.
        location: 'tests/pages/checkout.page.ts:18:31',
        page: '/checkout',
        arrival: true,
      },
      {
        title: 'Fill "Ada Lovelace"',
        subtitle: "getByLabel('Name on card')",
        category: 'input',
        weight: 1100,
        params: { locator: "getByLabel('Name on card')", value: 'Ada Lovelace' },
        location: 'tests/pages/checkout.page.ts:22:38',
        page: '/checkout',
        arrival: false,
      },
      {
        title: 'Click',
        subtitle: "getByRole('button', { name: 'Place order' })",
        category: 'action',
        weight: 1300,
        params: { locator: "getByRole('button', { name: 'Place order' })" },
        location: 'tests/pages/checkout.page.ts:26:58',
        page: '/checkout',
        arrival: false,
      },
      {
        title: 'Expect "toBeVisible"',
        subtitle: "getByText('Order confirmed')",
        category: 'assertion',
        weight: 700,
        params: { locator: "getByText('Order confirmed')" },
        // Placing the order navigates to the order's page: the assertion runs there, as it loads.
        location: 'tests/pages/checkout.page.ts:30:40',
        page: '/orders/:id',
        arrival: true,
      },
    ],
  },
  {
    id: 2,
    name: 'api-integration',
    baseUrl: null,
    cases: [
      {
        file: 'tests/api/auth.spec.ts',
        title: 'POST /auth/login returns 200 with valid credentials',
        declLine: decl(AUTH_SPEC, 'POST /auth/login returns 200 with valid credentials'),
        declColumn: 3,
      },
      {
        file: 'tests/api/auth.spec.ts',
        title: 'POST /auth/login returns 401 with invalid credentials',
        declLine: decl(AUTH_SPEC, 'POST /auth/login returns 401 with invalid credentials'),
        declColumn: 3,
      },
      {
        file: 'tests/api/auth.spec.ts',
        title: 'GET /auth/me returns current user',
        declLine: decl(AUTH_SPEC, 'GET /auth/me returns current user'),
        declColumn: 3,
      },
      { file: 'tests/api/products.spec.ts', title: 'GET /products returns paginated list', declLine: 4, declColumn: 3 },
      {
        file: 'tests/api/products.spec.ts',
        title: 'GET /products/:id returns product details',
        declLine: 11,
        declColumn: 3,
      },
      {
        file: 'tests/api/products.spec.ts',
        title: 'POST /products creates product (admin)',
        declLine: 18,
        declColumn: 3,
      },
      {
        file: 'tests/api/products.spec.ts',
        title: 'DELETE /products/:id removes product (admin)',
        declLine: 26,
        declColumn: 3,
      },
      {
        file: 'tests/api/orders.spec.ts',
        title: 'POST /orders creates order',
        declLine: decl(ORDERS_SPEC, 'POST /orders creates order'),
        declColumn: 3,
      },
      {
        file: 'tests/api/orders.spec.ts',
        title: 'GET /orders/:id returns order details',
        declLine: decl(ORDERS_SPEC, 'GET /orders/:id returns order details'),
        declColumn: 3,
      },
      {
        file: 'tests/api/orders.spec.ts',
        title: 'PUT /orders/:id/status updates order status',
        declLine: decl(ORDERS_SPEC, 'PUT /orders/:id/status updates order status'),
        declColumn: 3,
      },
      { file: 'tests/api/search.spec.ts', title: 'GET /search returns results', declLine: 4, declColumn: 3 },
      { file: 'tests/api/search.spec.ts', title: 'GET /search handles empty query', declLine: 12, declColumn: 3 },
      { file: 'tests/api/users.spec.ts', title: 'GET /users/:id returns user profile', declLine: 4, declColumn: 3 },
      { file: 'tests/api/users.spec.ts', title: 'PUT /users/:id updates user profile', declLine: 12, declColumn: 3 },
    ],
    suites: {
      'tests/api/auth.spec.ts': { suitePath: ['Auth'], mode: 'default', annotations: [] },
      'tests/api/products.spec.ts': { suitePath: ['Products'], mode: 'default', annotations: [] },
      'tests/api/orders.spec.ts': { suitePath: ['Orders'], mode: 'default', annotations: [] },
      'tests/api/search.spec.ts': { suitePath: ['Search'], mode: 'default', annotations: [] },
      'tests/api/users.spec.ts': { suitePath: ['Users'], mode: 'default', annotations: [] },
    },
    browsers: [
      // API tests run in a browserless Playwright project — no page, no viewport.
      { projectName: 'API', browserName: 'chromium', channel: null, viewport: null },
    ],
    browserRotation: [0],
    network: [
      {
        method: 'POST',
        url: 'https://api.shop.example.com/auth/login',
        status: 200,
        duration: 120,
        resourceType: 'fetch',
      },
      {
        method: 'GET',
        url: 'https://api.shop.example.com/products?page=1',
        status: 200,
        duration: 85,
        resourceType: 'fetch',
      },
      { method: 'POST', url: 'https://api.shop.example.com/orders', status: 201, duration: 145, resourceType: 'fetch' },
      {
        method: 'GET',
        url: 'https://api.shop.example.com/orders/1001',
        status: 200,
        duration: 64,
        resourceType: 'fetch',
      },
    ],
    consolePassing: null,
    webVitals: false,
    pageState: null,
    stepTitles: [
      { title: 'Prepare request payload', category: 'setup', weight: 200 },
      { title: 'Send request', category: 'action', weight: 900 },
      { title: 'Assert response status', category: 'assertion', weight: 250 },
      { title: 'Assert response body', category: 'assertion', weight: 300 },
    ],
  },
  {
    id: 3,
    name: 'ui-components',
    baseUrl: 'https://design.example.com',
    cases: [
      {
        file: 'tests/ui/button.spec.ts',
        title: 'Button primary variant renders correctly',
        declLine: decl(BUTTON_SPEC, 'Button primary variant renders correctly'),
        declColumn: 3,
      },
      {
        file: 'tests/ui/button.spec.ts',
        title: 'Button disabled state renders correctly',
        declLine: decl(BUTTON_SPEC, 'Button disabled state renders correctly'),
        declColumn: 3,
      },
      {
        file: 'tests/ui/button.spec.ts',
        title: 'Button loading state renders correctly',
        declLine: decl(BUTTON_SPEC, 'Button loading state renders correctly'),
        declColumn: 3,
      },
      {
        file: 'tests/ui/modal.spec.ts',
        title: 'Modal opens and closes correctly',
        declLine: decl(MODAL_SPEC, 'Modal opens and closes correctly'),
        declColumn: 3,
      },
      {
        file: 'tests/ui/modal.spec.ts',
        title: 'Modal with large content scrolls correctly',
        declLine: decl(MODAL_SPEC, 'Modal with large content scrolls correctly'),
        declColumn: 3,
      },
      { file: 'tests/ui/form.spec.ts', title: 'Form validation shows errors correctly', declLine: 4, declColumn: 3 },
      { file: 'tests/ui/form.spec.ts', title: 'Form submit button disabled when invalid', declLine: 12, declColumn: 3 },
      { file: 'tests/ui/table.spec.ts', title: 'Table sorts by column correctly', declLine: 4, declColumn: 3 },
      { file: 'tests/ui/table.spec.ts', title: 'Table pagination works correctly', declLine: 12, declColumn: 3 },
      { file: 'tests/ui/table.spec.ts', title: 'Table search filters results', declLine: 20, declColumn: 3 },
    ],
    suites: {
      'tests/ui/button.spec.ts': { suitePath: ['Button'], mode: 'parallel', annotations: [{ type: 'smoke' }] },
      'tests/ui/modal.spec.ts': { suitePath: ['Modal'], mode: 'serial', annotations: [] },
      'tests/ui/form.spec.ts': { suitePath: ['Form'], mode: 'default', annotations: [] },
      'tests/ui/table.spec.ts': { suitePath: ['Table'], mode: 'default', annotations: [] },
    },
    browsers: [
      // Visual-regression profile: retina scale factor, animations disabled.
      {
        projectName: 'Chromium',
        browserName: 'chromium',
        channel: null,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
        isMobile: false,
        hasTouch: false,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
        reducedMotion: 'reduce',
      },
    ],
    browserRotation: [0],
    network: [
      {
        method: 'GET',
        url: 'https://design.example.com/components/button',
        status: 200,
        duration: 45,
        resourceType: 'document',
        contentType: 'text/html',
      },
      {
        method: 'GET',
        url: 'https://design.example.com/assets/tokens-D2mXq.css',
        status: 200,
        duration: 18,
        resourceType: 'stylesheet',
        contentType: 'text/css',
      },
      {
        method: 'GET',
        url: 'https://design.example.com/assets/components-Bq7Yz.js',
        status: 200,
        duration: 52,
        resourceType: 'script',
        contentType: 'text/javascript',
      },
      {
        method: 'GET',
        url: 'https://design.example.com/fonts/Inter-Variable.woff2',
        status: 200,
        duration: 33,
        resourceType: 'font',
        contentType: 'font/woff2',
      },
    ],
    consolePassing: [
      {
        type: 'warning',
        text: '[Vue warn]: Extraneous non-props attributes (variant) were passed to component',
        location: 'https://design.example.com/assets/components-Bq7Yz.js:1:8412',
      },
    ],
    webVitals: true,
    pageState: {
      url: 'https://design.example.com/components/button',
      localStorage: [{ key: 'docs-theme', length: 5 }],
      sessionStorage: [],
      cookies: [],
    },
    stepTitles: [
      { title: 'Open component page', category: 'navigation', weight: 500 },
      { title: 'Interact with component', category: 'action', weight: 800 },
      { title: 'Assert rendered state', category: 'assertion', weight: 600 },
      { title: 'Compare against baseline', category: 'assertion', weight: 1200 },
    ],
  },
  {
    id: 4,
    name: 'mobile-safari',
    baseUrl: 'https://m.shop.example.com',
    cases: [
      {
        file: 'tests/mobile/navigation.spec.ts',
        title: 'Tab bar navigation works correctly',
        declLine: decl(MOBILE_NAV_SPEC, 'Tab bar navigation works correctly'),
        declColumn: 3,
      },
      {
        file: 'tests/mobile/navigation.spec.ts',
        title: 'Back gesture navigates correctly',
        declLine: decl(MOBILE_NAV_SPEC, 'Back gesture navigates correctly'),
        declColumn: 3,
      },
      { file: 'tests/mobile/gestures.spec.ts', title: 'Swipe to dismiss works', declLine: 4, declColumn: 3 },
      { file: 'tests/mobile/gestures.spec.ts', title: 'Pull to refresh triggers reload', declLine: 12, declColumn: 3 },
      {
        file: 'tests/mobile/forms.spec.ts',
        title: 'Text input shows keyboard on focus',
        declLine: decl(MOBILE_FORMS_SPEC, 'Text input shows keyboard on focus'),
        declColumn: 3,
      },
      {
        file: 'tests/mobile/forms.spec.ts',
        title: 'Date picker works correctly',
        declLine: decl(MOBILE_FORMS_SPEC, 'Date picker works correctly'),
        declColumn: 3,
      },
      { file: 'tests/mobile/media.spec.ts', title: 'Images load with correct dimensions', declLine: 4, declColumn: 3 },
    ],
    suites: {
      'tests/mobile/navigation.spec.ts': { suitePath: ['Navigation'], mode: 'default', annotations: [] },
      'tests/mobile/gestures.spec.ts': { suitePath: ['Gestures'], mode: 'default', annotations: [] },
      'tests/mobile/forms.spec.ts': { suitePath: ['Forms'], mode: 'default', annotations: [] },
      'tests/mobile/media.spec.ts': { suitePath: ['Media'], mode: 'default', annotations: [] },
    },
    browsers: [
      // Real device-emulation profile (iPhone 13-class).
      {
        projectName: 'Mobile Safari',
        browserName: 'webkit',
        channel: null,
        viewport: { width: 390, height: 664 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        colorScheme: 'light',
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      },
    ],
    browserRotation: [0],
    network: [
      {
        method: 'GET',
        url: 'https://m.shop.example.com/',
        status: 200,
        duration: 480,
        resourceType: 'document',
        contentType: 'text/html',
      },
      {
        method: 'GET',
        url: 'https://m.shop.example.com/hero-4k.png',
        status: 200,
        duration: 3400,
        resourceType: 'image',
        contentType: 'image/png',
      },
      {
        method: 'GET',
        url: 'https://m.shop.example.com/api/products/featured',
        status: 200,
        duration: 190,
        resourceType: 'fetch',
      },
    ],
    consolePassing: null,
    webVitals: true,
    pageState: {
      url: 'https://m.shop.example.com/',
      localStorage: [{ key: 'recently-viewed', length: 96 }],
      sessionStorage: [],
      cookies: [{ name: 'sid', domain: '.shop.example.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }],
    },
    stepTitles: [
      { title: 'Open page on device profile', category: 'navigation', weight: 1400 },
      { title: 'Perform touch gesture', category: 'action', weight: 700 },
      { title: 'Assert layout state', category: 'assertion', weight: 500 },
    ],
  },
  {
    id: 5,
    name: 'web-dashboard',
    baseUrl: 'https://admin.example.com',
    cases: [
      {
        file: 'tests/admin/login.spec.ts',
        title: 'signs in with SSO redirect',
        declLine: decl(LOGIN_SPEC, 'signs in with SSO redirect'),
        declColumn: 3,
      },
      {
        file: 'tests/admin/login.spec.ts',
        title: 'shows an error for a revoked account',
        declLine: decl(LOGIN_SPEC, 'shows an error for a revoked account'),
        declColumn: 3,
      },
      {
        file: 'tests/admin/users.spec.ts',
        title: 'Users table paginates 25 rows per page',
        declLine: decl(USERS_SPEC, 'Users table paginates 25 rows per page'),
        declColumn: 3,
      },
      {
        file: 'tests/admin/users.spec.ts',
        title: 'invites a user by email',
        declLine: decl(USERS_SPEC, 'invites a user by email'),
        declColumn: 3,
      },
      {
        file: 'tests/admin/users.spec.ts',
        title: 'filters users by role',
        declLine: decl(USERS_SPEC, 'filters users by role'),
        declColumn: 3,
      },
      {
        file: 'tests/admin/reports.spec.ts',
        title: 'renders the revenue chart',
        declLine: decl(REPORTS_SPEC, 'renders the revenue chart'),
        declColumn: 3,
      },
      {
        file: 'tests/admin/reports.spec.ts',
        title: 'exports the monthly report as CSV',
        declLine: decl(REPORTS_SPEC, 'exports the monthly report as CSV'),
        declColumn: 3,
      },
      {
        file: 'tests/admin/settings.spec.ts',
        title: 'updates the organization name',
        declLine: decl(SETTINGS_SPEC, 'updates the organization name'),
        declColumn: 3,
      },
      {
        file: 'tests/admin/settings.spec.ts',
        title: 'rotates the API token',
        declLine: decl(SETTINGS_SPEC, 'rotates the API token'),
        declColumn: 3,
      },
      {
        file: 'tests/admin/settings.spec.ts',
        title: 'toggles dark mode',
        declLine: decl(SETTINGS_SPEC, 'toggles dark mode'),
        declColumn: 3,
      },
    ],
    suites: {
      'tests/admin/login.spec.ts': { suitePath: ['Login'], mode: 'default', annotations: [] },
      'tests/admin/users.spec.ts': { suitePath: ['Users'], mode: 'default', annotations: [] },
      'tests/admin/reports.spec.ts': { suitePath: ['Reports'], mode: 'default', annotations: [] },
      'tests/admin/settings.spec.ts': { suitePath: ['Settings'], mode: 'serial', annotations: [] },
    },
    browsers: [
      {
        projectName: 'Chromium',
        browserName: 'chromium',
        channel: null,
        viewport: { width: 1440, height: 900 },
        ...DESKTOP,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
      },
      {
        projectName: 'Firefox',
        browserName: 'firefox',
        channel: null,
        viewport: { width: 1440, height: 900 },
        ...DESKTOP,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
      },
      {
        projectName: 'WebKit',
        browserName: 'webkit',
        channel: null,
        viewport: { width: 1440, height: 900 },
        ...DESKTOP,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
      },
      // Same project name as config 0 — the dark-scheme rollout that breaks S9.
      // Environment-diff pins its baseline by browser_name, so pass (light) and
      // fail (dark) rows compare against each other.
      {
        projectName: 'Chromium',
        browserName: 'chromium',
        channel: null,
        viewport: { width: 1440, height: 900 },
        ...DESKTOP,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'dark',
      },
    ],
    browserRotation: [3, 3, 1, 2, 0, 1, 0, 2, 0, 0],
    network: [
      {
        method: 'GET',
        url: 'https://admin.example.com/api/metrics?range=30d',
        status: 200,
        duration: 210,
        resourceType: 'fetch',
      },
      {
        method: 'GET',
        url: 'https://admin.example.com/api/users?page=1',
        status: 200,
        duration: 160,
        resourceType: 'fetch',
      },
      {
        method: 'GET',
        url: 'https://admin.example.com/api/orgs/current',
        status: 200,
        duration: 55,
        resourceType: 'fetch',
      },
    ],
    consolePassing: [
      {
        type: 'log',
        text: '[telemetry] session started (sampled)',
        location: 'https://admin.example.com/assets/app-Cw1pR7.js:4:1022',
      },
    ],
    webVitals: true,
    pageState: {
      url: 'https://admin.example.com/dashboard',
      localStorage: [
        { key: 'sidebar-collapsed', length: 4 },
        { key: 'table-density', length: 7 },
      ],
      sessionStorage: [{ key: 'csrf', length: 32 }],
      cookies: [
        {
          name: 'admin_session',
          domain: 'admin.example.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'Strict',
        },
      ],
    },
    stepTitles: [
      {
        title: 'Sign in',
        category: 'test.step',
        weight: 900,
        children: [
          {
            title: 'Fill "admin@example.com"',
            category: 'input',
            weight: 200,
            subtitle: "getByLabel('Email')",
            params: { locator: "getByLabel('Email')", value: 'admin@example.com' },
          },
          {
            title: 'Fill "********"',
            category: 'input',
            weight: 200,
            subtitle: "getByLabel('Password')",
            params: { locator: "getByLabel('Password')" },
          },
          {
            title: 'Click',
            category: 'action',
            weight: 500,
            subtitle: "getByRole('button', { name: 'Sign in' })",
            params: { locator: "getByRole('button', { name: 'Sign in' })" },
          },
        ],
      },
      {
        title: 'Navigate to section',
        category: 'test.step',
        weight: 600,
        children: [
          {
            title: 'Click',
            category: 'action',
            weight: 300,
            subtitle: "getByRole('link', { name: 'Users' })",
            params: { locator: "getByRole('link', { name: 'Users' })" },
          },
          { title: 'Wait for load state', category: 'wait', weight: 300 },
        ],
      },
      {
        title: 'Perform admin action',
        category: 'test.step',
        weight: 1000,
        children: [
          {
            title: 'Click',
            category: 'action',
            weight: 400,
            subtitle: "getByRole('row', { name: 'Ada Lovelace' }).getByRole('button', { name: 'Edit' })",
            params: { locator: "getByRole('row', { name: 'Ada Lovelace' })" },
          },
          {
            title: 'Fill "Editor"',
            category: 'input',
            weight: 300,
            subtitle: "getByLabel('Role')",
            params: { locator: "getByLabel('Role')", value: 'Editor' },
          },
          {
            title: 'Click',
            category: 'action',
            weight: 300,
            subtitle: "getByRole('button', { name: 'Save' })",
            params: { locator: "getByRole('button', { name: 'Save' })" },
          },
        ],
      },
      {
        title: 'Assert table state',
        category: 'test.step',
        weight: 700,
        children: [
          {
            title: 'Expect "toHaveText"',
            category: 'assertion',
            weight: 400,
            subtitle: "getByRole('cell', { name: 'Editor' })",
            params: { locator: "getByRole('cell', { name: 'Editor' })" },
          },
          {
            title: 'Expect "toBeVisible"',
            category: 'assertion',
            weight: 300,
            subtitle: "getByText('Saved')",
            params: { locator: "getByText('Saved')" },
          },
        ],
      },
    ],
  },
];

// ── Canned SCM repositories ─────────────────────────────────────────────────
// Commits per project (newest first). Suspect commits — the ones the stories'
// diagnoses blame — MUST be in these lists; run metadata walks these SHAs so
// every commit shown on a run header exists in the repo history.

export const SCM_REPOS = {
  1: {
    repositoryUrl: 'https://github.com/example/shop-web',
    defaultBranch: 'main',
    branches: ['main', 'develop', 'feature/new-ui'],
    commits: [
      {
        sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
        message: 'feat: add new payment provider integration',
        author: 'Alice Chen',
        date: '2025-04-24T14:12:00Z',
        branch: 'main',
        files: [
          {
            filename: 'src/components/CheckoutForm.vue',
            status: 'modified',
            additions: 9,
            deletions: 1,
            patch: `@@ -1,6 +1,14 @@\n <script setup lang="ts">\n-import { ref } from 'vue';\n+import { ref, onMounted } from 'vue';\n+import { loadPaymentProvider } from '~/lib/payment-provider';\n\n const ready = ref(false);\n+\n+onMounted(async () => {\n+  // Fetch the third-party payment SDK before enabling the form.\n+  await loadPaymentProvider();\n+  ready.value = true;\n+});\n </script>`,
          },
          {
            filename: 'src/lib/payment-provider.ts',
            status: 'added',
            additions: 8,
            deletions: 0,
            patch: `@@ -0,0 +1,8 @@\n+export async function loadPaymentProvider(): Promise<void> {\n+  const s = document.createElement('script');\n+  s.src = 'https://cdn.pay.example.com/sdk.js';\n+  document.head.appendChild(s);\n+  await new Promise((resolve) => {\n+    s.onload = resolve;\n+  });\n+}`,
          },
        ],
      },
      {
        sha: 'ee12ab34cd56ef7890a1b2c3d4e5f60718293a4c',
        message: 'feat: replace the email field with a contact-method selector',
        author: 'Carol White',
        date: '2025-04-24T11:40:00Z',
        branch: 'main',
        files: [
          {
            filename: 'src/components/ContactFields.vue',
            status: 'modified',
            additions: 6,
            deletions: 3,
            patch: `@@ -2,9 +2,12 @@\n   <fieldset data-testid="email-field">\n-    <label for="checkout-email">Email address</label>\n-    <input id="checkout-email" type="email" autocomplete="email" />\n+    <label for="contact-method">Contact method</label>\n+    <select id="contact-method" data-testid="contact-method">\n+      <option value="email">Email</option>\n+      <option value="sms">Text message</option>\n+    </select>\n+    <input id="checkout-email" type="email" aria-label="Contact email" />\n   </fieldset>`,
          },
        ],
      },
      {
        sha: 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5',
        message: 'chore: bump @playwright/test to 1.52.0',
        author: 'Bob Smith',
        date: '2025-04-23T09:30:00Z',
        branch: 'main',
        files: [{ filename: 'package.json', status: 'modified', additions: 1, deletions: 1 }],
      },
      {
        sha: 'c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6',
        message: 'fix: correct discount code rounding',
        author: 'Carol White',
        date: '2025-04-22T16:05:00Z',
        branch: 'main',
        files: [{ filename: 'src/lib/cart.ts', status: 'modified', additions: 4, deletions: 2 }],
      },
      {
        sha: 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607',
        message: 'test: add Apple Pay checkout coverage',
        author: 'Alice Chen',
        date: '2025-04-21T11:20:00Z',
        branch: 'main',
        files: [{ filename: 'tests/checkout/checkout.spec.ts', status: 'modified', additions: 18, deletions: 0 }],
      },
      {
        sha: 'e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
        message: 'refactor: extract cart totals helper',
        author: 'David Lee',
        date: '2025-04-20T13:45:00Z',
        branch: 'main',
        files: [{ filename: 'src/lib/cart.ts', status: 'modified', additions: 22, deletions: 15 }],
      },
    ],
  },
  2: {
    repositoryUrl: 'https://github.com/example/shop-api',
    defaultBranch: 'main',
    branches: ['main', 'develop'],
    commits: [
      {
        sha: 'f1e2d3c4b5a6079887766554433221100ffeeddc',
        message: 'refactor: simplify auth flow',
        author: 'David Lee',
        date: '2025-04-24T10:02:00Z',
        branch: 'main',
        files: [
          {
            filename: 'src/routes/auth.ts',
            status: 'modified',
            additions: 1,
            deletions: 4,
            patch: `@@ -5,10 +5,7 @@ export async function loginHandler(req, res) {\n   const { email, password } = req.body;\n-  const user = await verifyCredentials(email, password);\n-  if (!user) {\n-    return res.status(401).json({ error: 'Invalid credentials' });\n-  }\n+  const user = await verifyCredentials(email, password);\n   const token = signSession(user.id);\n   return res.status(200).json({ token });\n }`,
          },
          {
            filename: 'src/services/credentials.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            patch: `@@ -8,7 +8,7 @@ export async function verifyCredentials(email, password) {\n   const user = await db.users.findByEmail(email);\n-  if (!user) throw new UnauthorizedError();\n+  if (!user) return null;\n   return (await bcrypt.compare(password, user.hash)) ? user : null;\n }`,
          },
        ],
      },
      {
        sha: '2837465564738291a0b1c2d3e4f5060718293a4b',
        message: 'refactor: move payment capture to an async webhook',
        author: 'Carol White',
        date: '2025-04-23T17:25:00Z',
        branch: 'main',
        files: [
          {
            filename: 'src/services/orders.ts',
            status: 'modified',
            additions: 4,
            deletions: 2,
            patch: `@@ -9,6 +9,8 @@ export async function updateOrderStatus(id, requested) {\n   const order = await db.orders.get(id);\n-  await capturePayment(order);\n-  order.status = 'confirmed';\n+  // Payment capture now happens out-of-band; the webhook advances the\n+  // order to confirmed once the provider acknowledges the charge.\n   const allowed = TRANSITIONS[order.status] ?? [];`,
          },
        ],
      },
      {
        sha: '0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d',
        message: 'feat: paginate GET /products',
        author: 'Eva Brown',
        date: '2025-04-23T15:40:00Z',
        branch: 'main',
        files: [{ filename: 'src/routes/products.ts', status: 'modified', additions: 14, deletions: 3 }],
      },
      {
        sha: '19283a4b5c6d7e8f90a1b2c3d4e5f60718293a4b',
        message: 'chore: upgrade postgres driver',
        author: 'Bob Smith',
        date: '2025-04-22T08:15:00Z',
        branch: 'main',
        files: [{ filename: 'package.json', status: 'modified', additions: 1, deletions: 1 }],
      },
    ],
  },
  3: {
    repositoryUrl: 'https://github.com/example/design-system',
    defaultBranch: 'main',
    branches: ['main', 'feature/new-ui'],
    commits: [
      {
        sha: '3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d',
        message: 'feat: showcase all button variants on demo page',
        author: 'Carol White',
        date: '2025-04-24T09:50:00Z',
        branch: 'feature/new-ui',
        files: [
          {
            filename: 'src/pages/components/button.vue',
            status: 'modified',
            additions: 2,
            deletions: 0,
            patch: `@@ -2,5 +2,7 @@\n   <section class="button-gallery">\n     <AppButton variant="primary">Primary</AppButton>\n+    <AppButton variant="secondary" disabled>Disabled</AppButton>\n+    <AppButton variant="secondary" loading>Loading…</AppButton>\n   </section>`,
          },
        ],
      },
      {
        sha: '5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f',
        message: 'refactor: teleport the modal to document.body',
        author: 'David Lee',
        date: '2025-04-23T10:10:00Z',
        branch: 'main',
        files: [
          {
            filename: 'src/components/modal-controller.ts',
            status: 'modified',
            additions: 2,
            deletions: 3,
            patch: `@@ -1,8 +1,7 @@\n export class ModalController {\n   constructor(root) {\n     this.root = root;\n-    this.trap = createFocusTrap(root);\n+    // The focus trap is created lazily on first open() since the teleport\n+    // target may not be mounted yet.\n   }`,
          },
        ],
      },
      {
        sha: '4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e',
        message: 'style: tune focus ring tokens',
        author: 'Alice Chen',
        date: '2025-04-22T14:25:00Z',
        branch: 'main',
        files: [{ filename: 'src/tokens/focus.css', status: 'modified', additions: 3, deletions: 3 }],
      },
    ],
  },
  4: {
    repositoryUrl: 'https://github.com/example/mobile-web',
    defaultBranch: 'main',
    branches: ['main', 'develop'],
    commits: [
      {
        sha: '6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        message: 'feat: add full-bleed hero image to landing page',
        author: 'Eva Brown',
        date: '2025-04-22T17:30:00Z',
        branch: 'main',
        files: [
          {
            filename: 'src/pages/index.vue',
            status: 'modified',
            additions: 5,
            deletions: 0,
            patch: `@@ -1,6 +1,11 @@\n <template>\n   <main>\n+    <img\n+      src="/hero-4k.png"\n+      alt="Hero"\n+      class="hero"\n+    />\n     <Nav />`,
          },
        ],
      },
      {
        sha: '8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2',
        message: 'feat: add a signature pad to the delivery form',
        author: 'Carol White',
        date: '2025-04-21T11:45:00Z',
        branch: 'main',
        files: [
          {
            filename: 'src/lib/signature-pad.ts',
            status: 'added',
            additions: 10,
            deletions: 0,
            patch: `@@ -0,0 +1,10 @@\n+const DPR = window.devicePixelRatio || 1;\n+\n+export function mountSignaturePad(canvas) {\n+  canvas.width = window.innerWidth * DPR;\n+  canvas.height = document.body.scrollHeight * DPR;\n+  return canvas.getContext('2d');\n+}`,
          },
        ],
      },
      {
        sha: '7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
        message: 'chore: enable Safari 17 in CI matrix',
        author: 'Bob Smith',
        date: '2025-04-18T09:05:00Z',
        branch: 'main',
        files: [{ filename: '.github/workflows/ci.yml', status: 'modified', additions: 2, deletions: 0 }],
      },
    ],
  },
  5: {
    repositoryUrl: 'https://github.com/example/admin-dashboard',
    defaultBranch: 'main',
    branches: ['main', 'develop'],
    commits: [
      {
        sha: '9a8b7c6d5e4f30211203f4e5d6c7b8a99a8b7c6d',
        message: 'style: dark theme pass over secondary actions',
        author: 'Alice Chen',
        date: '2025-04-24T15:05:00Z',
        branch: 'main',
        files: [
          {
            filename: 'src/styles/theme.css',
            status: 'modified',
            additions: 6,
            deletions: 0,
            patch: `@@ -3,3 +3,9 @@\n   background: var(--surface-raised);\n }\n+\n+@media (prefers-color-scheme: dark) {\n+  .export-btn {\n+    visibility: hidden;\n+  }\n+}`,
          },
        ],
      },
      {
        sha: 'b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6',
        message: 'chore: bump @playwright/test to 1.52.0',
        author: 'Bob Smith',
        date: '2025-04-24T09:00:00Z',
        branch: 'main',
        files: [{ filename: 'package.json', status: 'modified', additions: 1, deletions: 1 }],
      },
      {
        sha: 'c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7',
        message: 'feat: server-driven pagination for the users table',
        author: 'Eva Brown',
        date: '2025-04-23T13:20:00Z',
        branch: 'main',
        files: [
          {
            filename: USERS_ENDPOINTS_PATH,
            status: 'modified',
            additions: USERS_PAGINATION_EDITS.reduce((n, edit) => n + (edit.add?.length ?? 0), 0),
            deletions: USERS_PAGINATION_EDITS.reduce((n, edit) => n + (edit.remove ?? 0), 0),
            patch: USERS_PAGINATION_PATCH,
            blob: USERS_ENDPOINTS_BLOB,
          },
        ],
      },
      {
        sha: 'd5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708',
        message: 'feat: add CSV export to monthly reports',
        author: 'Carol White',
        date: '2025-04-22T10:30:00Z',
        branch: 'main',
        files: [{ filename: 'src/pages/reports/monthly.vue', status: 'modified', additions: 24, deletions: 2 }],
      },
      {
        sha: 'e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70819',
        message: 'fix: chart tooltip overflow on narrow screens',
        author: 'David Lee',
        date: '2025-04-21T16:10:00Z',
        branch: 'main',
        files: [{ filename: 'src/components/RevenueChart.vue', status: 'modified', additions: 6, deletions: 3 }],
      },
    ],
  },
};

/** All authored source files for a project (specs + app files its stories touch). */
export function projectSourceFilePaths(projectId) {
  const paths = new Set();
  for (const c of DEMO_PROJECTS.find((p) => p.id === projectId)?.cases ?? []) {
    if (SOURCE_FILES[c.file]) paths.add(c.file);
  }
  for (const s of FAILURE_STORIES) {
    if (s.projectId !== projectId) continue;
    paths.add(s.specFile);
    for (const f of s.appFiles) paths.add(f);
    for (const fc of s.failingCases) for (const fr of fc.frames) if (SOURCE_FILES[fr.file]) paths.add(fr.file);
  }
  return [...paths];
}
