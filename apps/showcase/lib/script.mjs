// The script's machinery: a beat (its lines, the windows it is about, what it does, what it checks), the gestures a
// beat makes and their log, the lines' lint, and the player that runs the beats in order, each within its budget, and
// keeps the whole screen and every app's log when one fails.
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/** A subtitle row's width, and how many rows a line may take. */
export const ROW_CHARS = 42;
export const MAX_ROWS = 2;
/** The fastest a line may be read, in characters a second. */
export const MAX_READING_CPS = 17;

/**
 * A beat of the story. `title` names its chapter; `lines` are its subtitles, by language; `focus` the windows the
 * camera moves through, in order (`vscode`, `test-browser`, `runs`, `dashboard`, `card`); `seconds` its length in the
 * cut; `run` plays it through the gestures; `check` asserts what it left. A card has no `run`. `budget` bounds `run`
 * and `check` together, in ms.
 */
export function beat(definition) {
  return { focus: [], budget: 180_000, ...definition };
}

/** A check's assertion: throws with `message` unless `condition` holds. */
export function expect(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
}

/** Polls `read` until it returns something truthy, for `ms` at most; throws naming `what` otherwise. */
export async function waitFor(read, what, ms = 30_000, every = 250) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await read();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      const why = last instanceof Error ? `: ${last.message}` : '';
      throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${why}`);
    }
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/** The rows a line wraps into at `width` characters, words kept whole. */
export function wrap(line, width = ROW_CHARS) {
  const rows = [];
  let row = '';
  for (const word of line.split(/\s+/).filter(Boolean)) {
    if (!row) row = word;
    else if (row.length + 1 + word.length <= width) row += ` ${word}`;
    else {
      rows.push(row);
      row = word;
    }
  }
  if (row) rows.push(row);
  return rows;
}

/** What is wrong with the lines of `beats` in `language`: a line over two rows, a beat whose lines read too fast. */
export function lintLines(beats, language = 'en') {
  const problems = [];
  for (const b of beats) {
    const lines = b.lines?.[language] ?? [];
    if (!b.title) problems.push(`${b.id}: no title, which names its chapter`);
    if (!lines.length) problems.push(`${b.id}: no line in ${language}`);
    for (const line of lines) {
      const rows = wrap(line);
      if (rows.length > MAX_ROWS || rows.some((row) => row.length > ROW_CHARS)) {
        problems.push(`${b.id}: "${line}" takes ${rows.length} rows of ${ROW_CHARS} characters (${MAX_ROWS} at most)`);
      }
    }
    const characters = lines.join(' ').length;
    if (b.seconds && characters / b.seconds > MAX_READING_CPS) {
      problems.push(
        `${b.id}: ${characters} characters in ${b.seconds} s read at ${(characters / b.seconds).toFixed(1)} a second (${MAX_READING_CPS} at most)`,
      );
    }
  }
  return problems;
}

/** What a page tells of its window and itself: the window's place and size, its viewport, its device pixel ratio. */
export function screenMetrics(page) {
  return page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
}

/**
 * A page's content on the screen, in device pixels, from its `screenMetrics` in a browser at `scale`: the window's
 * place and size count in the browser's own pixels (`scale` device pixels each), the viewport in the page's (`dpr`
 * each, which a page zoom raises), and the content sits at the window's bottom right, below its toolbar.
 */
export function contentOnScreen(m, scale) {
  return {
    x: Math.round((m.screenX + m.outerWidth) * scale - m.innerWidth * m.dpr),
    y: Math.round((m.screenY + m.outerHeight) * scale - m.innerHeight * m.dpr),
    width: Math.round(m.innerWidth * m.dpr),
    height: Math.round(m.innerHeight * m.dpr),
    dpr: m.dpr,
  };
}

/**
 * The gestures a beat makes, as a person makes them: each waits for its element, logs its box and the point it acts at
 * on the screen (device pixels, from the window's place on the screen and the element's box in it), waits
 * `pace.before` ms as a person would, then acts through Playwright, typing `pace.key` ms a key. An entry's `t` is when
 * the gesture starts and `act` when it acts. `prepare(window)`, when given, runs first (a take raises the window
 * there). The log is the pointer and the click marks of the cut; check mode plays it at no pace.
 */
export class Gestures {
  constructor({ windows, scale, pace = { before: 0, key: 0 }, prepare = null }) {
    this.windows = windows;
    this.scale = scale;
    this.pace = pace;
    this.prepare = prepare;
    this.log = [];
    this.beat = null;
  }

  /** The window's page content on the screen (`contentOnScreen`), in device pixels. */
  async view(page) {
    return contentOnScreen(await screenMetrics(page), this.scale);
  }

  async record(kind, window, locator, extra = {}, options = {}) {
    await this.prepare?.(window);
    const page = this.windows[window]();
    let box = null;
    let point = null;
    if (locator) {
      await locator.waitFor({ state: 'visible', timeout: options.timeout });
      // A paced take scrolls the element into view first, as the click does, so its box is where the pointer goes.
      if (this.pace.before) await locator.scrollIntoViewIfNeeded({ timeout: options.timeout }).catch(() => {});
      const rect = await locator.boundingBox();
      const view = await this.view(page).catch(() => ({
        x: 0,
        y: 0,
        width: Infinity,
        height: Infinity,
        dpr: this.scale,
      }));
      if (rect) {
        const s = view.dpr;
        box = {
          x: Math.round(view.x + rect.x * s),
          y: Math.round(view.y + rect.y * s),
          width: Math.round(rect.width * s),
          height: Math.round(rect.height * s),
        };
        // Where Playwright acts: the given position, else the box's middle, within the window.
        const at = options.position
          ? { x: rect.x + options.position.x, y: rect.y + options.position.y }
          : { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const inside = (v, size) => Math.min(Math.max(v, 0), size);
        point = {
          x: Math.round(view.x + inside(at.x * s, view.width)),
          y: Math.round(view.y + inside(at.y * s, view.height)),
        };
      }
    }
    const entry = { t: Date.now(), beat: this.beat, kind, window, box, point, ...extra };
    this.log.push(entry);
    if (this.pace.before) await new Promise((resolve) => setTimeout(resolve, this.pace.before));
    entry.act = Date.now();
  }

  /** Clicks `locator` in `window`, once it shows within `options.timeout`. */
  async click(window, locator, options = {}) {
    await this.record('click', window, locator, {}, options);
    await locator.click(options);
  }

  /** Types `text` into `locator` in `window`, key by key. */
  async type(window, locator, text) {
    await this.record('type', window, locator, { text });
    await locator.pressSequentially(text, { delay: this.pace.key });
  }

  /** Presses `key` (`F9`, `Control+S`) in `window`, where its focus is. */
  async press(window, key) {
    await this.record('key', window, null, { key });
    await this.windows[window]().keyboard.press(key);
  }

  /** Runs the command `title` in `window` through `run` (VS Code's palette, from F1). */
  async command(window, title, run) {
    await this.record('command', window, null, { title });
    await run();
  }

  /** Something the script does off screen that the cut tells (a push, an agent's call): logged, not drawn. */
  note(what, extra = {}) {
    this.log.push({ t: Date.now(), beat: this.beat, kind: 'note', what, ...extra });
  }
}

/** Writes the whole X screen to `file`, with ImageMagick's `import`, else one frame of ffmpeg's; best-effort. */
export function captureScreen(file) {
  const attempts = [
    ['import', ['-window', 'root', file]],
    [
      'ffmpeg',
      ['-loglevel', 'error', '-y', '-f', 'x11grab', '-i', process.env.DISPLAY ?? ':0', '-frames:v', '1', file],
    ],
  ];
  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, { timeout: 30_000, stdio: 'ignore' });
      return true;
    } catch {
      // The next one.
    }
  }
  return false;
}

/**
 * Plays `beats` in order in `mode` (`check`: no capture, no holds; `film`: the take's capture and holds), each beat's
 * check in both, up to the beat `until` when it is given. `hooks.started(beat)` and `hooks.ended(beat)` frame each beat
 * that plays, its check included (where a take marks the beat and holds it while its lines are read). A beat that
 * throws, or runs past its budget, ends the take: `keep(beat, dir)` writes the screen and the logs as they stand into
 * `out/failed-<beat>`. An assertion a known product bug keeps from passing is left out with
 * `context.skip(bug, what)`, which marks the beat. Each beat's outcome goes into `outcomes` as it ends, which the
 * promise resolves with.
 */
export async function play({
  beats,
  context,
  out,
  mode = 'check',
  until = null,
  hooks = {},
  keep,
  say,
  outcomes = [],
}) {
  for (const b of beats) {
    const started = Date.now();
    const skipped = [];
    context.gesture.beat = b.id;
    context.skip = (bug, what) => skipped.push({ bug, what });
    const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
    if (!b.run) {
      outcomes.push({ id: b.id, outcome: 'card' });
      say(`  · ${b.id}: a card, nothing to play in ${mode} mode`);
    } else {
      let timer;
      try {
        await Promise.race([
          (async () => {
            await hooks.started?.(b);
            await context.raise?.(b.focus[0]);
            await b.run(context);
            if (b.check) await b.check(context);
            await hooks.ended?.(b);
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`ran past its budget of ${b.budget / 1000} s`)), b.budget);
          }),
        ]);
        outcomes.push({ id: b.id, outcome: skipped.length ? 'passed-with-skips' : 'passed', skipped });
        say(`  ✓ ${b.id} (${seconds()} s)`);
        for (const { bug, what } of skipped) say(`    skipped for a known bug (${bug}): ${what}`);
      } catch (error) {
        const dir = path.join(out, `failed-${b.id}`);
        await keep(b, dir).catch((why) => say(`    keeping the screen and the logs failed: ${why}`));
        say(`  ✗ ${b.id} (${seconds()} s): ${error.stack ?? error}`);
        say(`    the screen and the logs are in ${dir}`);
        outcomes.push({ id: b.id, outcome: 'failed', error: String(error.message ?? error) });
        return outcomes;
      } finally {
        clearTimeout(timer);
      }
    }
    if (until && b.id === until) break;
  }
  return outcomes;
}
