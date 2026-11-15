import { captureFailure, test, expect } from '../../src/test';
import { chmodSync, mkdirSync } from 'node:fs';
import { screenshotMatchStore, state } from '../../src/hooks';
import type { Page } from '@playwright/test';

const STATIC_PAGE = `
  <style>body{margin:0;font:16px sans-serif}.grad{height:200px;background:linear-gradient(90deg,#123,#f80)}
  .alpha{background:rgba(0,128,255,.35);padding:20px}</style>
  <div class="grad"></div><p>Static content for screenshot comparison: 0123456789</p>
  <div class="alpha">Translucent panel</div><canvas id="c" width="300" height="120"></canvas>
  <script>const c=document.getElementById('c').getContext('2d');for(let i=0;i<300;i+=3){c.fillStyle='hsl('+i+',80%,50%)';c.fillRect(i,(i*7)%100,3,20)}</script>`;

async function decodedPixelsEqual(page: Page, a: Buffer, b: Buffer) {
  return page.evaluate(
    async ([left, right]) => {
      const load = async (base64: string) => {
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [x, y] = await Promise.all([load(left), load(right)]);
      return x.length === y.length && x.every((value, index) => value === y[index]);
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

test.describe('fast screenshots', () => {
  test.use({ fastScreenshots: true });

  test('encode the same pixels for viewport, full-page, clipped and transparent captures', async ({ page }) => {
    await page.setContent(STATIC_PAGE);
    const captures = {
      viewport: {},
      fullPage: { fullPage: true },
      clip: { clip: { x: 10, y: 50, width: 240, height: 180 } },
      transparent: { omitBackground: true },
    };
    for (const [name, options] of Object.entries(captures)) {
      state.fastScreenshots = false;
      const before = state.counters.optimizedScreenshots;
      const stock = await page.screenshot(options);
      expect(state.counters.optimizedScreenshots, name).toBe(before);
      state.fastScreenshots = true;
      const fast = await page.screenshot(options);
      expect(state.counters.optimizedScreenshots, name).toBe(before + 1);
      expect(await decodedPixelsEqual(page, stock, fast), `${name}: decoded pixels`).toBe(true);
    }
  });

  test('apply to visual assertions and to pages the test opens itself', async ({ page, context }, testInfo) => {
    await page.setContent(STATIC_PAGE);
    // The baseline comes from a stock capture; the assertion compares the fast one with it, pixel for pixel.
    state.fastScreenshots = false;
    await page.locator('.grad').screenshot({ path: testInfo.snapshotPath('gradient.png', { kind: 'screenshot' }) });
    state.fastScreenshots = true;
    const before = state.counters.optimizedScreenshots;
    await expect(page.locator('.grad')).toHaveScreenshot('gradient.png', { maxDiffPixels: 0 });
    expect(state.counters.optimizedScreenshots).toBeGreaterThan(before);
    const other = await context.newPage();
    await other.setContent('<p>second page</p>');
    const count = state.counters.optimizedScreenshots;
    await other.screenshot();
    expect(state.counters.optimizedScreenshots).toBe(count + 1);
  });

  test('keep the stock encoding where an assertion writes its baseline', async ({ page }) => {
    await page.setContent(STATIC_PAGE);
    type ExpectScreenshot = (options: object) => Promise<{ actual?: Buffer }>;
    const expectScreenshot = (page as unknown as { _expectScreenshot: ExpectScreenshot })._expectScreenshot.bind(page);
    const options = { timeout: 5000, type: 'png', isNot: false, scale: 'css' };
    // No baseline: what the assertion takes becomes the baseline.
    const before = state.counters.optimizedScreenshots;
    const { actual } = await expectScreenshot(options);
    expect(state.counters.optimizedScreenshots).toBe(before);
    // A baseline to compare with: the captures are encoded for speed.
    await expectScreenshot({ ...options, expected: actual });
    expect(state.counters.optimizedScreenshots).toBeGreaterThan(before);
  });

  test('leave JPEG screenshots alone', async ({ page }) => {
    await page.setContent(STATIC_PAGE);
    const before = state.counters.optimizedScreenshots;
    await page.screenshot({ type: 'jpeg', quality: 80 });
    expect(state.counters.optimizedScreenshots).toBe(before);
  });
});

test.describe('screenshot matches', () => {
  test.use({ screenshotMatches: true });

  test.beforeEach(({}, testInfo) => {
    screenshotMatchStore.reset(testInfo.outputPath('cache'));
  });

  /** Writes the page's or the element's stock capture as the baseline `name`. */
  async function baseline(target: Page | ReturnType<Page['locator']>, name: string) {
    const fast = state.fastScreenshots;
    state.fastScreenshots = false;
    await target.screenshot({ path: test.info().snapshotPath(name, { kind: 'screenshot' }) });
    state.fastScreenshots = fast;
  }

  test("pass a capture with the baseline's bytes without comparing it, and fail a changed page", async ({ page }) => {
    await page.setContent(STATIC_PAGE);
    await baseline(page, 'static.png');
    const before = state.counters.screenshotMatches;
    await expect(page).toHaveScreenshot('static.png');
    expect(state.counters.screenshotMatches).toBe(before + 1);
    await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<h1>A change</h1>'));
    const error = await expect(page)
      .toHaveScreenshot('static.png', { timeout: 1000 })
      .catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(state.counters.screenshotMatches).toBe(before + 1);
  });

  test('do the same for an element', async ({ page }) => {
    await page.setContent(STATIC_PAGE);
    await baseline(page.locator('.alpha'), 'panel.png');
    const before = state.counters.screenshotMatches;
    await expect(page.locator('.alpha')).toHaveScreenshot('panel.png');
    expect(state.counters.screenshotMatches).toBe(before + 1);
  });

  test.describe('with fast screenshots', () => {
    test.use({ fastScreenshots: true });

    test('remember a capture that matched, and pass it later, in this run and the next', async ({ page }) => {
      await page.setContent(STATIC_PAGE);
      await baseline(page, 'static.png');
      const { screenshotMatches, rememberedScreenshots } = state.counters;
      await expect(page).toHaveScreenshot('static.png');
      expect(state.counters.rememberedScreenshots).toBe(rememberedScreenshots + 1);
      expect(state.counters.screenshotMatches).toBe(screenshotMatches);
      await expect(page).toHaveScreenshot('static.png');
      expect(state.counters.screenshotMatches).toBe(screenshotMatches + 1);
      // The next run reads what this one remembered.
      screenshotMatchStore.reset(screenshotMatchStore.root);
      await expect(page).toHaveScreenshot('static.png');
      expect(state.counters.screenshotMatches).toBe(screenshotMatches + 2);
    });

    test('keep a remembered capture to the options it matched with', async ({ page }) => {
      await page.setContent(STATIC_PAGE);
      await baseline(page, 'static.png');
      await expect(page).toHaveScreenshot('static.png');
      const before = state.counters.screenshotMatches;
      await expect(page).toHaveScreenshot('static.png', { threshold: 0 });
      expect(state.counters.screenshotMatches).toBe(before);
    });

    test('remember nothing on disk in a folder other users can write to', async ({ page }, testInfo) => {
      test.skip(process.platform === 'win32', 'folder modes are POSIX');
      const shared = testInfo.outputPath('shared');
      mkdirSync(shared, { recursive: true });
      chmodSync(shared, 0o777);
      screenshotMatchStore.reset(shared);
      await page.setContent(STATIC_PAGE);
      await baseline(page, 'static.png');
      await expect(page).toHaveScreenshot('static.png');
      expect(screenshotMatchStore.directory()).toBeNull();
    });
  });

  test('leave negated assertions to Playwright', async ({ page }) => {
    await page.setContent(STATIC_PAGE);
    await baseline(page, 'static.png');
    await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<h1>A change</h1>'));
    const before = state.counters.screenshotMatches;
    await expect(page).not.toHaveScreenshot('static.png');
    expect(state.counters.screenshotMatches).toBe(before);
  });
});

test.describe('retry intervals', () => {
  test.use({ retryIntervals: [10, 20, 40, 50] });

  async function timeToSee(page: Page, delay: number) {
    await page.setContent(
      `<script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p id="late">ready</p>'), ${delay})</script>`,
    );
    const started = Date.now();
    await expect(page.locator('#late')).toBeVisible();
    return Date.now() - started;
  }

  test('see a late element sooner than stock polling does', async ({ page }) => {
    const intervals = state.retryIntervals;
    state.retryIntervals = undefined;
    const stock = await timeToSee(page, 600);
    state.retryIntervals = intervals;
    const before = state.counters.shortenedRetries;
    const tuned = await timeToSee(page, 600);
    expect(state.counters.shortenedRetries).toBeGreaterThan(before);
    // Stock waits 500 ms between checks by then; 50 ms intervals see the element within about one interval.
    expect(tuned).toBeLessThan(stock - 50);
  });

  test('keep timeouts, failures and navigation working', async ({ page }) => {
    await page.setContent('<p>never changes</p>');
    const error = await expect(page.locator('#missing'))
      .toBeVisible({ timeout: 300 })
      .catch((e: Error) => e);
    expect(String(error)).toContain('toBeVisible');
    await expect(page.locator('p')).toHaveText('never changes');
    await page.route('https://hooks.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: route.request().url().endsWith('/next') ? '<h1>next</h1>' : '<a href="/next">go</a>',
      }),
    );
    await page.goto('https://hooks.test/');
    await page.getByRole('link').click();
    await expect(page.getByRole('heading', { name: 'next' })).toBeVisible();
  });

  test('wait inside frames', async ({ page }) => {
    await page.setContent(
      `<iframe srcdoc="<script>setTimeout(()=>document.body.innerHTML='<b>inner</b>',300)</script>"></iframe>`,
    );
    await expect(page.frameLocator('iframe').locator('b')).toHaveText('inner');
  });
});

test.describe('without options', () => {
  test('nothing changes', async ({ page }) => {
    await page.setContent(STATIC_PAGE);
    const screenshots = state.counters.optimizedScreenshots;
    const retries = state.counters.shortenedRetries;
    await page.screenshot();
    await page.evaluate(() => setTimeout(() => (document.body.innerHTML = '<i>later</i>'), 100));
    await expect(page.locator('i')).toBeVisible();
    expect(state.counters.optimizedScreenshots).toBe(screenshots);
    expect(state.counters.shortenedRetries).toBe(retries);
    expect(state.fastScreenshots).toBe(false);
    expect(state.retryIntervals).toBeUndefined();
  });
});

test.describe('blockRequests', () => {
  test.use({ blockRequests: ['**/blocked/**', /tracker\.js$/] });

  test('aborts the matching requests only', async ({ page }) => {
    await page.route('**/allowed/**', (route) => route.fulfill({ body: 'ok' }));
    await page.goto('data:text/html,<p>blocking</p>');
    const results = await page.evaluate(async () => {
      const attempt = (url: string) =>
        fetch(url).then(
          () => 'loaded',
          () => 'blocked',
        );
      return Promise.all([
        attempt('https://example.test/blocked/a'),
        attempt('https://example.test/tracker.js'),
        attempt('https://example.test/allowed/b'),
      ]);
    });
    expect(results).toEqual(['blocked', 'blocked', 'loaded']);
  });
});

test.describe('instantAnimations', () => {
  test.use({ instantAnimations: true });

  test('runs a long transition at once, on pages the test opens too', async ({ page, context }) => {
    const animated = `<style>#box{width:10px;transition:width 20s linear}#box.wide{width:300px}</style><div id="box"></div>
      <script>requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('wide')))</script>`;
    await page.setContent(animated);
    await expect(page.locator('#box')).toHaveCSS('width', '300px', { timeout: 2000 });
    const other = await context.newPage();
    await other.waitForTimeout(100);
    await other.setContent(animated);
    await expect(other.locator('#box')).toHaveCSS('width', '300px', { timeout: 2000 });
  });

  test('keeps working after a navigation', async ({ page }) => {
    await page.route('https://anim.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<style>#box{opacity:0;transition:opacity 20s linear}#box.on{opacity:1}</style><div id="box">x</div>
          <script>requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('on')))</script>`,
      }),
    );
    await page.goto('https://anim.test/one');
    await page.goto('https://anim.test/two');
    await expect(page.locator('#box')).toHaveCSS('opacity', '1', { timeout: 2000 });
  });
});

test.describe('failureScreenshots', () => {
  function outcome(status: 'passed' | 'failed') {
    const attached: string[] = [];
    return {
      attached,
      info: {
        status,
        expectedStatus: 'passed' as const,
        attach: async (name: string) => void attached.push(name),
      },
    };
  }

  test('captures nothing for a passing test', async ({ page, context }) => {
    await page.setContent('<p>passes</p>');
    const { attached, info } = outcome('passed');
    expect(await captureFailure(context, info)).toBe(0);
    expect(attached).toEqual([]);
  });

  test('captures every open page of a failed test', async ({ page, context }) => {
    await page.setContent('<p>first</p>');
    const second = await context.newPage();
    await second.setContent('<p>second</p>');
    const closed = await context.newPage();
    await closed.close();
    const { attached, info } = outcome('failed');
    expect(await captureFailure(context, info)).toBe(2);
    expect(attached).toEqual(['screenshot', 'screenshot']);
  });

  test('captures a context the test opened, with the configured options', async ({ page, context, browser }) => {
    await page.setContent('<div style="height: 3000px">tall</div>');
    const other = await browser.newContext();
    await (await other.newPage()).setContent('<p>another context</p>');
    const shots: Buffer[] = [];
    const info = {
      status: 'failed' as const,
      expectedStatus: 'passed' as const,
      attach: async (_name: string, { body }: { body?: string | Buffer }) => void shots.push(body as Buffer),
    };
    expect(await captureFailure(context, info, { fullPage: true })).toBe(2);
    await other.close();
    // A PNG's height sits at bytes 20 to 23: the full page is taller than the viewport.
    expect(shots[0].readUInt32BE(20)).toBeGreaterThan(page.viewportSize()!.height);
  });
});

test.describe('fail fast', () => {
  test.use({ failFast: true });

  async function failureTime(run: () => Promise<unknown>) {
    const started = Date.now();
    const error = await run().then(
      () => undefined,
      (e: Error) => e,
    );
    return { error, elapsed: Date.now() - started };
  }

  test('ends an assertion the idle page can no longer satisfy', async ({ page }) => {
    await page.setContent('<p>static</p>');
    const before = state.counters.failedFast;
    const { error, elapsed } = await failureTime(() => expect(page.locator('#missing')).toBeVisible({ timeout: 5000 }));
    expect(error, 'the assertion fails').toBeTruthy();
    expect(elapsed).toBeLessThan(2000);
    expect(state.counters.failedFast).toBe(before + 1);
  });

  async function serve(page: Page, html: string) {
    await page.route('https://idle.test/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('https://idle.test/');
  }

  test('waits for WebCrypto', async ({ page }) => {
    await serve(
      page,
      `<p id="out"></p><script>(async () => {
        const algorithm = { name: 'RSA-PSS', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
        for (let i = 0; i < 3; i++) await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
        out.textContent = 'done';
      })()</script>`,
    );
    await expect(page.locator('#out')).toHaveText('done', { timeout: 30000 });
  });

  test('waits for IndexedDB', async ({ page }) => {
    await serve(
      page,
      `<p id="out"></p><script>
        const open = indexedDB.open('idle', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('rows');
        open.onsuccess = () => {
          const transaction = open.result.transaction('rows', 'readwrite');
          for (let i = 0; i < 20000; i++) transaction.objectStore('rows').put({ i, text: 'x'.repeat(200) }, i);
          transaction.oncomplete = () => (out.textContent = 'stored');
        };
      </script>`,
    );
    await expect(page.locator('#out')).toHaveText('stored', { timeout: 30000 });
  });

  test('waits for a message a popup is about to post', async ({ page, context }) => {
    await context.route('https://idle.test/popup', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<script>setTimeout(() => opener.postMessage('hello', '*'), 1500)</script>`,
      }),
    );
    await serve(
      page,
      `<p id="out"></p><script>addEventListener('message', (event) => (out.textContent = event.data))</script>`,
    );
    await page.evaluate(() => void window.open('/popup'));
    await expect(page.locator('#out')).toHaveText('hello', { timeout: 5000 });
  });

  test('waits for a timer that is due before the timeout', async ({ page }) => {
    await page.setContent(
      `<script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p id="late">late</p>'), 1200)</script>`,
    );
    await expect(page.locator('#late')).toBeVisible({ timeout: 5000 });
  });

  test('waits for a request in flight', async ({ page }) => {
    await page.route('https://idle.test/data', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fulfill({ body: 'loaded' });
    });
    await page.route('https://idle.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<p id="out"></p><script>fetch('/data').then((r) => r.text()).then((t) => (out.textContent = t))</script>`,
      }),
    );
    await page.goto('https://idle.test/');
    await expect(page.locator('#out')).toHaveText('loaded', { timeout: 5000 });
  });

  test('waits for a running animation to end', async ({ page }) => {
    await page.setContent(`<style>#box{opacity:0;transition:opacity 1s linear}#box.on{opacity:1}</style><div id="box">x</div>
      <script>requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('on')))</script>`);
    await expect(page.locator('#box')).toHaveCSS('opacity', '1', { timeout: 5000 });
  });

  test('keeps waiting the whole timeout while an interval runs', async ({ page }) => {
    await page.setContent('<script>setInterval(() => {}, 300)</script><p>ticking</p>');
    const { error, elapsed } = await failureTime(() => expect(page.locator('#missing')).toBeVisible({ timeout: 1500 }));
    expect(error).toBeTruthy();
    expect(elapsed).toBeGreaterThanOrEqual(1400);
  });

  test('passes an assertion that already holds, and a negated one', async ({ page }) => {
    await page.setContent('<p>here</p>');
    await expect(page.locator('p')).toHaveText('here');
    await expect(page.locator('#missing')).not.toBeVisible();
  });
});

test.describe('skip stability wait', () => {
  test.use({ skipStabilityWait: true });

  const BUTTON = `<button id="b" onclick="this.dataset.n = Number(this.dataset.n || 0) + 1">go</button>`;

  test('clicks without waiting for the element to keep still, sooner than stock', async ({ page }) => {
    await page.setContent(BUTTON);
    const time = async (clicks: number) => {
      const started = Date.now();
      for (let i = 0; i < clicks; i++) await page.locator('#b').click();
      return Date.now() - started;
    };
    state.skipStabilityWait = false;
    const stock = await time(20);
    state.skipStabilityWait = true;
    const before = state.counters.skippedStabilityWaits;
    const skipped = await time(20);
    expect(state.counters.skippedStabilityWaits).toBe(before + 20);
    await expect(page.locator('#b')).toHaveAttribute('data-n', '40');
    expect(skipped).toBeLessThan(stock);
  });

  test('keeps the hit-target check: an overlay still blocks the click', async ({ page }) => {
    await page.setContent(`${BUTTON}<div style="position:fixed;inset:0;background:transparent"></div>`);
    const error = await page
      .locator('#b')
      .click({ timeout: 800 })
      .catch((e: Error) => e);
    expect(String(error)).toContain('intercepts pointer events');
  });

  test('keeps the enabled check: a disabled button is waited for', async ({ page }) => {
    await page.setContent(
      `<button id="b" disabled>go</button><script>setTimeout(() => (b.disabled = false), 300)</script>`,
    );
    await page.locator('#b').click();
  });

  test('lands a click on an element that has stopped moving', async ({ page }) => {
    await page.setContent(`<style>#b{position:relative;left:0;transition:left .3s}#b.moved{left:200px}</style>${BUTTON}
      <script>requestAnimationFrame(() => b.classList.add('moved'))</script>`);
    await page.waitForTimeout(400);
    await page.locator('#b').click();
    await expect(page.locator('#b')).toHaveAttribute('data-n', '1');
  });
});
