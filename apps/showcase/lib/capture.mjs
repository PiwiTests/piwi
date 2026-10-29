// The virtual take's capture: the whole X screen recorded by ffmpeg's x11grab at the master's frame rate, lossless and
// without the pointer, and the sync flash, a square that turns white in a window of its own once the recording runs,
// which ties the master's frames to the take's wall clock.
import { execFileSync, spawn } from 'node:child_process';
import * as os from 'node:os';
import { chromium } from 'playwright';
import { MASTER_FPS } from './timeline.mjs';

/** The flash's window, in CSS pixels at the set's scale (the screen's bottom-right corner), and its square's side. */
const FLASH_WINDOW = { x: 1560, y: 760, width: 360, height: 320 };
const FLASH_SQUARE = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A command line's flags, written as one string. */
const flags = (text) => text.split(' ');

/**
 * A reader of ffmpeg's `-progress` output, which arrives in chunks that cut its `key=value` lines anywhere: `read(chunk)`
 * takes each chunk, keeping a line cut short for the next, into `values`.
 */
export function progressReader() {
  const values = {};
  let partial = '';
  return {
    values,
    read(chunk) {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        const at = line.indexOf('=');
        if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
    },
  };
}

/** Throws, saying what to install, unless ffmpeg and ffprobe run here. */
export function checkTools() {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try {
      execFileSync(tool, ['-version'], { stdio: 'ignore', timeout: 30_000 });
    } catch (error) {
      throw new Error(`${tool} does not run here (${error.code ?? error.message}): a take and the cut need ffmpeg`);
    }
  }
}

/**
 * How the capture runs ahead of the set's apps: itself raised as root; through `sudo -n nice` where
 * `SHOWCASE_CAPTURE_SUDO=1` says sudo needs no password (CI's runners); else at the set's priority.
 */
function priority() {
  if (process.getuid?.() === 0) return 'root';
  if (process.env.SHOWCASE_CAPTURE_SUDO === '1') return 'sudo';
  return null;
}

/**
 * Starts recording `display` (`width` × `height` device pixels) into `file`: x11grab at `fps`, the pointer left out,
 * H.264 lossless (`-qp 0`, ultrafast), every frame at its wall-clock place (`-fps_mode cfr`: a frame the grab misses
 * is the one before, repeated). At most 128 grabbed frames wait for the encoder, 4 GB at 4K. The capture runs ahead
 * of the set's apps where the system lets it (`priority`): they wait on state, it keeps real time; `raised` says
 * whether it does. `stop()` ends it and resolves with ffmpeg's counts (the frames written, those repeated, `dup`, and
 * dropped), its exit (`code`, `signal`, or the `error` that kept it from running) and its errors.
 */
export function startCapture({ file, display, width, height, fps = MASTER_FPS }) {
  const args = [
    ...flags('-hide_banner -loglevel error -nostats -progress pipe:1 -stats_period 1'),
    ...flags(`-f x11grab -draw_mouse 0 -framerate ${fps} -video_size ${width}x${height} -thread_queue_size 128 -i`),
    display,
    ...flags('-c:v libx264 -preset ultrafast -qp 0 -pix_fmt yuv420p -fps_mode cfr -y'),
    file,
  ];
  const how = priority();
  const [command, commandArgs] =
    how === 'sudo' ? ['sudo', ['-n', 'nice', '-n', '-10', 'ffmpeg', ...args]] : ['ffmpeg', args];
  const child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  let raised = how === 'sudo';
  if (how === 'root') {
    try {
      os.setPriority(child.pid, -10);
      raised = true;
    } catch {
      // The capture shares the machine as it is: `raised` tells.
    }
  }
  const progress = progressReader();
  let errors = '';
  child.stdout.on('data', (chunk) => progress.read(chunk.toString()));
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  // A spawn that fails (no ffmpeg) or ends: resolved once, with how it ended.
  let ended = null;
  const exit = new Promise((resolve) => {
    child.once('error', (error) => {
      ended ??= { code: null, signal: null, error: error.message };
      resolve(ended);
    });
    child.once('close', (code, signal) => {
      ended ??= { code, signal, error: null };
      resolve(ended);
    });
  });
  child.stdin.on('error', () => {
    // An ffmpeg that ended reads no more: its exit tells why.
  });
  const counts = () => ({
    frames: Number(progress.values.frame ?? 0),
    dup: Number(progress.values.dup_frames ?? 0),
    drop: Number(progress.values.drop_frames ?? 0),
  });
  let stopping = null;
  return {
    file,
    fps,
    raised,
    spawned: Date.now(),
    /** Resolves with the time ffmpeg had written a frame; throws when it ends first or takes `ms`. */
    async running(ms = 30_000) {
      for (const deadline = Date.now() + ms; counts().frames < 1;) {
        if (ended) {
          throw new Error(`the capture ended before its first frame: ${ended.error ?? errors.trim()}`);
        }
        if (Date.now() > deadline) throw new Error(`the capture wrote no frame in ${ms / 1000} s: ${errors.trim()}`);
        await sleep(100);
      }
      return Date.now();
    },
    /** Whether ffmpeg ended before it was stopped. */
    ended: () => ended,
    /** Ends the recording (ffmpeg's `q`, then SIGINT, then SIGKILL) and resolves with its counts, exit and errors. */
    stop() {
      stopping ??= (async () => {
        const early = ended;
        if (!ended) child.stdin.end('q');
        const done = await Promise.race([exit, sleep(60_000).then(() => null)]);
        if (!done) {
          child.kill('SIGINT');
          if (!(await Promise.race([exit, sleep(10_000).then(() => null)]))) child.kill('SIGKILL');
          await exit;
        }
        return { ...counts(), ...ended, early: Boolean(early), errors: errors.trim() };
      })();
      return stopping;
    },
  };
}

/**
 * What is wrong with a capture that `stop()` returned (`counts`), which wrote its first frame at `running` and was
 * stopped at `stopped` (wall-clock ms), at `fps`: an ffmpeg that failed or ended before it was stopped, or fewer
 * frames than 95 % of the time it ran. Null when it is sound.
 */
export function captureProblem(counts, { running, stopped, fps = MASTER_FPS }) {
  if (counts.error) return `ffmpeg did not run: ${counts.error}`;
  if (counts.early) return `ffmpeg ended before the take did (exit ${counts.code ?? counts.signal}): ${counts.errors}`;
  if (counts.code !== 0) return `ffmpeg exited with ${counts.code ?? counts.signal}: ${counts.errors}`;
  const expected = ((stopped - running) / 1000) * fps;
  if (counts.frames < 0.95 * expected) {
    return `the master holds ${counts.frames} frames for ${Math.round(expected)} of its time`;
  }
  return null;
}

/**
 * The sync flash: a window of its own at the screen's bottom-right corner, black, whose square turns white for a
 * second. Resolves with the wall-clock time the square went to the screen (`t`, ms) and its box on the screen (device
 * pixels at `scale`).
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
    // Timed at the frame after the one that drew the square, when that one is on its way to the screen.
    const t = await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => {
            document.getElementById('square').style.background = '#fff';
            requestAnimationFrame((time) => resolve(performance.timeOrigin + time));
          }),
        ),
    );
    // Long enough for a busy machine's compositor and the grab to catch it.
    await sleep(1000);
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
    child.once('error', (error) => reject(new Error(`ffmpeg does not run: ${error.message}`)));
    child.once('close', (code) => {
      if (found !== null || code === 0) resolve(found);
      else reject(new Error(`reading the master for its flash failed: ${errors.trim()}`));
    });
  });
}
