/**
 * check-demo-runtime.mjs
 *
 * Runs the *built* demo SPA the way GitHub Pages serves it — from a sub-path,
 * with its service worker installed — and exercises the flows that only exist
 * once it is running.
 *
 * `app:generate:demo` proves the demo compiles and `check-demo-routes.mjs`
 * proves every server route has a demo handler, but neither loads the page.
 * A demo whose links escape the service worker's scope, whose worker fails to
 * install, or whose handlers throw passes both and is still completely broken.
 *
 * Run from the `application/` directory, after `npm run app:generate:demo`:
 *   node scripts/check-demo-runtime.mjs
 *
 * Flags, to check guide anchors while adding them:
 *   --url <base>         drive a running server (`--url http://localhost:3000`)
 *                        instead of serving the built demo. Only the anchor
 *                        checks run, and an anchor whose sample acts as a
 *                        persona or that needs the demo build is skipped, as
 *                        authentication is off on a dev server.
 *   --anchors <id,id,…>  check only these anchors.
 *   --area <name>        check only the anchors of this area file of
 *                        `shared/guide-anchors/` (`layout`, `runs`, …); with
 *                        --anchors, the anchors either names.
 *   --anchors-only       skip the guided tours, the authored guides and the
 *                        other checks.
 *   --desktop            check the anchors whose sample is in the desktop app
 *                        (`sample.surface: 'desktop'`), which every other run
 *                        skips, in the screenshot harness's desktop mode: a
 *                        dev server started with NUXT_PUBLIC_DESKTOP=true on a
 *                        throwaway copy of the demo seed, booted on port 3050
 *                        for the run, and its mocked Tauri bridge with a
 *                        linked folder. With --url, the server it names (one
 *                        started with NUXT_PUBLIC_DESKTOP=true and the demo's
 *                        seeded ids).
 *
 * Exits non-zero on the first failed check.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { GUIDE_ANCHOR_BY_ID, GUIDE_ANCHORS, GUIDE_AREAS } from '../shared/guide-anchors/index.mjs';
import { waitForHydration } from './lib/page-waits.mjs';
import { READY_INSPECTION, bridgeScript } from './lib/desktop-bridge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '.output', 'public');
const PORT = Number(process.env.DEMO_CHECK_PORT || 4173);

const { values: flags } = parseArgs({
  options: {
    url: { type: 'string' },
    anchors: { type: 'string' },
    area: { type: 'string' },
    'anchors-only': { type: 'boolean', default: false },
    desktop: { type: 'boolean', default: false },
  },
});

/** Where `--desktop` boots its server without `--url`: off 3000, where a dev server may run. */
const DESKTOP_PORT = 3050;
/** The running server to drive: `--url`, else the one `--desktop` boots; null to serve the built demo. */
const SERVER = flags.url ? new URL(flags.url) : flags.desktop ? new URL(`http://localhost:${DESKTOP_PORT}`) : null;
/** Where the anchors this run checks have their sample (`sample.surface`). */
const SURFACE = flags.desktop ? 'desktop' : 'demo';
const ANCHORS_ONLY = flags['anchors-only'] || SERVER !== null;

// The demo is deployed under /demo/, and that base path is exactly what the
// service worker scopes itself to — serving it at the root would hide the class
// of bug this check exists to catch.
const BASE = SERVER ? SERVER.pathname.replace(/\/?$/, '/') : '/demo/';
const ORIGIN = SERVER ? SERVER.origin : `http://localhost:${PORT}`;

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.sql': 'text/plain',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const failures = [];
function check(ok, label, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const path = decodeURIComponent(req.url.split('?')[0]);
      if (!path.startsWith(BASE)) {
        res.writeHead(404).end('outside the demo base path');
        return;
      }
      let file = join(ROOT, path.slice(BASE.length) || 'index.html');
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      } catch {
        // Deep links have no static file; the SPA shell resolves them client-side.
        file = join(ROOT, 'index.html');
      }
      try {
        const data = await readFile(file);
        res.writeHead(200, {
          'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
          'Service-Worker-Allowed': BASE,
        });
        res.end(data);
      } catch {
        // Headers are only written once the read succeeds, so a missing file
        // can still answer 404 (on Windows a read can fail after a successful
        // stat, e.g. a locked file, and a second writeHead would crash the server).
        if (!res.headersSent) res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(PORT, () => resolve(server));
  });
}

/** Wait until the service worker controls the page, reloading once if needed. */
async function waitForServiceWorker(page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (let i = 0; i < 30; i++) {
      if (await page.evaluate(() => Boolean(navigator.serviceWorker?.controller))) return true;
      await page.waitForTimeout(1000);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  return false;
}

// ── The guided tour ────────────────────────────────────────────────────────
// The demo build switches the tour on. Everything below reads the tour as it
// renders (the popover's data attributes), never the registry it is built from.

/** A tour's popover once its stop is fully shown: cutout on the target, popover in place. */
const TOUR_SETTLED = '.driver-popover.piwi-guide[data-guide-settled]';
/** The prompt opens 1.5 s after the demo is ready; this long after the page shows its data, it would be open. */
const PROMPT_DELAY_MS = 3000;
const WIDE = { width: 1280, height: 860 };
const PHONE = { width: 390, height: 844 };

/** What this browser stored about the prompt (`snoozed`, `dismissed`, `started`), or null. */
function storedTourDecision(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('piwi-demo-tour') ?? '{}').decision ?? null;
    } catch {
      return null;
    }
  });
}

/** Waits for the home page's data, then as long as the prompt takes to open by itself; true when it opened. */
async function promptOpensBySelf(page) {
  await page.locator('[data-cluster-row]').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(PROMPT_DELAY_MS);
  return page.getByTestId('tour-prompt').isVisible();
}

/** Opens the prompt from the banner, picks `language` when given, and starts the `profile` tour. */
async function startTour(page, profile, language) {
  await page.getByTestId('tour-launch').click();
  await page.getByTestId('tour-prompt').waitFor({ timeout: 10000 });
  if (language) {
    await page.getByTestId('tour-language').click();
    await page.getByRole('option', { name: language }).click();
  }
  await page.getByTestId(`tour-profile-${profile}`).click();
}

/**
 * Walks the tour that is starting with Next until Done. Each stop must show
 * its anchor highlighted and in view (a stop shown centered fails: every stop
 * has an anchor), a title, progress one further, the popover in `lang`, and
 * with `inViewport`, the popover entirely on screen. Then Done must end it.
 */
async function walkTour(page, profile, { lang = 'en', inViewport = false } = {}) {
  let shown = 0;
  let total = 0;
  let last = null;
  // A tour has at most 7 stops; the bound only stops a broken one from looping.
  for (let step = 0; step < 10; step++) {
    const popover = page.locator(last ? `${TOUR_SETTLED}:not([data-guide-stop="${last}"])` : TOUR_SETTLED);
    await popover.waitFor({ timeout: 60000 });
    const stop = await popover.evaluate((node) => {
      const anchor = node.dataset.guideAnchor ?? '';
      const element = anchor ? document.querySelector(`.driver-active-element[data-tour="${anchor}"]`) : null;
      const box = element?.getBoundingClientRect();
      const own = node.getBoundingClientRect();
      return {
        id: node.dataset.guideStop ?? '',
        profile: node.dataset.tourProfile ?? '',
        anchor,
        lang: node.lang,
        title: node.querySelector('.driver-popover-title')?.textContent?.trim() ?? '',
        progress: node.querySelector('.driver-popover-progress-text')?.textContent?.trim() ?? '',
        highlighted: Boolean(
          box && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.left < innerWidth,
        ),
        onScreen: own.left >= 0 && own.top >= 0 && own.right <= innerWidth && own.bottom <= innerHeight,
        last: Boolean(node.querySelector('.driver-popover-done-btn')),
      };
    });
    const [current, of] = (stop.progress.match(/\d+/g) ?? []).map(Number);
    total ||= of;
    const problems = [];
    if (stop.profile !== profile) problems.push(`the ${stop.profile} tour's popover`);
    if (!stop.anchor) problems.push('shown centered, with no anchor');
    else if (!stop.highlighted) problems.push(`"${stop.anchor}" is not highlighted in view`);
    if (!stop.title) problems.push('no title');
    if (current !== shown + 1 || of !== total) problems.push(`progress "${stop.progress}"`);
    if (stop.lang !== lang) problems.push(`lang "${stop.lang}"`);
    if (inViewport && !stop.onScreen) problems.push('the popover leaves the viewport');
    check(
      problems.length === 0,
      `${profile} tour ${stop.progress}: ${stop.id} → ${stop.anchor || '(centered)'}`,
      problems.join('; '),
    );
    shown = current;
    last = stop.id;
    if (stop.last || shown >= total) break;
    await popover.locator('.driver-popover-next-btn').click();
  }
  await page.locator('.driver-popover-done-btn').click();
  await page
    .locator('.driver-popover')
    .waitFor({ state: 'detached', timeout: 10000 })
    .catch(() => {});
  const ended = await page.evaluate(
    () => !document.querySelector('.driver-popover') && !document.body.classList.contains('driver-active'),
  );
  check(
    ended && shown === total,
    `the ${profile} tour ends on Done after its ${total} stops`,
    shown !== total ? `${shown} shown` : ended ? '' : 'the popover is still up',
  );
}

/**
 * The prompt on a first visit, Later and × each keeping it away on a reload,
 * the banner's Guided tour button reopening it, then every role's tour from
 * that button: one in French, one at phone width. `watch` attaches the
 * checks every page of the demo gets (escaped API calls, page errors).
 */
async function checkGuidedTour(browser, watch) {
  const context = await browser.newContext({ viewport: WIDE, locale: 'en-US' });
  const page = await context.newPage();
  watch(page);
  try {
    await page.goto(`${ORIGIN}${BASE}`, { waitUntil: 'domcontentloaded' });
    const prompt = page.getByTestId('tour-prompt');
    await prompt.waitFor({ timeout: 60000 }).catch(() => {});
    const roles = await prompt.locator('[data-testid^="tour-profile-"]').count();
    check(roles === 4, 'a first visit gets the guided tour prompt, listing 4 roles', `${roles} roles`);

    await page.getByTestId('tour-later').click();
    await prompt.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    check((await storedTourDecision(page)) === 'snoozed', 'Later closes the prompt and asks again later');
    await page.reload({ waitUntil: 'domcontentloaded' });
    check(!(await promptOpensBySelf(page)), 'after Later, a reload does not open the prompt');

    await page.getByTestId('tour-launch').click();
    check(
      await prompt.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      ),
      'the banner’s Guided tour button reopens the prompt',
    );
    await page.getByTestId('tour-dismiss').click();
    await prompt.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    check((await storedTourDecision(page)) === 'dismissed', '× closes the prompt for good');
    await page.reload({ waitUntil: 'domcontentloaded' });
    check(!(await promptOpensBySelf(page)), 'after ×, a reload does not open the prompt');

    await startTour(page, 'developer');
    await walkTour(page, 'developer');

    await page.setViewportSize(PHONE);
    await startTour(page, 'qa');
    await walkTour(page, 'qa', { inViewport: true });
    await page.setViewportSize(WIDE);

    await startTour(page, 'product');
    await walkTour(page, 'product');

    await startTour(page, 'platform', 'Français');
    await walkTour(page, 'platform', { lang: 'fr' });
  } catch (error) {
    check(false, 'the guided tour checks completed', String(error).split('\n')[0].slice(0, 160));
  } finally {
    await context.close();
  }
}

// ── The authored guides ────────────────────────────────────────────────────
// Every authored guide (`app/utils/guides/guides.ts`), started from the command
// palette as a user starts one, on the stops it finds in the seed. Like the
// tours above, everything reads the guide as it renders, but for the list of
// guides, which the assistant panel shows and the source must match.

/** The authored guides' ids, from their source: each guide's `id` sits four spaces in. */
function authoredGuideIds() {
  const source = readFileSync(join(__dirname, '..', 'app', 'utils', 'guides', 'guides.ts'), 'utf8');
  return [...source.matchAll(/^ {4}id: '([a-z0-9-]+)',$/gm)].map((match) => match[1]);
}

/** How long a stop's anchor has to come into view once its popover settled: content may still load above it. */
const IN_VIEW_WAIT_MS = 5000;

/** The authored guides the assistant panel lists, as `{ id, title }`, in its order. */
async function listedGuides(page) {
  const launcher = page.getByRole('button', { name: 'Ask Piwi' });
  if (!(await launcher.isVisible())) await page.getByRole('button', { name: 'Open sidebar' }).first().click();
  await launcher.click();
  const panel = page.getByRole('dialog', { name: 'Ask Piwi' });
  await panel.locator('[data-guide-list]').waitFor({ timeout: 30000 });
  const guides = await panel.locator('[data-guide-id]').evaluateAll((buttons) =>
    buttons.map((button) => ({
      id: button.dataset.guideId,
      title: button.querySelector('span span')?.textContent?.trim() ?? '',
    })),
  );
  // In the demo, the panel's header sits under the demo banner: Escape closes it.
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden', timeout: 10000 });
  return guides;
}

/** Opens the command palette with its shortcut, types `title` and picks the guide it finds first. */
async function startGuideFromPalette(page, title) {
  await page.keyboard.press('Control+KeyK');
  const input = page.getByPlaceholder('Type a command or search…');
  await input.waitFor({ timeout: 10000 });
  await input.fill(title);
  const guides = page.getByRole('group', { name: 'Guides' });
  await guides.getByRole('option').first().filter({ hasText: title }).waitFor({ timeout: 10000 });
  // The palette filters as you type; let the list settle before picking from it.
  await page.waitForTimeout(300);
  await guides.getByRole('option').first().click();
}

/**
 * Walks the authored guide `id` that is starting with Next until Done. Each
 * stop must show its anchor highlighted and in view (a stop shown centered
 * fails: every resolver finds its entity in the seed), a title, progress one
 * further, and with `inViewport`, the popover entirely on screen. Then Done
 * must end it.
 */
async function walkAuthoredGuide(page, id, { inViewport = false } = {}) {
  let shown = 0;
  let total = 0;
  let last = null;
  // A guide has at most 7 stops; the bound only stops a broken one from looping.
  for (let step = 0; step < 10; step++) {
    const selector = last ? `${TOUR_SETTLED}:not([data-guide-stop="${last}"])` : TOUR_SETTLED;
    const popover = page.locator(selector);
    await popover.waitFor({ timeout: 60000 });
    await page
      .waitForFunction(
        (sel) => {
          const anchor = document.querySelector(sel)?.dataset.guideAnchor;
          const box =
            anchor && document.querySelector(`.driver-active-element[data-tour="${anchor}"]`)?.getBoundingClientRect();
          return !anchor || (box && box.bottom > 0 && box.top < innerHeight);
        },
        selector,
        { timeout: IN_VIEW_WAIT_MS },
      )
      .catch(() => {});
    const stop = await popover.evaluate((node) => {
      const anchor = node.dataset.guideAnchor ?? '';
      const element = anchor ? document.querySelector(`.driver-active-element[data-tour="${anchor}"]`) : null;
      const box = element?.getBoundingClientRect();
      const own = node.getBoundingClientRect();
      return {
        id: node.dataset.guideStop ?? '',
        guide: node.dataset.guide ?? '',
        anchor,
        note: node.querySelector('.piwi-guide-note')?.textContent?.trim() ?? '',
        title: node.querySelector('.driver-popover-title')?.textContent?.trim() ?? '',
        progress: node.querySelector('.driver-popover-progress-text')?.textContent?.trim() ?? '',
        highlighted: Boolean(
          box && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.left < innerWidth,
        ),
        onScreen: own.left >= 0 && own.top >= 0 && own.right <= innerWidth && own.bottom <= innerHeight,
        last: Boolean(node.querySelector('.driver-popover-done-btn')),
      };
    });
    const [current, of] = (stop.progress.match(/\d+/g) ?? []).map(Number);
    total ||= of;
    const problems = [];
    if (stop.guide !== `guide-${id}`) problems.push(`the ${stop.guide} guide's popover`);
    if (!stop.anchor) problems.push(`shown centered${stop.note ? ` (${stop.note})` : ''}`);
    else if (!stop.highlighted) problems.push(`"${stop.anchor}" is not highlighted in view`);
    if (!stop.title) problems.push('no title');
    if (current !== shown + 1 || of !== total) problems.push(`progress "${stop.progress}"`);
    if (inViewport && !stop.onScreen) problems.push('the popover leaves the viewport');
    check(
      problems.length === 0,
      `${id} guide ${stop.progress}: ${stop.id} → ${stop.anchor || '(centered)'}`,
      problems.join('; '),
    );
    shown = current;
    last = stop.id;
    if (stop.last || shown >= total) break;
    await popover.locator('.driver-popover-next-btn').click();
  }
  await page.locator('.driver-popover-done-btn').click();
  await page
    .locator('.driver-popover')
    .waitFor({ state: 'detached', timeout: 10000 })
    .catch(() => {});
  const ended = await page.evaluate(
    () => !document.querySelector('.driver-popover') && !document.body.classList.contains('driver-active'),
  );
  check(
    ended && shown === total,
    `the ${id} guide ends on Done after its ${total} stops`,
    shown !== total ? `${shown} shown` : ended ? '' : 'the popover is still up',
  );
}

/**
 * Every authored guide, as the demo's default persona (an administrator, who
 * is offered all of them): the assistant panel lists each guide of the source,
 * and each one started from the palette walks its stops; one again at phone
 * width. `watch` attaches the checks every page of the demo gets.
 */
async function checkAuthoredGuides(browser, watch) {
  const context = await browser.newContext({ viewport: WIDE, locale: 'en-US' });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('piwi-demo-tour', JSON.stringify({ decision: 'dismissed', decidedAt: Date.now() }));
  });
  const page = await context.newPage();
  watch(page);
  try {
    await page.goto(`${ORIGIN}${BASE}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-cluster-row]').first().waitFor({ timeout: 60000 });
    const guides = await listedGuides(page);
    const sourceIds = authoredGuideIds();
    const missing = sourceIds.filter((id) => !guides.some((guide) => guide.id === id));
    check(
      sourceIds.length > 0 && missing.length === 0,
      `the assistant panel lists the ${sourceIds.length} authored guides`,
      missing.length ? `missing ${missing.join(', ')}` : '',
    );
    for (const guide of guides) {
      await startGuideFromPalette(page, guide.title);
      await walkAuthoredGuide(page, guide.id);
    }
    const phoneGuide = guides.find((guide) => guide.id === 'run-flake-lab');
    if (check(Boolean(phoneGuide), 'the run-flake-lab guide is listed, for the phone walk')) {
      await page.setViewportSize(PHONE);
      await startGuideFromPalette(page, phoneGuide.title);
      await walkAuthoredGuide(page, phoneGuide.id, { inViewport: true });
    }
  } catch (error) {
    check(false, 'the authored guide checks completed', String(error).split('\n')[0].slice(0, 160));
  } finally {
    await context.close();
  }
}

// ── The guide anchors ──────────────────────────────────────────────────────
// Every anchor of the guide registry (`shared/guide-anchors/`) whose sample is
// on the demo, opened at its sample route as its persona, its reveal clicked as
// the guide engine clicks it, then found visible once scrolled into view. Each
// persona gets its own browser and each route loads once, again after an
// anchor whose reveal opened a menu or a modal.

/** The toggle of a folded section, which an `unfold` step names and the guide engine clicks (`useGuide`). */
const FOLDED_TOGGLE = 'button[aria-expanded="false"], [role="button"][aria-expanded="false"]';
/** How long an anchor, or the element its reveal clicks, has to render once its page loads. */
const ANCHOR_WAIT_MS = 60000;

/** The anchors `--anchors` and `--area` name, every anchor when neither is given; exits on an unknown one. */
function selectedAnchors() {
  if (!flags.anchors && !flags.area) return GUIDE_ANCHORS;
  const ids = new Set(
    (flags.anchors ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const unknown = [...ids].filter((id) => !GUIDE_ANCHOR_BY_ID.has(id));
  const area = flags.area ? GUIDE_AREAS.find(({ id }) => id === flags.area) : null;
  if (unknown.length > 0 || area === undefined) {
    if (unknown.length > 0) console.error(`No guide anchor named ${unknown.join(', ')}.`);
    if (area === undefined) {
      console.error(`No area "${flags.area}": one of ${GUIDE_AREAS.map(({ id }) => id).join(', ')}.`);
    }
    process.exit(1);
  }
  return GUIDE_ANCHORS.filter((anchor) => ids.has(anchor.id) || area?.anchors.includes(anchor));
}

/** Why a running server cannot show `anchor` (`--url`), or null when it can. */
function skippedOnServer(anchor) {
  if (!SERVER) return null;
  if (anchor.requires?.demo) return 'needs the demo build';
  if (anchor.sample.persona !== undefined) return `acts as persona ${anchor.sample.persona}`;
  return null;
}

/** `anchors` by persona (null: the default one), then by sample route, in registry order. */
function anchorsBySample(anchors) {
  const personas = new Map();
  for (const anchor of anchors) {
    if ((anchor.sample.surface ?? 'demo') !== SURFACE) {
      if (SURFACE === 'demo')
        console.log(`  – guide anchor ${anchor.id} skipped: its sample is in the desktop app (--desktop)`);
      continue;
    }
    const skipped = skippedOnServer(anchor);
    if (skipped) {
      console.log(`  – guide anchor ${anchor.id} skipped: it ${skipped}`);
      continue;
    }
    const persona = anchor.sample.persona ?? null;
    const routes = personas.get(persona) ?? new Map();
    personas.set(persona, routes);
    routes.set(anchor.sample.route, [...(routes.get(anchor.sample.route) ?? []), anchor]);
  }
  return personas;
}

/** Runs the `unfold` and `open` steps of `anchor`'s reveal, in order, as the engine does. */
async function revealAnchor(page, anchor) {
  for (const step of anchor.reveal ?? []) {
    if ('unfold' in step) {
      const toggle = page.locator(`[data-tour="${step.unfold}"]`).first();
      await toggle.waitFor({ state: 'attached', timeout: ANCHOR_WAIT_MS });
      await toggle.evaluate((node, folded) => {
        if (node instanceof HTMLElement && node.matches(folded)) node.click();
      }, FOLDED_TOGGLE);
    }
    if ('open' in step) {
      const opener = page.locator(`[data-tour="${step.open}"]`).first();
      await opener.waitFor({ timeout: ANCHOR_WAIT_MS });
      if ((await page.locator(`[data-tour="${anchor.id}"]`).count()) === 0) await opener.click();
    }
  }
}

/** How long an anchor that is fading in has to stop being fully transparent. */
const OPAQUE_WAIT_MS = 3000;

/**
 * Whether `element` is not fully transparent: neither it nor an element
 * holding it has a computed opacity of 0 (a control shown only while the
 * pointer is over its row), which Playwright's visibility ignores.
 */
async function becomesOpaque(page, element) {
  const opaque = (node) => {
    for (let n = node; n; n = n.parentElement) if (getComputedStyle(n).opacity === '0') return false;
    return true;
  };
  const handle = await element.elementHandle();
  return page.waitForFunction(opaque, handle, { timeout: OPAQUE_WAIT_MS }).then(
    () => true,
    () => false,
  );
}

/** One check: `anchor` renders at its sample, visible and not transparent, with a box in the viewport once scrolled into view. */
async function checkAnchor(page, anchor) {
  const label = `guide anchor ${anchor.id} shows at ${anchor.sample.route}`;
  try {
    await revealAnchor(page, anchor);
    const element = page.locator(`[data-tour="${anchor.id}"]`).first();
    await element.waitFor({ state: 'attached', timeout: ANCHOR_WAIT_MS });
    await element.scrollIntoViewIfNeeded({ timeout: 10000 });
    const box = await element.boundingBox();
    const visible = await element.isVisible();
    const opaque = visible && (await becomesOpaque(page, element));
    const inView = box !== null && box.width > 0 && box.height > 0 && box.y < WIDE.height && box.y + box.height > 0;
    const where = box ? `a ${Math.round(box.width)}×${Math.round(box.height)} box at y ${Math.round(box.y)}` : 'no box';
    const problem = !visible ? 'not visible' : !opaque ? 'fully transparent (opacity 0)' : inView ? '' : where;
    check(problem === '', label, problem);
  } catch (error) {
    check(false, label, String(error).split('\n')[0].slice(0, 160));
  }
}

/**
 * Each of `anchors` at its sample: one browser context per persona, which
 * stores that persona as the demo's "Acting as" user and the tour's prompt as
 * dismissed before any page loads. `watch` attaches the checks every page of
 * the demo gets. Returns how many anchors it checked.
 */
async function checkGuideAnchors(browser, watch, anchors) {
  let checked = 0;
  for (const [persona, routes] of anchorsBySample(anchors)) {
    const context = await browser.newContext({ viewport: WIDE, locale: 'en-US' });
    await context.addInitScript((id) => {
      // The page itself only: a sandboxed frame (a DOM snapshot) may not touch storage.
      if (window !== window.top) return;
      if (id === null) localStorage.removeItem('piwi-demo-user-id');
      else localStorage.setItem('piwi-demo-user-id', String(id));
      localStorage.setItem('piwi-demo-tour', JSON.stringify({ decision: 'dismissed', decidedAt: Date.now() }));
    }, persona);
    if (SURFACE === 'desktop') {
      await context.addInitScript(bridgeScript({ link: { path: READY_INSPECTION.path, exists: true } }));
    }
    const page = await context.newPage();
    // A dev server compiles each page on its first visit.
    if (SERVER) page.setDefaultNavigationTimeout(90_000);
    watch(page);
    try {
      for (const [route, anchors] of routes) {
        let loaded = false;
        for (const anchor of anchors) {
          if (!loaded) {
            await page.goto(`${ORIGIN}${BASE}${route.replace(/^\//, '')}`, { waitUntil: 'domcontentloaded' });
            // A server renders the page before it hydrates; the demo renders it in the browser.
            if (SERVER) await waitForHydration(page);
          }
          await checkAnchor(page, anchor);
          checked++;
          // What an `open` step opened stays open over the page.
          loaded = !anchor.reveal?.some((step) => 'open' in step);
        }
      }
    } finally {
      await context.close();
    }
  }
  return checked;
}

// ── The demo's flows ───────────────────────────────────────────────────────

/**
 * The demo's own flows, on `page`: the service worker, the in-browser API, the
 * exports, the quality report, the report snapshots, the saved dashboards, the
 * flake profile and the Flake Lab, and a file's coverage page.
 */
async function checkDemoFlows(page) {
  await page.goto(`${ORIGIN}${BASE}`, { waitUntil: 'domcontentloaded' });
  check(await waitForServiceWorker(page), 'the service worker installs and takes control');

  // The in-browser API must answer under the demo's own base path.
  const menu = await page.evaluate(async () => {
    const r = await fetch('/demo/api/projects/menu');
    return { status: r.status, count: r.ok ? ((await r.json())?.items?.length ?? 0) : 0 };
  });
  check(menu.status === 200, 'the in-browser API answers', `status ${menu.status}`);
  check(menu.count > 0, 'the seeded database has projects', `${menu.count} projects`);

  // Find a cluster to export, rather than hard-coding an id the seed may move.
  const clusterId = await page.evaluate(async () => {
    const menu = await (await fetch('/demo/api/projects/menu')).json();
    for (const p of menu.items ?? []) {
      const clusters = await (await fetch(`/demo/api/projects/${p.id}/failure-clusters`)).json();
      const first = (Array.isArray(clusters) ? clusters : (clusters?.items ?? []))[0];
      if (first?.id) return first.id;
    }
    return null;
  });
  if (!check(clusterId != null, 'the seed contains a failure cluster to export')) throw new Error('no cluster');

  await page.goto(`${ORIGIN}${BASE}failure-clusters/${clusterId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const exportButton = page.getByRole('button', { name: 'Export', exact: true });
  if (!check((await exportButton.count()) === 1, 'exactly one Export button is on the page')) {
    throw new Error(`found ${await exportButton.count()} Export buttons`);
  }

  // The download itself is the point: a root-relative URL would escape the
  // service worker's scope and 404 against the static host.
  await exportButton.click();
  await page.waitForTimeout(400);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: 'ZIP — with all evidence', exact: true }).click(),
  ]);
  const path = await download.path();
  const bytes = path ? (await readFile(path)).length : 0;
  check(bytes > 1000, 'the ZIP export downloads', `${bytes} bytes as ${download.suggestedFilename()}`);
  check(download.suggestedFilename().endsWith('.zip'), 'the download is named as a ZIP');

  // The PDF is generated the same way — entirely in the service worker, with
  // no browser print — so prove it produces a real %PDF document in-browser.
  await exportButton.click();
  await page.waitForTimeout(400);
  const [pdfDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: 'PDF — formatted document', exact: true }).click(),
  ]);
  const pdfPath = await pdfDownload.path();
  const pdfBytes = pdfPath ? await readFile(pdfPath) : Buffer.alloc(0);
  check(
    pdfBytes.length > 1000,
    'the PDF export downloads',
    `${pdfBytes.length} bytes as ${pdfDownload.suggestedFilename()}`,
  );
  check(pdfDownload.suggestedFilename().endsWith('.pdf'), 'the download is named as a PDF');
  check(pdfBytes.subarray(0, 5).toString('latin1') === '%PDF-', 'the PDF is a real vector document');

  // The analytics page is the Overview dashboard; its Export previews a quality
  // report built in the service worker and downloads it as a PDF.
  await page.goto(`${ORIGIN}${BASE}analytics`, { waitUntil: 'domcontentloaded' });
  const tile = page.getByTestId('stat-test-pass-rate');
  await tile.waitFor({ timeout: 60000 }).catch(() => {});
  check(await tile.isVisible(), 'the analytics page shows the headline tiles');
  const preview = page.getByTestId('report-view');
  for (let attempt = 0; attempt < 20 && !(await preview.isVisible()); attempt++) {
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    await preview.waitFor({ timeout: 3000 }).catch(() => {});
  }
  check(await preview.isVisible(), 'Export previews the quality report');
  await page.getByTestId('report-download').click();
  const [reportPdf] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('menuitem', { name: 'PDF' }).click(),
  ]);
  const reportPath = await reportPdf.path();
  const reportBytes = reportPath ? await readFile(reportPath) : Buffer.alloc(0);
  check(
    reportBytes.subarray(0, 5).toString('latin1') === '%PDF-',
    'the quality report downloads as a PDF',
    `${reportBytes.length} bytes as ${reportPdf.suggestedFilename()}`,
  );

  // The same report as an Excel workbook, built in the service worker, and one
  // section's workbook, built in the page: both are ZIP archives (`PK`).
  await page.getByTestId('report-download').click();
  const [reportXlsx] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('menuitem', { name: 'Excel' }).click(),
  ]);
  const xlsxPath = await reportXlsx.path();
  const xlsxBytes = xlsxPath ? await readFile(xlsxPath) : Buffer.alloc(0);
  check(
    xlsxBytes.subarray(0, 2).toString('latin1') === 'PK' && reportXlsx.suggestedFilename().endsWith('.xlsx'),
    'the quality report downloads as an Excel workbook',
    `${xlsxBytes.length} bytes as ${reportXlsx.suggestedFilename()}`,
  );
  const [sectionXlsx] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    preview.locator('[data-testid^="report-section-xlsx-"]').first().click(),
  ]);
  const sectionPath = await sectionXlsx.path();
  const sectionBytes = sectionPath ? await readFile(sectionPath) : Buffer.alloc(0);
  check(
    sectionBytes.subarray(0, 2).toString('latin1') === 'PK',
    'a report section downloads as its own Excel workbook',
    `${sectionBytes.length} bytes as ${sectionXlsx.suggestedFilename()}`,
  );

  // The Reports page lists the two report snapshots the demo seeds when its
  // database opens, and one opens on its own page.
  await page.goto(`${ORIGIN}${BASE}reports`, { waitUntil: 'domcontentloaded' });
  const snapshots = page.getByTestId('snapshot-list').locator('li');
  await snapshots
    .first()
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  check(
    (await snapshots.count()) === 2,
    'the Reports page lists the two seeded snapshots',
    `${await snapshots.count()}`,
  );
  check(await page.getByTestId('schedule-list').isVisible(), 'the Reports page lists the seeded schedule');
  await page.getByTestId('snapshot-list').getByRole('link').first().click();
  const snapshotView = page.getByTestId('report-view');
  await snapshotView.waitFor({ timeout: 60000 }).catch(() => {});
  check(await snapshotView.isVisible(), 'a report snapshot opens on its page');

  // The seeded saved dashboards: the switcher lists them, and one renders its
  // widgets through the saved dashboard's own widget route.
  await page.goto(`${ORIGIN}${BASE}analytics/d/1`, { waitUntil: 'domcontentloaded' });
  const switcher = page.getByTestId('dashboard-switcher');
  await switcher.waitFor({ timeout: 60000 }).catch(() => {});
  check((await switcher.textContent())?.includes('Checkout team') === true, 'a seeded saved dashboard opens');
  const note = page.locator('[data-shot="analytics-note"]').getByText('Sprint goal');
  await note.waitFor({ timeout: 60000 }).catch(() => {});
  check(await note.isVisible(), 'the saved dashboard renders its widgets');
  await switcher.click();
  const switcherMenu = page.getByTestId('dashboard-switcher-menu');
  await switcherMenu.waitFor({ timeout: 30000 }).catch(() => {});
  check(
    (await switcherMenu.textContent())?.includes('Wasted CI by browser') === true,
    'the switcher lists the seeded dashboards',
  );

  // A flaky test's Flakiness tab reads its flake profile in the service worker:
  // the seeded checkout flake ranks the slower cart first.
  await page.goto(`${ORIGIN}${BASE}test-cases/9?tab=flakiness`, { waitUntil: 'domcontentloaded' });
  const suspect = page.getByTestId('flake-suspect').first();
  await suspect.waitFor({ timeout: 60000 }).catch(() => {});
  check(
    (await suspect.textContent())?.includes('GET /api/cart slower') === true,
    'the Flakiness tab ranks the seeded slow cart first',
    (await suspect.textContent().catch(() => '')) ?? '',
  );

  // The seeded pagination flake's verify experiment held, so its tab reads verified fixed.
  await page.goto(`${ORIGIN}${BASE}test-cases/35?tab=flakiness`, { waitUntil: 'domcontentloaded' });
  const verifiedFix = page.getByTestId('flake-verified-fix');
  await verifiedFix.waitFor({ timeout: 60000 }).catch(() => {});
  check(
    (await verifiedFix.getAttribute('data-holding').catch(() => null)) === 'true',
    'the seeded pagination flake reads verified fixed',
  );

  // The project's Flake Lab tab places it, and lists its three experiments.
  await page.goto(`${ORIGIN}${BASE}projects/3?tab=flake-lab`, { waitUntil: 'domcontentloaded' });
  const labRow = page.locator('[data-testid="flake-lab-test"][data-state="verified"]');
  await labRow.waitFor({ timeout: 60000 }).catch(() => {});
  check(
    (await labRow.textContent().catch(() => ''))?.includes('Table pagination works correctly') === true,
    'the project’s Flake Lab tab lists the pagination test as verified fixed',
  );
  check(
    (await page.getByTestId('flake-lab-experiments').getByTestId('flake-experiment').count()) === 3,
    'the project’s Flake Lab tab lists its experiments',
  );

  // A file's coverage page reads the file at its blob from the canned repository,
  // and lists the one test of three that ran line 37.
  await page.goto(`${ORIGIN}${BASE}projects/5/coverage?file=api/Users/UsersEndpoints.cs&line=37`, {
    waitUntil: 'domcontentloaded',
  });
  const fileView = page.locator('[data-shot="coverage-file"]');
  await fileView
    .locator('[data-line="37"][data-selected]')
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  check(
    (await fileView
      .locator('[data-line="35"] [data-tests]')
      .getAttribute('data-tests')
      .catch(() => null)) === '3',
    'a file’s coverage page shows its source with the tests of each line',
  );
  check(
    (await fileView.locator('[data-coverage-test]').count()) === 1,
    'a file’s coverage page lists the tests of the selected line',
  );
}

/**
 * The server `--desktop` drives without `--url`: the screenshot harness's
 * desktop mode (`NUXT_PUBLIC_DESKTOP=true`) on a throwaway copy of the demo
 * seed, so each sample's ids open the demo's entities.
 */
async function startDesktopServer() {
  const { APP_DIR, seedThrowawayDb, startServer } = await import('./lib/dev-server.mjs');
  const env = seedThrowawayDb(join(APP_DIR, '.data', 'check-desktop'));
  return startServer({ mode: 'desktop', port: DESKTOP_PORT, env });
}

async function main() {
  const anchors = selectedAnchors();
  if (!SERVER && !existsSync(ROOT)) {
    console.error(`No build at ${ROOT}. Run "npm run app:generate:demo" first.`);
    process.exit(1);
  }

  // seed.sql is gitignored and generated on demand. Without it the page loads
  // and the worker installs, but every query answers 500 — say which step is
  // missing rather than leaving a bare error to interpret.
  const seedPaths = [join(ROOT, 'demo', 'seed.sql'), join(ROOT, 'seed.sql')];
  if (!SERVER && !seedPaths.some((p) => existsSync(p))) {
    console.error(`No seed at ${seedPaths[0]}. Run "npm run app:seed:demo" and then "npm run app:generate:demo".`);
    process.exit(1);
  }

  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');

  const server = SERVER ? null : await serve();
  const desktopServer = flags.desktop && !flags.url ? await startDesktopServer() : null;
  console.log(SERVER ? `Driving the server at ${ORIGIN}${BASE}\n` : `Serving the built demo at ${ORIGIN}${BASE}\n`);

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const pageErrors = [];
  // A root-relative /api/ URL escapes the service worker's scope and hits the
  // static host instead, so it can never be answered by the in-browser API.
  const escapedApiUrls = new Set();
  const watch = (p) => {
    p.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
    p.on('request', (r) => {
      const url = r.url();
      if (url.startsWith(`${ORIGIN}/api/`)) escapedApiUrls.add(url.slice(ORIGIN.length));
    });
  };
  watch(page);

  let checkedAnchors = 0;
  try {
    if (!ANCHORS_ONLY) {
      await checkDemoFlows(page);
      await checkGuidedTour(browser, watch);
      await checkAuthoredGuides(browser, watch);
    }
    checkedAnchors = await checkGuideAnchors(browser, watch, anchors);

    if (!SERVER) {
      check(
        escapedApiUrls.size === 0,
        'every API request stays inside the demo base path',
        [...escapedApiUrls].slice(0, 3).join(', '),
      );
    }

    check(pageErrors.length === 0, 'no uncaught page errors', pageErrors[0] ?? '');
  } catch (error) {
    check(false, 'the demo run completed', String(error).split('\n')[0].slice(0, 160));
  } finally {
    await browser.close();
    server?.close();
    desktopServer?.stop();
  }

  console.log('');
  if (failures.length) {
    console.error(`✗ ${failures.length} demo runtime check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  if (ANCHORS_ONLY) {
    console.log(`✓ ${checkedAnchors} guide anchor(s) show at their samples on ${ORIGIN}${BASE}.`);
    return;
  }
  console.log(
    '✓ The built demo runs: service worker, in-browser API, export download, quality report, report snapshots, saved dashboards, the flake profile, a verified flake fix, the Flake Lab tab, every guided tour, every authored guide and every guide anchor all work.',
  );
}

await main();
