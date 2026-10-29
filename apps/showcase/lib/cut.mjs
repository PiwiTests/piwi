// The cut: renders a take's video from its master and its log. The stage page (`stage/`) draws each output frame from
// the plan (`cut-plan.mjs`) on the master's frame, which a decoder feeds it in order; Playwright screenshots it and
// ffmpeg encodes the frames, in time ranges side by side. From that render come the full cut (MP4 and WebM, with and
// without the subtitles burned in), the teaser, a clip per beat, the posters, the subtitles, the chapters and the
// contact sheet.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findFlash } from './capture.mjs';
import { TITLE_BAR, planCut } from './cut-plan.mjs';
import {
  OUTPUT_FPS,
  chapterTime,
  chaptersText,
  chaptersVtt,
  subtitleRows,
  teaserParts,
  toSrt,
  toVtt,
} from './timeline.mjs';
import { REPO_ROOT } from './workspace.mjs';

const STAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'stage');
const LOGOS = path.join(REPO_ROOT, 'apps', 'docs', 'public');

/** The outputs' names. */
const NAME = 'piwi-showcase';

/** The teaser's size limit, the size it aims at, its frame and the crossfade between its parts. */
const TEASER = { limit: 1_000_000, aim: 930_000, width: 1280, height: 720, fade: 0.4 };

/** The master's frames, as JPEG, are kept this many ahead of the frame a renderer draws. */
const AHEAD = 8;

/** A command line's flags, written as one string. */
const flags = (text) => text.split(' ');

/** The cut's ffmpeg processes still running, which a stopped cut ends. */
const running = new Set();

/** Spawns `command`, kept in `running` until it closes. */
function track(command, args, options) {
  const child = spawn(command, args, options);
  running.add(child);
  child.once('close', () => running.delete(child));
  child.once('error', () => running.delete(child));
  return child;
}

/** Runs ffmpeg with `args`; rejects with its errors, or when it does not run. */
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = track('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    child.once('error', (error) => reject(new Error(`ffmpeg does not run: ${error.message}`)));
    child.once('close', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg ${args.join(' ')} (exit ${code ?? signal}): ${errors}`)),
    );
  });
}

/** The master's frame count, from its packets (no decoding). */
function frameCountOf(master) {
  const out = execFileSync('ffprobe', [
    ...flags('-v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of csv=p=0'),
    master,
  ]);
  return Number(String(out).trim());
}

/**
 * The master's frames from `from` on, decoded in order to JPEG (ffmpeg's MJPEG, whose headers never hold an end
 * marker, so each frame ends at its first one). `get(n)` resolves with frame `n`'s bytes; the frames before `n - 1`
 * are dropped, and the stream waits while `AHEAD` frames wait to be drawn. A decoder that fails, or ends before a
 * frame the master holds (`total`), throws.
 */
class Decoder {
  constructor(master, from, fps, total) {
    this.next = from;
    this.total = total;
    this.frames = new Map();
    this.ended = false;
    this.failure = null;
    this.closing = false;
    this.wake = () => {};
    const seek = Math.max(0, (from - 0.5) / fps);
    this.child = track(
      'ffmpeg',
      [
        ...flags(`-v error -ss ${seek} -i`),
        master,
        ...flags('-f image2pipe -c:v mjpeg -q:v 2 -pix_fmt yuvj420p pipe:1'),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let errors = '';
    this.child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    let pending = Buffer.alloc(0);
    let searched = 0;
    const end = Buffer.from([0xff, 0xd9]);
    this.child.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      for (;;) {
        const at = pending.indexOf(end, Math.max(0, searched - 1));
        if (at < 0) {
          searched = pending.length;
          break;
        }
        this.frames.set(this.next++, Buffer.from(pending.subarray(0, at + 2)));
        pending = pending.subarray(at + 2);
        searched = 0;
      }
      if (this.frames.size > AHEAD) this.child.stdout.pause();
      this.wake();
    });
    const done = (failure) => {
      this.ended = true;
      if (!this.closing) this.failure ??= failure;
      this.wake();
    };
    this.child.once('error', (error) => done(`ffmpeg does not run: ${error.message}`));
    // Its output read to the end, unlike at its exit.
    this.child.once('close', (code, signal) =>
      done(code === 0 ? null : `decoding the master failed (exit ${code ?? signal}): ${errors.trim()}`),
    );
  }

  async get(n) {
    for (;;) {
      for (const k of this.frames.keys()) if (k < n - 1) this.frames.delete(k);
      if (this.frames.size <= AHEAD) this.child.stdout.resume();
      if (this.frames.has(n)) return this.frames.get(n);
      if (this.ended) {
        if (this.failure) throw new Error(this.failure);
        if (n < this.total) throw new Error(`the master's decoding ended at frame ${this.next - 1}, before frame ${n}`);
        const last = Math.max(...this.frames.keys());
        if (Number.isFinite(last)) return this.frames.get(last);
        throw new Error(`the master has no frame ${n}`);
      }
      await new Promise((resolve) => {
        this.wake = resolve;
      });
    }
  }

  close() {
    this.closing = true;
    this.child.kill();
  }
}

/** The stage's files, the docs' logos, each renderer's current master frame and the contact sheet's images. */
function serve() {
  const frames = new Map();
  const files = new Map();
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  const server = http.createServer((request, response) => {
    const url = decodeURIComponent(new URL(request.url, 'http://stage').pathname);
    const frame = /^\/(r[^/]+)\/master\/\d+\.jpg$/.exec(url);
    let body = null;
    let type = 'image/jpeg';
    if (frame) body = frames.get(frame[1]);
    else if (files.has(url)) body = files.get(url);
    else {
      const name = url.replace(/^\/r[^/]+\//, '/');
      const file = name.startsWith('/assets/')
        ? path.join(LOGOS, path.basename(name))
        : path.join(STAGE, path.basename(name));
      if (fs.existsSync(file)) {
        body = fs.readFileSync(file);
        type = types[path.extname(file)] ?? 'application/octet-stream';
      }
    }
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, frames, files, close: () => server.close() });
    });
  });
}

/** A stage page of renderer `id`, set up for `plan`'s title. */
async function stagePage(browser, server, id, { dpr, title }) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dpr });
  await page.goto(`${server.url}/r${id}/stage.html`);
  await page.evaluate((setup) => window.stage.setup(setup), { title, frame: { bar: TITLE_BAR } });
  return { page };
}

/**
 * Renders the plan's frames `from` to `to` into `file` (H.264, near lossless): each state drawn on the stage and
 * screenshotted, or the last screenshot sent again when neither the state nor the master's frame changed. It stops,
 * throwing, once `halt.reason` is set (another range failed, or the cut was stopped), and returns only once its
 * encoder has ended.
 */
async function renderRange({ browser, server, plan, id, from, to, master, frames, fps, dpr, title, file, halt }) {
  const { page } = await stagePage(browser, server, id, { dpr, title });
  const cdp = await page.context().newCDPSession(page);
  const first = plan.frames.slice(from, to).find((s) => s.frame !== null)?.frame ?? 0;
  const decoder = new Decoder(master, first, fps, frames);
  const encoder = track(
    'ffmpeg',
    [
      ...flags(`-hide_banner -v error -y -f image2pipe -framerate ${OUTPUT_FPS} -c:v png -i -`),
      ...flags('-c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p'),
      file,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let errors = '';
  encoder.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  // The encoder's end, however it comes: a spawn that fails, or its close.
  let failure = null;
  const exit = new Promise((resolve) => {
    encoder.once('error', (error) => {
      failure ??= `ffmpeg does not run: ${error.message}`;
      resolve(null);
    });
    encoder.once('close', (code, signal) => resolve(code ?? signal));
  });
  encoder.stdin.on('error', (error) => {
    failure ??= `the encoder stopped reading (${error.code ?? error.message}): ${errors}`;
  });
  const write = async (shot) => {
    if (failure) throw new Error(failure);
    if (!encoder.stdin.write(shot)) await Promise.race([once(encoder.stdin, 'drain'), exit]);
    if (failure) throw new Error(failure);
  };
  let last = null;
  let drawn = 0;
  const started = Date.now();
  let code;
  try {
    for (let i = from; i < to; i++) {
      if (halt.reason) throw new Error(`the range from frame ${from} stopped: ${halt.reason}`);
      const state = plan.frames[i];
      const jpeg = state.frame === null ? null : await decoder.get(state.frame);
      const key = JSON.stringify({ ...state, t: 0, frame: 0 });
      let shot;
      if (last && last.key === key && (last.jpeg === jpeg || (last.jpeg && jpeg && last.jpeg.equals(jpeg)))) {
        shot = last.shot;
      } else {
        if (jpeg) server.frames.set(`r${id}`, jpeg);
        await page.evaluate((s) => window.stage.draw(s), state);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
        shot = Buffer.from(data, 'base64');
        drawn++;
      }
      last = { key, jpeg, shot };
      await write(shot);
    }
  } catch (error) {
    halt.reason ??= error.message;
    encoder.kill();
    throw error;
  } finally {
    decoder.close();
    encoder.stdin.end();
    code = await exit;
    await page.close().catch(() => {});
  }
  if (failure || code !== 0) throw new Error(`encoding the frames ${from} to ${to} failed: ${failure ?? errors}`);
  return { frames: to - from, drawn, ms: Date.now() - started };
}

/** The ffconcat list of the subtitles' plates (`plates/`), each cue's plate for its time and nothing between. */
function platesList(cues, duration) {
  const lines = ['ffconcat version 1.0'];
  let at = 0;
  const show = (file, seconds) => {
    if (seconds <= 0.001) return;
    lines.push(`file '${file}'`, `duration ${seconds.toFixed(3)}`);
  };
  cues.forEach((cue, i) => {
    show('blank.png', cue.start - at);
    show(`cue-${String(i).padStart(3, '0')}.png`, cue.end - cue.start);
    at = cue.end;
  });
  show('blank.png', duration - at + 1);
  lines.push("file 'blank.png'");
  return `${lines.join('\n')}\n`;
}

/** The size of `file`, in bytes. */
const sizeOf = (file) => fs.statSync(file).size;

/**
 * Cuts the take in `take` (its results folder: `take.json` and its master) into `out`: at `size` (1080 or 2160 lines),
 * its frames rendered by `renderers` stage pages side by side, the beats `beats` alone when given. `say` hears each
 * step. Resolves with the summary it writes to `out/cut.json`.
 */
export async function cut({ take, out, size = 1080, renderers = 2, beats = null, say = () => {}, signal = null }) {
  const started = Date.now();
  const log = JSON.parse(fs.readFileSync(path.join(take, 'take.json'), 'utf8'));
  const master = path.join(take, log.master.file);
  const frames = frameCountOf(master);
  const flashFrame = await findFlash(master, log.flash.box);
  if (flashFrame === null) throw new Error(`no frame of ${master} shows the sync flash`);
  const dpr = size / 1080;
  const plan = planCut(log, { flashFrame, frames, dpr, only: beats });
  const title = log.story[0].lines[0];
  for (const family of ['Inter', 'JetBrains Mono']) {
    const found = String(execFileSync('fc-match', ['-f', '%{family}', family])).split(',')[0];
    if (found !== family) say(`  ${family} is not installed: the stage draws in ${found} instead`);
  }
  say(`The cut: ${plan.duration.toFixed(1)} s, ${plan.frames.length} frames, from ${frames} master frames`);
  say(`  the sync flash at the master's frame ${flashFrame}`);

  // The subtitles and the chapters.
  const cues = plan.cues.map(({ start, end, text }) => ({ start, end, text }));
  fs.writeFileSync(path.join(out, `${NAME}.en.vtt`), toVtt(cues));
  fs.writeFileSync(path.join(out, `${NAME}.en.srt`), toSrt(cues));
  fs.writeFileSync(path.join(out, `${NAME}.chapters.txt`), chaptersText(plan.chapters, plan.duration));
  fs.writeFileSync(path.join(out, `${NAME}.chapters.vtt`), chaptersVtt(plan.chapters, plan.duration));

  const work = path.join(out, '.work');
  fs.mkdirSync(path.join(work, 'plates'), { recursive: true });
  const server = await serve();
  // A signal stops the cut through `showcase.mjs`'s handlers, which abort `signal`: every ffmpeg ends, and the browser.
  const browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  const halt = { reason: null };
  const stop = () => {
    halt.reason ??= `stopped by ${signal.reason}`;
    for (const child of running) child.kill('SIGKILL');
    browser.close().catch(() => {});
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const summary = { take, size, duration: plan.duration, frames: plan.frames.length, flashFrame, master: log.master };
  try {
    // The frames, in `renderers` ranges side by side.
    const count = plan.frames.length;
    const ranges = Array.from({ length: renderers }, (_, i) => [
      Math.round((count * i) / renderers),
      Math.round((count * (i + 1)) / renderers),
    ]).filter(([a, b]) => b > a);
    say(`  rendering ${count} frames in ${ranges.length} ranges`);
    const parts = ranges.map((_, i) => path.join(work, `stage-${i}.mkv`));
    // Every range ends, its encoder too, before a failure of one goes on: the work folder is removed after.
    const fps = log.master.fps;
    const settled = await Promise.allSettled(
      ranges.map(([from, to], id) =>
        renderRange({ browser, server, plan, id, from, to, master, frames, dpr, title, halt, fps, file: parts[id] }),
      ),
    );
    const failed = settled.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    const renders = settled.map((r) => r.value);
    const ms = Math.max(...renders.map((r) => r.ms));
    summary.render = {
      ms,
      drawn: renders.reduce((sum, r) => sum + r.drawn, 0),
      msPerFrame: Math.round(ms / count),
      msPerDrawnFrame: Math.round(renders.reduce((sum, r) => sum + r.ms / Math.max(1, r.drawn), 0) / renders.length),
    };
    say(
      `  rendered in ${(ms / 1000).toFixed(0)} s (${summary.render.msPerFrame} ms a frame, ${summary.render.drawn} drawn)`,
    );
    const stage = path.join(work, 'stage.txt');
    fs.writeFileSync(stage, parts.map((p) => `file '${path.basename(p)}'`).join('\n'));

    // The subtitles' plates, burned into the subtitled cut and the teaser: the cards show their lines themselves.
    const burned = plan.cues.filter((cue) => !cue.card);
    const { page } = await stagePage(browser, server, 'plates', { dpr, title });
    const plates = path.join(work, 'plates');
    await page.evaluate(() => window.stage.plate([]));
    await page.screenshot({ path: path.join(plates, 'blank.png'), omitBackground: true });
    for (const [i, cue] of burned.entries()) {
      await page.evaluate((rows) => window.stage.plate(rows), subtitleRows(cue.text));
      await page.screenshot({ path: path.join(plates, `cue-${String(i).padStart(3, '0')}.png`), omitBackground: true });
    }
    await page.close();
    const platesFile = path.join(plates, 'plates.txt');
    fs.writeFileSync(platesFile, platesList(burned, plan.duration));

    const input = ['-f', 'concat', '-safe', '0', '-i', stage];
    const withPlates = [...input, '-f', 'concat', '-safe', '0', '-i', platesFile];
    const burn = `[1:v]fps=${OUTPUT_FPS},format=yuva420p[s];[0:v][s]overlay=0:0:eof_action=pass,format=yuv420p[v]`;
    const h264 = flags('-c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -an');
    const vp9 = flags('-c:v libvpx-vp9 -crf 34 -b:v 0 -deadline good -cpu-used 4 -row-mt 1 -tile-columns 2 -an');
    const subtitled = ['-filter_complex', burn, '-map', '[v]'];
    const outputs = {};
    const timed = async (name, run) => {
      const t0 = Date.now();
      await run();
      outputs[name] = { bytes: sizeOf(path.join(out, name)), seconds: Math.round((Date.now() - t0) / 1000) };
      say(`  ${name}: ${(outputs[name].bytes / 1e6).toFixed(2)} MB in ${outputs[name].seconds} s`);
    };

    // The full cut.
    await timed(`${NAME}.mp4`, () => ffmpeg([...input, ...h264, path.join(out, `${NAME}.mp4`)]));
    await timed(`${NAME}-subtitled.mp4`, () =>
      ffmpeg([...withPlates, ...subtitled, ...h264, path.join(out, `${NAME}-subtitled.mp4`)]),
    );
    await timed(`${NAME}.webm`, () => ffmpeg([...input, ...vp9, path.join(out, `${NAME}.webm`)]));
    await timed(`${NAME}-subtitled.webm`, () =>
      ffmpeg([...withPlates, ...subtitled, ...vp9, path.join(out, `${NAME}-subtitled.webm`)]),
    );

    // The teaser: its beats' parts, crossfaded, subtitled, muted, within its size.
    const beatSegments = plan.segments.filter((s) => s.kind === 'beat');
    const teaser = teaserParts(beatSegments);
    if (teaser.length) {
      const fade = TEASER.fade;
      const lengths = teaser.map((p) => p.end - p.start);
      const seconds = lengths.reduce((a, b) => a + b, 0) - fade * (teaser.length - 1);
      const graph = [
        `${burn.replace('[v]', '[full]')}`,
        `[full]fps=${OUTPUT_FPS},split=${teaser.length}${teaser.map((_, i) => `[a${i}]`).join('')}`,
      ];
      teaser.forEach((p, i) => graph.push(`[a${i}]trim=start=${p.start}:end=${p.end},setpts=PTS-STARTPTS[p${i}]`));
      let last = 'p0';
      let offset = 0;
      for (let i = 1; i < teaser.length; i++) {
        offset += lengths[i - 1] - fade;
        graph.push(`[${last}][p${i}]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}[x${i}]`);
        last = `x${i}`;
      }
      graph.push(`[${last}]scale=${TEASER.width}:${TEASER.height}:flags=lanczos,format=yuv420p[v]`);
      const filter = ['-filter_complex', graph.join(';'), '-map', '[v]', '-an'];
      const twoPass = async (file, codec, bitrate) => {
        const log = path.join(work, `${path.basename(file)}.pass`);
        const common = [
          ...withPlates,
          ...filter,
          ...codec,
          '-b:v',
          `${Math.round(bitrate / 1000)}k`,
          '-passlogfile',
          log,
        ];
        await ffmpeg([...common, '-pass', '1', '-f', 'null', '/dev/null']);
        await ffmpeg([...common, '-pass', '2', file]);
      };
      for (const [name, codec] of [
        ['teaser.mp4', flags('-c:v libx264 -preset slow -pix_fmt yuv420p -movflags +faststart')],
        ['teaser.webm', flags('-c:v libvpx-vp9 -deadline good -cpu-used 2 -row-mt 1 -pix_fmt yuv420p')],
      ]) {
        await timed(name, async () => {
          let bitrate = (TEASER.aim * 8) / seconds;
          for (let attempt = 0; attempt < 4; attempt++) {
            await twoPass(path.join(out, name), codec, bitrate);
            if (sizeOf(path.join(out, name)) <= TEASER.limit) return;
            bitrate *= 0.85;
          }
          throw new Error(`${name} stays over ${TEASER.limit} bytes`);
        });
      }
      summary.teaser = { seconds, parts: teaser };
    }

    // A clip per beat, muted, and the posters: the full cut's title card, the teaser's first frame, each clip's
    // frame at the middle of its lines.
    fs.mkdirSync(path.join(out, 'clips'), { recursive: true });
    fs.mkdirSync(path.join(out, 'posters'), { recursive: true });
    const clipScale = flags('-vf scale=1920:1080:flags=lanczos');
    const still = flags('-frames:v 1 -q:v 3');
    for (const [i, s] of beatSegments.entries()) {
      const name = `${String(i + 1).padStart(2, '0')}-${s.id}`;
      await timed(`clips/${name}.mp4`, () =>
        ffmpeg([
          ...input,
          ...flags(`-ss ${s.start.toFixed(3)} -to ${s.end.toFixed(3)}`),
          ...clipScale,
          ...flags('-c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -movflags +faststart -an'),
          path.join(out, 'clips', `${name}.mp4`),
        ]),
      );
      const middle = ((s.linesStart + s.linesEnd) / 2).toFixed(3);
      await timed(`posters/${name}.jpg`, () =>
        ffmpeg(['-ss', middle, ...input, ...clipScale, ...still, path.join(out, 'posters', `${name}.jpg`)]),
      );
    }
    const titleCard = plan.segments.find((s) => s.kind === 'card');
    if (titleCard) {
      const at = ((titleCard.start + titleCard.end) / 2).toFixed(3);
      await timed(`posters/${NAME}.jpg`, () =>
        ffmpeg(['-ss', at, ...input, ...clipScale, ...still, path.join(out, 'posters', `${NAME}.jpg`)]),
      );
    }
    if (teaser.length) {
      await timed('posters/teaser.jpg', () =>
        ffmpeg(['-i', path.join(out, 'teaser.mp4'), ...still, path.join(out, 'posters', 'teaser.jpg')]),
      );
    }

    // The contact sheet: a frame of the subtitled cut per beat and card, at the middle of its lines.
    const sheet = [];
    for (const [i, s] of plan.segments.entries()) {
      const at = (s.linesStart + s.linesEnd) / 2;
      const file = path.join(work, `sheet-${i}.jpg`);
      await ffmpeg([
        ...flags(`-ss ${at.toFixed(3)} -i`),
        path.join(out, `${NAME}-subtitled.mp4`),
        ...flags('-frames:v 1 -vf scale=640:360:flags=lanczos -q:v 3'),
        file,
      ]);
      server.files.set(`/sheet/${i}.jpg`, fs.readFileSync(file));
      const number = s.kind === 'card' ? (i === 0 ? 'Title' : 'End') : String(s.number);
      sheet.push({ src: `/sheet/${i}.jpg`, number, title: s.title, time: chapterTime(at) });
    }
    const contact = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await contact.goto(`${server.url}/rsheet/stage.html`);
    await contact.evaluate((items) => window.stage.sheet(items), sheet);
    await timed('contact-sheet.jpg', () =>
      contact.screenshot({ path: path.join(out, 'contact-sheet.jpg'), type: 'jpeg', quality: 88 }),
    );
    await contact.close();
    summary.outputs = outputs;
  } finally {
    signal?.removeEventListener('abort', stop);
    await browser.close().catch(() => {});
    server.close();
    // What still runs (an output's encoder, when the cut failed) ends before its folder goes.
    await Promise.all(
      [...running].map((child) => {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        return closed;
      }),
    );
    fs.rmSync(work, { recursive: true, force: true });
  }
  summary.seconds = Math.round((Date.now() - started) / 1000);
  summary.segments = plan.segments;
  fs.writeFileSync(path.join(out, 'cut.json'), JSON.stringify(summary, null, 2));
  say(`The cut is in ${out}, in ${summary.seconds} s`);
  return summary;
}
