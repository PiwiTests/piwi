#!/usr/bin/env node
/**
 * Records the "run streaming in live" video on the docs landing page, and the
 * poster the README and the landing page show in its place.
 *
 * It opens the demo, starts one scenario of the demo's run simulator (the
 * simulator replays a reporter's streaming protocol, so the run page fills in
 * exactly as it does with a real reporter), records the run page until the run
 * finishes, and writes:
 *
 *   ../docs/public/demo-live-run.mp4                      H.264, 1280×720, no audio
 *   ../docs/public/screenshots/demo-live-run-poster.png   the run page mid-run
 *
 * Usage (from application/):
 *   node scripts/record-demo-video.mjs                              # the live demo
 *   node scripts/record-demo-video.mjs --url http://localhost:4173/demo/
 *   node scripts/record-demo-video.mjs --scenario failures --ffmpeg /path/to/ffmpeg
 *
 * Playwright records WebM; turning it into an MP4 that every browser plays
 * needs an ffmpeg with libx264 (Playwright's bundled ffmpeg has only VP8).
 * Pass `--ffmpeg`, set `FFMPEG`, or have `ffmpeg` on the PATH.
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sharp = require('sharp');

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_PUBLIC = join(APP_DIR, '..', 'docs', 'public');
const VIDEO_OUT = join(DOCS_PUBLIC, 'demo-live-run.mp4');
const POSTER_OUT = join(DOCS_PUBLIC, 'screenshots', 'demo-live-run-poster.png');
const SIZE = { width: 1280, height: 720 };

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? process.argv[at + 1] : fallback;
};
const url = arg('url', 'https://piwitests.dev/demo/');
// Scenario labels as the simulator's menu shows them (app/demo/simulator.ts).
const scenarios = { failures: 'Run with failures', passing: 'Passing run', flaky: 'Flaky retries' };
const scenario = scenarios[arg('scenario', 'failures')] ?? arg('scenario');
const ffmpeg = arg('ffmpeg', process.env.FFMPEG || 'ffmpeg');

const workDir = mkdtempSync(join(tmpdir(), 'piwi-demo-video-'));
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: SIZE,
    colorScheme: 'dark',
    recordVideo: { dir: workDir, size: SIZE },
  });
  const page = await context.newPage();
  const recordingStart = Date.now();
  const elapsed = () => (Date.now() - recordingStart) / 1000;

  // The guided tour's first-visit prompt would cover the run; this browser has already declined it.
  await context.addInitScript(() =>
    localStorage.setItem('piwi-demo-tour', JSON.stringify({ decision: 'dismissed', decidedAt: Date.now() })),
  );
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // The launcher is disabled until the in-browser database has loaded.
  const launcher = page.getByRole('button', { name: 'Simulate a test run' });
  await launcher.waitFor({ timeout: 120000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent?.includes('Simulate a test run') && !b.disabled,
      ),
    null,
    { timeout: 120000 },
  );
  await launcher.click();
  await page.getByRole('button', { name: new RegExp(scenario) }).click();
  // The banner holds the launcher; the recording shows the product only.
  await page.addStyleTag({ content: '.demo-banner{display:none!important}' });

  await page.waitForURL(/\/test-runs\/\d+/, { timeout: 60000 });
  const header = page.locator('[data-shot="run-header"]');
  await header.waitFor({ timeout: 60000 });
  const clipStart = elapsed();

  // The header reads "Initializing", then "Running" until the run finishes.
  // Keep the last frame taken while it was running: the poster shows a run
  // arriving, with most of its results in.
  let poster = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const status = (await header.innerText()).trim().split(/\s/)[0];
    // The run's result toast can open a moment before the header leaves Running; it is not part of the poster.
    const toast = await page.locator('[role="region"] li[role="status"]').count();
    if (status === 'Running' && !toast) poster = await page.screenshot();
    else if (status !== 'Initializing') break;
    await page.waitForTimeout(1000);
  }
  // Hold on the finished run for a moment before the loop restarts.
  await page.waitForTimeout(1500);
  const clipEnd = elapsed();

  const video = page.video();
  await context.close();
  const recorded = await video.path();

  execFileSync(ffmpeg, [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    clipStart.toFixed(2),
    '-to',
    clipEnd.toFixed(2),
    '-i',
    recorded,
    '-vf',
    `fps=30,scale=${SIZE.width}:${SIZE.height}`,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    VIDEO_OUT,
  ]);
  console.log(
    `-> ${VIDEO_OUT} (${(clipEnd - clipStart).toFixed(1)} s, ${(readFileSync(VIDEO_OUT).length / 1024).toFixed(0)} KB)`,
  );

  if (!poster) throw new Error('The run finished before its page loaded; no poster frame was taken.');
  writeFileSync(POSTER_OUT, await sharp(poster).png({ palette: true, compressionLevel: 9 }).toBuffer());
  console.log(`-> ${POSTER_OUT}`);
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}
