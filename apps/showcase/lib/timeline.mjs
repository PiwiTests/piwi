// The cut's clock, without I/O: how long a line holds in a take, the master's frame for an output frame, the cues and
// their subtitle files, the chapters, and the parts of the cut the teaser is made of.
import { ROW_CHARS, wrap } from './script.mjs';

/** A line's reading speed without a voice, in characters a second, and the pause after it. */
export const READING_CPS = 15;
export const LINE_PAUSE_S = 0.4;

/** The master's frame rate (x11grab) and the cut's. */
export const MASTER_FPS = 24;
export const OUTPUT_FPS = 30;

/** The beats the teaser is made of, in order. */
export const TEASER_BEATS = ['red-run', 'paused', 'right-locator', 'green'];

/** How long a line holds: its reading time at `READING_CPS`, then `LINE_PAUSE_S`. In ms. */
export function lineMs(text) {
  return Math.round((text.length / READING_CPS + LINE_PAUSE_S) * 1000);
}

/** The lines of a beat read one after another from `start` (ms): each with its start and length, in ms. */
export function scheduleLines(lines, start) {
  let at = start;
  return lines.map((text) => {
    const line = { text, start: at, ms: lineMs(text) };
    at += line.ms;
    return line;
  });
}

/** The master's frame on screen at `seconds` of the master: the nearest one, within its `frames`. */
export function masterFrame(seconds, { fps = MASTER_FPS, frames = Number.POSITIVE_INFINITY } = {}) {
  return Math.min(Math.max(0, Math.round(seconds * fps)), frames - 1);
}

/** The output frames of `seconds` of cut, at `fps`. */
export function frameCount(seconds, fps = OUTPUT_FPS) {
  return Math.round(seconds * fps);
}

/**
 * A line's rows as a subtitle shows them: one row when it fits `width`, else two rows as even as the words allow, each
 * within `width`.
 */
export function subtitleRows(text, width = ROW_CHARS) {
  const words = text.split(/\s+/).filter(Boolean);
  if (text.length <= width) return [words.join(' ')];
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const rows = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    if (rows.some((row) => row.length > width)) continue;
    const spread = Math.abs(rows[0].length - rows[1].length);
    if (!best || spread < best.spread) best = { rows, spread };
  }
  return best?.rows ?? wrap(text, width);
}

/** `seconds` as a cue's time: `HH:MM:SS.mmm`, or with `,` before the milliseconds for SubRip. */
export function cueTime(seconds, separator = '.') {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

/** `text` as a WebVTT cue holds it: `&`, `<` and `>` as their character references. */
export function vttText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** WebVTT of `cues` (`{ start, end, text }`, seconds), each line in its subtitle rows. */
export function toVtt(cues) {
  const blocks = cues.map(
    (cue, i) =>
      `${i + 1}\n${cueTime(cue.start)} --> ${cueTime(cue.end)}\n${subtitleRows(cue.text).map(vttText).join('\n')}`,
  );
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/** SubRip of `cues`, as `toVtt`. */
export function toSrt(cues) {
  const blocks = cues.map(
    (cue, i) =>
      `${i + 1}\n${cueTime(cue.start, ',')} --> ${cueTime(cue.end, ',')}\n${subtitleRows(cue.text).join('\n')}`,
  );
  return `${blocks.join('\n\n')}\n`;
}

/** `seconds` as a chapter list writes it: `M:SS`, or `H:MM:SS` past the hour. */
export function chapterTime(seconds) {
  const s = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** The shortest chapter a video site lists (YouTube's), in seconds. */
export const CHAPTER_MIN_S = 10;

/**
 * `chapters` (`{ start, title, card }`, in order, the cut ending at `end`) with none shorter than `min`: a card joins
 * the beat beside it, under the beat's title; another short chapter joins its shorter neighbour, their titles joined.
 * The first starts at 0.
 */
export function foldChapters(chapters, end, min = CHAPTER_MIN_S) {
  let list = chapters.map((c) => ({ ...c }));
  const length = (i) => (list[i + 1]?.start ?? end) - list[i].start;
  for (;;) {
    if (list.length < 2) break;
    const lengths = list.map((_, i) => length(i));
    const short = lengths.findIndex((l) => l < min);
    if (short < 0) break;
    // The neighbour it joins: the one beside a card, else the shorter of the two.
    const before = short - 1;
    const after = short + 1 < list.length ? short + 1 : -1;
    const into = before < 0 ? after : after < 0 ? before : lengths[before] <= lengths[after] ? before : after;
    const [first, second] = into < short ? [into, short] : [short, into];
    const a = list[first];
    const b = list[second];
    const title = a.card ? b.title : b.card ? a.title : `${a.title}, ${b.title}`;
    list = [
      ...list.slice(0, first),
      { start: a.start, title, card: Boolean(a.card && b.card) },
      ...list.slice(second + 1),
    ];
  }
  if (list.length) list[0].start = 0;
  return list;
}

/**
 * The chapter list video sites read (`0:00 Title`, one a line, from 0:00) of `chapters` (`{ start, title, card }`),
 * the cut ending at `end`, folded so that none is shorter than `CHAPTER_MIN_S`.
 */
export function chaptersText(chapters, end) {
  return `${foldChapters(chapters, end)
    .map((c) => `${chapterTime(c.start)} ${c.title}`)
    .join('\n')}\n`;
}

/** WebVTT chapters (a `<track kind="chapters">`) of `chapters`, each ending where the next starts, the last at `end`. */
export function chaptersVtt(chapters, end) {
  const blocks = chapters.map(
    (c, i) => `${i + 1}\n${cueTime(c.start)} --> ${cueTime(chapters[i + 1]?.start ?? end)}\n${vttText(c.title)}`,
  );
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/**
 * The parts of the cut the teaser is made of: for each beat of `ids` found in `beats` (`{ id, start, end, linesEnd }`,
 * the cut's seconds), from its start through its lines and `tail` more, within the beat. Parts shorter in all than
 * `target` seconds grow, evenly, toward their beat's end; longer than `target` by more than `slack`, they shrink,
 * evenly, from their end. The parts keep the order of `ids`.
 */
export function teaserParts(beats, { ids = TEASER_BEATS, target = 30, tail = 0.6, slack = 0.1 } = {}) {
  const parts = ids
    .map((id) => beats.find((b) => b.id === id))
    .filter(Boolean)
    .map((b) => ({ id: b.id, start: b.start, end: Math.min(b.end, b.linesEnd + tail), limit: b.end }));
  const total = () => parts.reduce((sum, p) => sum + (p.end - p.start), 0);
  for (let round = 0; round < parts.length && total() < target - 1e-6; round++) {
    const growing = parts.filter((p) => p.end < p.limit);
    if (!growing.length) break;
    const share = (target - total()) / growing.length;
    for (const p of growing) p.end = Math.min(p.limit, p.end + share);
  }
  if (total() > target * (1 + slack)) {
    const ratio = target / total();
    for (const p of parts) p.end = p.start + (p.end - p.start) * ratio;
  }
  return parts.map(({ id, start, end }) => ({ id, start, end }));
}
