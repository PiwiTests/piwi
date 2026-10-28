// The script's machinery: a beat (its lines, the windows it is about, what it does, what it checks), the gestures a
// beat makes and their log, the lines' lint, and the player that runs the beats in order, each within its budget, and
// keeps the whole screen and every app's log when one fails.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A subtitle row's width, and how many rows a line may take. */
export const ROW_CHARS = 42;
export const MAX_ROWS = 2;
/** The fastest a line may be read, in characters a second. */
export const MAX_READING_CPS = 17;

/**
 * A beat of the story. `lines` are its subtitles, by language; `focus` the windows the camera moves through, in order
 * (`vscode`, `test-browser`, `runs`, `dashboard`, `card`); `seconds` its length in the cut; `run` plays it through the
 * gestures; `check` asserts what it left. A card has no `run`. `budget` bounds `run` and `check` together, in ms.
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

/**
 * The gestures a beat makes, as a person makes them: each waits for its element, logs its box on the screen (device
 * pixels, from the window's place on the screen and the element's box in it), waits `pace.before` ms as a person
 * would, then acts through Playwright, typing `pace.key` ms a key. The log is the cursor and the click marks of the
 * cut; check mode plays it at no pace.
 */
export class Gestures {
  constructor({ windows, scale, pace = { before: 0, key: 0 } }) {
    this.windows = windows;
    this.scale = scale;
    this.pace = pace;
    this.log = [];
    this.beat = null;
  }

  /** The window `name`'s page content origin on the screen, in CSS pixels. */
  async origin(page) {
    return page.evaluate(() => ({
      x: window.screenX + (window.outerWidth - window.innerWidth),
      y: window.screenY + (window.outerHeight - window.innerHeight),
    }));
  }

  async record(kind, window, locator, extra = {}, timeout = undefined) {
    const page = this.windows[window]();
    let box = null;
    if (locator) {
      await locator.waitFor({ state: 'visible', timeout });
      const rect = await locator.boundingBox();
      const origin = await this.origin(page).catch(() => ({ x: 0, y: 0 }));
      if (rect) {
        box = {
          x: Math.round((origin.x + rect.x) * this.scale),
          y: Math.round((origin.y + rect.y) * this.scale),
          width: Math.round(rect.width * this.scale),
          height: Math.round(rect.height * this.scale),
        };
      }
    }
    this.log.push({ t: Date.now(), beat: this.beat, kind, window, box, ...extra });
    if (this.pace.before) await page.waitForTimeout(this.pace.before);
  }

  /** Clicks `locator` in `window`, once it shows within `options.timeout`. */
  async click(window, locator, options = {}) {
    await this.record('click', window, locator, {}, options.timeout);
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

  /** Something the script does off screen that the cut tells (a push, a CI run): logged, not drawn. */
  note(what) {
    this.log.push({ t: Date.now(), beat: this.beat, kind: 'note', what });
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
 * Plays `beats` in order in `mode` (`check`: no capture, no holds, each beat's check), up to the beat `until` when it
 * is given. `hooks.started(beat)` and `hooks.ended(beat)` frame each beat that plays (where a take marks its capture
 * and holds its lines). A beat that throws, or runs past its budget, ends the take: the screen and the logs go to
 * `out` through `keep(beat, dir)`. An assertion a known product bug keeps from passing is left out with
 * `context.skip(bug, what)`, which marks the beat. Resolves with each beat's outcome.
 */
export async function play({ beats, context, out, mode = 'check', until = null, hooks = {}, keep, say }) {
  const outcomes = [];
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
            await context.raise?.(b.focus[0]);
            await hooks.started?.(b);
            await b.run(context);
            await hooks.ended?.(b);
            if (mode === 'check' && b.check) await b.check(context);
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
        fs.mkdirSync(dir, { recursive: true });
        captureScreen(path.join(dir, 'screen.png'));
        await keep(b, dir).catch((why) => say(`    keeping the logs failed: ${why}`));
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
