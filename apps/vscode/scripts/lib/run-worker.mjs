// A test run the editor starts, played without Playwright, for the screenshot scripts. `installPlaywright` puts a
// `playwright` command in the fixture project's `node_modules/.bin`, which the editor's task runs as `npx playwright
// test`: it prints Playwright's first line, writes the run channel and the ref its environment names
// (`PIWI_RUN_CHANNEL`, `PIWI_ORIGIN_REF`) to a file, and waits until the task is ended, so the run stays live.
// `attachWorker` then connects to that channel as a worker of the run does (the reporter's capture fixtures, the
// integration suite's fake worker) and sends what the scene says; `pageImage` is the JPEG it answers an image request
// with.
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

/** The versions of Playwright and of the reporter the worker reports: a reporter with the run channel. */
const PLAYWRIGHT_VERSION = '1.63.0';
const REPORTER_VERSION = '0.61.0';

/** Writes the `playwright` command into `workspace`; the run it starts is written to `runFile`. */
export function installPlaywright(workspace, runFile) {
  const bin = path.join(workspace, 'node_modules', '.bin', 'playwright');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.rmSync(runFile, { force: true });
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
console.log('\\nRunning 1 test using 1 worker\\n');
const run = {
  channel: process.env.PIWI_RUN_CHANNEL ?? null,
  ref: process.env.PIWI_ORIGIN_REF ?? null,
  cwd: process.cwd(),
};
fs.writeFileSync(${JSON.stringify(runFile)}, JSON.stringify(run));
// Live until the task is ended, or the shell that ran it goes with the window.
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    process.exit(0);
  }
}, 1_000);
`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
}

/** The run the command wrote to `runFile`, once it started. */
export async function waitForRun(runFile, ms = 60_000) {
  const start = Date.now();
  for (;;) {
    if (fs.existsSync(runFile)) {
      const run = JSON.parse(fs.readFileSync(runFile, 'utf-8'));
      if (!run.channel || !run.ref) throw new Error(`the run's environment has no run channel: ${JSON.stringify(run)}`);
      return run;
    }
    if (Date.now() - start > ms) throw new Error('the run did not start: no playwright command ran');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Worker 0 of `run`, connected to its run channel and attached: `send` writes a message, `heard` holds what the
 * editor service sent, `waitFor` waits for one of them from `from` on, and an image request is answered with `image`.
 */
export async function attachWorker({ channel, ref, cwd }) {
  const hash = channel.lastIndexOf('#');
  const socket = net.connect(channel.slice(0, hash));
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.setEncoding('utf8');
  const heard = [];
  const send = (message) => socket.write(`${JSON.stringify(message)}\n`);
  const worker = {
    heard,
    /** The stopped page's image, as `answer` carries it; null for none. */
    image: null,
    send,
    async waitFor(test, what, from = 0, ms = 30_000) {
      const start = Date.now();
      for (;;) {
        const found = heard.slice(from).find(test);
        if (found) return found;
        if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    close: () => socket.destroy(),
  };
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      heard.push(message);
      if (message.type === 'request' && message.what === 'image') {
        send({ type: 'answer', request: message.request, what: 'image', value: worker.image });
      }
    }
  });
  send({
    type: 'run-attach',
    token: channel.slice(hash + 1),
    ref,
    cwd,
    workerIndex: 0,
    parallelIndex: 0,
    pid: process.pid,
    playwright: PLAYWRIGHT_VERSION,
    reporter: REPORTER_VERSION,
  });
  return worker;
}

/** `html` rendered by Playwright's Chromium at 2×, as the base64 JPEG a stopped worker sends of its page. */
export async function pageImage(html, viewport = { width: 520, height: 440 }) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    await page.setContent(html);
    return { mime: 'image/jpeg', data: (await page.screenshot({ type: 'jpeg', quality: 85 })).toString('base64') };
  } finally {
    await browser.close();
  }
}
