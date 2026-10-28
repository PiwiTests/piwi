// The virtual take's capture: the whole X screen recorded by ffmpeg's x11grab at the master's frame rate, lossless and
// without the pointer, and the sync flash, a square that turns white in a window of its own once the recording runs,
// which ties the master's frames to the take's wall clock.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { MASTER_FPS } from './timeline.mjs';

/** The flash's window, in CSS pixels at the set's scale (the screen's bottom-right corner), and its square's side. */
const FLASH_WINDOW = { x: 1560, y: 760, width: 360, height: 320 };
const FLASH_SQUARE = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A command line's flags, written as one string. */
const flags = (text) => text.split(' ');

/**
 * Starts recording `display` (`width` × `height` device pixels) into `file`: x11grab at `fps`, the pointer left out,
 * H.264 lossless (`-qp 0`, ultrafast), every frame at its wall-clock place (`-fps_mode cfr`: a frame the grab misses
 * is the one before, repeated). At most 64 grabbed frames wait for the encoder, 2 GB at 4K. `stop()` ends it and
 * resolves with ffmpeg's counts: the frames written, those repeated (`dup`) and dropped.
 */
export function startCapture({ file, display, width, height, fps = MASTER_FPS }) {
  const args = [
    ...flags('-hide_banner -loglevel error -nostats -progress pipe:1 -stats_period 1'),
    ...flags(`-f x11grab -draw_mouse 0 -framerate ${fps} -video_size ${width}x${height} -thread_queue_size 64 -i`),
    display,
    ...flags('-c:v libx264 -preset ultrafast -qp 0 -pix_fmt yuv420p -fps_mode cfr -y'),
    file,
  ];
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const progress = {};
  let errors = '';
  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) progress[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  let exited = false;
  const exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    }),
  );
  const counts = () => ({
    frames: Number(progress.frame ?? 0),
    dup: Number(progress.dup_frames ?? 0),
    drop: Number(progress.drop_frames ?? 0),
  });
  let stopping = null;
  return {
    file,
    fps,
    spawned: Date.now(),
    /** Resolves once ffmpeg has written a frame; throws when it exits first or takes `ms`. */
    async running(ms = 30_000) {
      for (const deadline = Date.now() + ms; counts().frames < 1;) {
        if (exited) throw new Error(`the capture ended before its first frame: ${errors.trim()}`);
        if (Date.now() > deadline) throw new Error(`the capture wrote no frame in ${ms / 1000} s: ${errors.trim()}`);
        await sleep(100);
      }
    },
    /** Ends the recording (ffmpeg's `q`, then SIGINT, then SIGKILL) and resolves with its counts and its errors. */
    stop() {
      stopping ??= (async () => {
        if (!exited) child.stdin.end('q');
        const ended = await Promise.race([exit, sleep(60_000).then(() => null)]);
        if (!ended) {
          child.kill('SIGINT');
          if (!(await Promise.race([exit, sleep(10_000).then(() => null)]))) child.kill('SIGKILL');
          await exit;
        }
        return { ...counts(), errors: errors.trim() };
      })();
      return stopping;
    },
  };
}

/**
 * The sync flash: a window of its own at the screen's bottom-right corner, black, whose square turns white for a
 * quarter of a second. Resolves with the wall-clock time of the frame that drew it (`t`, ms) and the square's box on
 * the screen (device pixels at `scale`).
 */
export async function syncFlash({ scale }) {
  const w = FLASH_WINDOW;
  const browser = await chromium.launch({
    headless: false,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      `--window-position=${w.x},${w.y}`,
      `--window-size=${w.width},${w.height}`,
      `--force-device-scale-factor=${scale}`,
    ],
  });
  try {
    const page = await (await browser.newContext({ viewport: null })).newPage();
    await page.setContent(
      `<body style="margin:0;background:#000"><div id="square" style="position:fixed;left:50%;top:50%;` +
        `width:${FLASH_SQUARE}px;height:${FLASH_SQUARE}px;margin:-${FLASH_SQUARE / 2}px;background:#000"></div></body>`,
    );
    const box = await page.evaluate(() => {
      const r = document.getElementById('square').getBoundingClientRect();
      return {
        x: window.screenX + (window.outerWidth - window.innerWidth) + r.x,
        y: window.screenY + (window.outerHeight - window.innerHeight) + r.y,
        width: r.width,
        height: r.height,
      };
    });
    // The black window shows for a few frames first, so the square's first white frame is the flash.
    await sleep(600);
    const t = await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame((time) => {
            document.getElementById('square').style.background = '#fff';
            resolve(performance.timeOrigin + time);
          }),
        ),
    );
    await sleep(250);
    const px = (v) => Math.round(v * scale);
    return { t: Math.round(t), box: { x: px(box.x), y: px(box.y), width: px(box.width), height: px(box.height) } };
  } finally {
    await browser.close();
  }
}

/**
 * The master's first frame that shows the flash: its square (`box`) white and the black around it, read from the
 * first `seconds` of `master` as a 3 × 3 grid of the square and its surround. Null when no frame shows it.
 */
export function findFlash(master, box, { seconds = 60 } = {}) {
  const crop = `crop=${box.width * 3}:${box.height * 3}:${box.x - box.width}:${box.y - box.height}`;
  const args = ['-v', 'error', '-t', String(seconds), '-i', master];
  args.push('-vf', `${crop},scale=3:3:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1');
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = Buffer.alloc(0);
    let frame = 0;
    let found = null;
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.stdout.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (found === null && pending.length >= 9) {
        const cells = [...pending.subarray(0, 9)];
        pending = pending.subarray(9);
        const around = cells.filter((_, i) => i !== 4);
        if (cells[4] > 200 && Math.max(...around) < 60) {
          found = frame;
          child.kill();
        }
        frame++;
      }
    });
    child.once('exit', (code) => {
      if (found !== null || code === 0) resolve(found);
      else reject(new Error(`reading the master for its flash failed: ${errors.trim()}`));
    });
  });
}
