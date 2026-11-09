#!/usr/bin/env node
// Films the docs' loop of recording a test from the editor: VS Code, as the screenshot script opens it on the fixture
// project, records into a new test of `tests/coupon.spec.ts` while the browser the project's own Playwright opens
// stands beside it, and the person's actions in that browser are written at the cursor. The two windows share one X
// screen, which ffmpeg captures; run it under Xvfb at the screen's size, with an ffmpeg that has x11grab and libx264
// (`FFMPEG`, else the one on the PATH):
//
//   npm run vscode:build
//   xvfb-run -a -s "-screen 0 1600x900x24" node scripts/record-loop.mjs [--out <file>]
//
// It writes apps/docs/public/videos/editor-recording-loop.mp4. The fixture's Playwright is this repository's, copied
// into its `node_modules`, with the Chromium Playwright resolves; the shop's page is served from this process, and the
// stub instance lists the page object method the recorded steps become a call to.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PROJECT, checkoutPage, startStub, writeWorkspace } from './lib/editor-fixture.mjs';
import { clearNotifications, command, goToLine, launchVSCode, openFile, settle } from './lib/vscode-window.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(here, '..');
const repoRoot = path.resolve(extensionPath, '..', '..');
const args = process.argv.slice(2);
const OUT = args.includes('--out')
  ? path.resolve(args[args.indexOf('--out') + 1])
  : path.join(repoRoot, 'apps', 'docs', 'public', 'videos', 'editor-recording-loop.mp4');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

/** The X screen, VS Code on its left and the recording's browser on its right. */
const SCREEN = { width: 1600, height: 900 };
const EDITOR_WIDTH = 900;
const SPEC = 'tests/coupon.spec.ts';
/** The blank line of the new test the recording starts on. */
const RECORD_LINE = 4;

const COUPON_SPEC = `import { test, expect } from '@playwright/test';

test('takes 10% off with a coupon', async ({ page }) => {

});
`;

/** The page object's method the recording's steps become a call to. */
const APPLY_COUPON = {
  id: 1,
  name: 'applyCoupon',
  kind: 'page-object-method',
  module: './pages/checkout.page',
  receiver: 'checkout',
  importName: 'CheckoutPage',
  params: [{ name: 'code', type: 'string' }],
  urlPattern: null,
  steps: [
    { action: 'fill', target: { role: 'textbox', name: 'Coupon code' } },
    { action: 'click', target: { role: 'button', name: 'Apply' } },
  ],
  paramSources: [{ param: 'code', stepIndex: 0, from: 'value' }],
};

/** The project's config for the loop: the shop served here, the browser's window placed beside the editor. */
const config = (baseURL, debugPort) => `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  use: {
    baseURL: '${baseURL}',
    viewport: null,
    launchOptions: {
      args: [
        '--window-position=${EDITOR_WIDTH},0',
        '--window-size=${SCREEN.width - EDITOR_WIDTH},${SCREEN.height}',
        '--remote-debugging-port=${debugPort}',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
`;

/** Draws a pointer where the mouse is, the last element of the document so it stays above the recorder's bar. */
const POINTER = `(() => {
  const draw = (event) => {
    let pointer = document.getElementById('piwi-docs-pointer');
    if (!pointer) {
      pointer = document.createElement('div');
      pointer.id = 'piwi-docs-pointer';
      pointer.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;width:16px;height:16px;margin:-8px 0 0 -8px;' +
        'border-radius:50%;background:rgba(124,58,237,0.3);border:2px solid #7c3aed;box-sizing:border-box';
    }
    if (pointer !== document.documentElement.lastElementChild) document.documentElement.append(pointer);
    pointer.style.display = '';
    pointer.style.left = event.clientX + 'px';
    pointer.style.top = event.clientY + 'px';
  };
  window.addEventListener('mousemove', draw, true);
  document.documentElement.addEventListener('mouseleave', () => {
    const pointer = document.getElementById('piwi-docs-pointer');
    if (pointer) pointer.style.display = 'none';
  });
})();`;

/** Opens the shadow roots the recorder attaches, so the script can find its buttons. */
const OPEN_SHADOWS = `(() => {
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    return attach.call(this, { ...init, mode: 'open' });
  };
})();`;

/** Keeps the window's title as a user of the published extension sees it. */
const PLAIN_TITLE = `(() => {
  const plain = () => {
    for (const title of document.querySelectorAll('.window-title')) {
      const text = title.textContent.replace(/\\[Extension Development Host\\]\\s*/, '').replace(/\\s*\\[Superuser\\]/, '');
      if (text !== title.textContent) title.textContent = text;
    }
  };
  new MutationObserver(plain).observe(document.body, { subtree: true, childList: true, characterData: true });
  plain();
})();`;

/** The shop's cart, its Apply taking 10% off the total. */
function shopPage() {
  const apply = `<script>
document.querySelector('.coupon button').addEventListener('click', () => {
  const code = document.getElementById('coupon').value.trim();
  document.querySelector('[data-testid="order-total"]').textContent = code === 'MORNING10' ? '10.80 €' : '12.00 €';
});
</script>`;
  return checkoutPage()
    .replace('<head>', `<head>\n<script>${OPEN_SHADOWS}${POINTER}</script>`)
    .replace('</body>', `${apply}\n</body>`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startShop() {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') return res.writeHead(404).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(shopPage());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** The fixture project, with this repository's Playwright copied in and the loop's spec and config written. */
function prepareWorkspace(parent, baseURL, debugPort) {
  const { workspace, commit } = writeWorkspace(parent);
  // Copied, not linked: the recorder takes only a Playwright whose real path is in the project's node_modules.
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    const to = path.join(workspace, 'node_modules', name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(path.join(repoRoot, 'node_modules', name), to, { recursive: true, dereference: true });
  }
  fs.writeFileSync(path.join(workspace, 'playwright.config.ts'), config(baseURL, debugPort));
  fs.writeFileSync(path.join(workspace, SPEC), COUPON_SPEC);
  fs.mkdirSync(path.join(workspace, '.vscode'));
  fs.writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({ 'files.exclude': { '.vscode': true, 'package.json': true, node_modules: true } }, null, 2),
  );
  return { workspace, commit };
}

/** Runs ffmpeg with `args`, resolving once it exits cleanly; `stdin` is kept open for a capture to be stopped. */
function ffmpeg(args, stdin = 'ignore') {
  const child = spawn(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: [stdin, 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  return { child, done };
}

/** Starts capturing the X screen, losslessly; `stop` ends the capture once its file is written. */
function captureScreen(file) {
  const screen = [
    '-f',
    'x11grab',
    '-draw_mouse',
    '0',
    '-framerate',
    '25',
    '-video_size',
    `${SCREEN.width}x${SCREEN.height}`,
  ];
  const lossless = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0'];
  const { child, done } = ffmpeg([...screen, '-i', process.env.DISPLAY, ...lossless, file], 'pipe');
  return {
    startedAt: Date.now(),
    stop: async () => {
      if (child.exitCode === null) child.stdin.write('q');
      await done;
    },
  };
}

/** The backdrop the screen's empty part shows: X's bare screen is black, which no window here draws. */
const BACKDROP = '0x2b2d31';

/** Encodes the capture from `fromMs` on as the docs' loops are: H.264, no sound, small, on the backdrop. */
async function encode(raw, fromMs, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const size = `${SCREEN.width}x${SCREEN.height}`;
  const input = ['-ss', (fromMs / 1000).toFixed(2), '-i', raw];
  const backdrop = ['-f', 'lavfi', '-i', `color=c=${BACKDROP}:s=${size}:r=25`];
  const filter = ['-filter_complex', '[0:v]fps=25,colorkey=0x000000:0.01:0[shown];[1:v][shown]overlay=shortest=1'];
  const output = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  await ffmpeg([...input, ...backdrop, ...filter, ...output, '-an', file]).done;
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

/** Moves the mouse to the middle of `target` in a few steps, and rests there. */
async function glide(page, target, restMs = 400) {
  const box = await target.boundingBox();
  if (!box) throw new Error(`nothing to glide to: ${target}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
  await page.waitForTimeout(restMs);
}

/** The recording's page, once its browser is up and the recorder's bar is on it. */
async function recordingPage(debugPort) {
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      for (;;) {
        const page = browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().startsWith('http://127.0.0.1'));
        if (page) {
          await page.locator('#piwi-record-hud-host').waitFor({ state: 'attached', timeout: 30_000 });
          return { browser, page };
        }
        if (Date.now() > until) throw new Error('the recording opened no page on the shop');
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function main() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-vscode-loop-')));
  const shop = await startShop();
  const debugPort = await freePort();
  const { workspace, commit } = prepareWorkspace(parent, shop.url, debugPort);
  const stub = await startStub(commit, { testFunctions: [APPLY_COUPON] });
  const raw = path.join(parent, 'screen.mkv');
  let window;
  let attached;
  let capture;
  try {
    window = await launchVSCode({
      extensionPath,
      workspace,
      env: {
        PIWI_DASHBOARD_URL: stub.url,
        PIWI_PROJECT_NAME: PROJECT.name,
        PIWI_DESKTOP_CONFIG: path.join(parent, 'no-desktop.json'),
      },
      settings: { 'window.newWindowDimensions': 'default' },
    });
    const { app, page } = window;
    await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), {
      x: 0,
      y: 0,
      width: EDITOR_WIDTH,
      height: SCREEN.height,
    });
    await page.evaluate(PLAIN_TITLE);
    await settle(page, 1500);
    if (await page.locator('.part.sidebar').isVisible()) {
      await command(page, 'View: Toggle Primary Side Bar Visibility');
    }
    await openFile(page, SPEC);
    await goToLine(page, RECORD_LINE, 3);
    await clearNotifications(page);
    await page.evaluate(POINTER);
    await page.mouse.move(EDITOR_WIDTH / 2, 500);
    await settle(page, 800);

    capture = captureScreen(raw);
    await settle(page, 1200);
    const from = Date.now() - capture.startedAt;

    // Record here, from the command palette: the start page asked, the browser opened beside the editor.
    await page.keyboard.press('F1');
    const input = page.locator('.quick-input-widget input');
    await input.waitFor({ state: 'visible' });
    await input.pressSequentially('>Piwi: Record here', { delay: 40 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    // Each question the recording asks before the browser opens, answered with what it offers.
    for (let asked = 0; asked < 3; asked++) {
      await page.waitForTimeout(800);
      const widget = page.locator('.quick-input-widget:not(.quick-input-widget-closing)');
      if (!(await widget.isVisible())) break;
      await page.waitForTimeout(600);
      await page.keyboard.press('Enter');
    }
    const recording = await recordingPage(debugPort);
    attached = recording.browser;
    const shopTab = recording.page;
    shopTab.setDefaultTimeout(15_000);
    await page.mouse.move(EDITOR_WIDTH + 10, 400);
    await shopTab.mouse.move(300, 420);
    await shopTab.waitForTimeout(1200);

    // Each action in the browser is written at the cursor as it is made.
    const coupon = shopTab.getByLabel('Coupon code');
    await glide(shopTab, coupon, 300);
    // Focused, not clicked: the fill and the click on Apply are the page object method's steps, and nothing between.
    await coupon.focus();
    await shopTab.keyboard.type('MORNING10', { delay: 110 });
    await shopTab.waitForTimeout(700);
    const apply = shopTab.getByRole('button', { name: 'Apply' });
    await glide(shopTab, apply, 300);
    await apply.click();
    await shopTab.waitForTimeout(1500);

    // A check of what the page shows now: the total, its text as it reads.
    const hud = shopTab.locator('#piwi-record-hud-host');
    const check = hud.getByRole('button', { name: 'Check an element' });
    await glide(shopTab, check, 500);
    await check.click();
    await shopTab.waitForTimeout(800);
    const total = shopTab.getByTestId('order-total');
    await glide(shopTab, total, 700);
    await total.click();
    await shopTab.waitForTimeout(1200);
    const add = shopTab.getByRole('button', { name: 'Add the check' });
    await glide(shopTab, add, 400);
    await add.click();
    await shopTab.waitForTimeout(1800);
    await shopTab.mouse.move(-5, 450, { steps: 10 });

    // Stop, from the editor: the block stays, and the notification offers to run it.
    await page.mouse.move(EDITOR_WIDTH - 20, 450);
    const stop = page.locator('.codelens-decoration a', { hasText: 'Stop' });
    await glide(page, stop, 500);
    await stop.click();
    await page.mouse.move(EDITOR_WIDTH / 2, 600, { steps: 12 });
    await page.locator('.notification-toast', { hasText: 'Recorded' }).waitFor();
    await page.waitForTimeout(4000);
    await capture.stop();
    await encode(raw, from, OUT);
  } catch (error) {
    if (window?.page) {
      const failed = path.join(os.tmpdir(), 'editor-recording-loop-failed.png');
      await window.page.screenshot({ path: failed }).catch(() => {});
      console.error(`the loop failed: the editor as it stood is in ${failed}`);
    }
    throw error;
  } finally {
    await capture?.stop().catch(() => {});
    await attached?.close().catch(() => {});
    await window?.close();
    stub.server.close();
    shop.server.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
