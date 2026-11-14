import { captureFailure, test, expect } from '../../src/test';
import { state } from '../../src/hooks';
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

  test('leave JPEG screenshots alone', async ({ page }) => {
    await page.setContent(STATIC_PAGE);
    const before = state.counters.optimizedScreenshots;
    await page.screenshot({ type: 'jpeg', quality: 80 });
    expect(state.counters.optimizedScreenshots).toBe(before);
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

  test('waits for a timer that is due before the timeout', async ({ page }) => {
    await page.setContent(`<script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p id="late">late</p>'), 1200)</script>`);
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

test.describe('differential snapshots', () => {
  test('take the same snapshots as a full walk', async ({ page }) => {
    const { DIFFERENTIAL_STREAMER } = await import('../../src/vendor/differential-snapshots');
    await page.setContent(`
      <style>#scroller{height:60px;overflow:auto}</style>
      <div id="scroller">${'<p>line</p>'.repeat(30)}</div>
      <input id="name" value="first"><input id="agree" type="checkbox"><select id="pick"><option>a</option><option>b</option></select>
      <ul id="list"><li>one</li><li>two</li></ul><div id="host"></div>`);
    // The third argument makes the script compare every snapshot with a full walk and report differences.
    await page.evaluate(`(${DIFFERENTIAL_STREAMER})("__turbo_check", true, true)`);
    const capture = () =>
      page.evaluate(() => {
        const data = (window as unknown as Record<string, { captureSnapshot(): { checkError?: string } }>).__turbo_check.captureSnapshot();
        return data?.checkError ?? null;
      });
    expect(await capture()).toBeNull();
    const changes: Array<() => Promise<unknown>> = [
      () => page.locator('#scroller').evaluate((el) => (el.scrollTop = 120)),
      () => page.locator('#name').fill('second'),
      () => page.locator('#agree').check(),
      () => page.locator('#pick').selectOption('b'),
      () => page.evaluate(() => document.querySelector('#list')!.insertAdjacentHTML('beforeend', '<li>three</li>')),
      () => page.evaluate(() => document.querySelector('#list li')!.remove()),
      () => page.evaluate(() => ((document.querySelector('#list li') as HTMLElement).textContent = 'changed')),
      () =>
        page.evaluate(() => {
          const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
          root.innerHTML = '<b>shadow</b>';
        }),
      () => page.evaluate(() => (document.querySelector('#host')!.shadowRoot!.querySelector('b')!.textContent = 'deep')),
      () => page.evaluate(() => document.body.setAttribute('data-state', 'done')),
    ];
    for (const [index, change] of changes.entries()) {
      await change();
      expect(await capture(), `snapshot after change ${index + 1}`).toBeNull();
    }
  });
});
