// The cut's plan, without I/O: from a take's log, the cut's timeline (the title card, each beat the take played, the
// end card), each window's place on the stage, the camera's shots, the pointer's moves, the key strip, the cues and
// the chapters; and, for every output frame, what the stage draws and which master frame it draws from.
import { CALM, around, calmShots, clamp, fit, union, viewAt, viewRect } from './camera.mjs';
import { keyCaps, keysAt, pointerAt, ringsAt } from './cursor.mjs';
import { OUTPUT_FPS, frameCount, lineMs, masterFrame } from './timeline.mjs';

/** The stage's frame above each window's content, and the gap it leaves between windows, in master pixels. */
export const TITLE_BAR = 64;
const GAP = 80;

/** VS Code's own title bar (its menus, its window's title and buttons), in CSS pixels: the stage's frame stands in. */
const VSCODE_TITLE_BAR = 35;

/** What the stage's frame names each window. */
export const WINDOW_NAMES = {
  dashboard: 'Piwi dashboard',
  vscode: 'VS Code',
  'test-browser': 'The test’s browser',
  runs: 'Piwi Picker · Runs',
};

/** Fades, in seconds: a window coming or going, a card, a chapter's label, the fast-forward badge. */
const FADE = { window: 0.35, card: 0.6, chapter: 0.4, fast: 0.2 };

/** A window shown whole smaller than `below` (output pixels a master pixel) zooms in on a gesture, to `scale`. */
const ZOOM = { below: 0.7, scale: 0.75, holdS: 1.4 };

/** The camera leads a gesture by `leadS`; gestures `groupS` apart in other tiles share a shot. */
const SHOT = { leadS: 0.15, groupS: 2.5 };

/**
 * A quiet stretch of a beat (no line read, no gesture, no window coming or going) longer than `afterMs` plays at
 * `rate`, but for `keepMs` at each end.
 */
export const FAST = { rate: 4, afterMs: 3000, keepMs: 600 };

/** A cue ends this long before the next line starts, in seconds. */
const CUE_GAP_S = 0.1;

/** The tiles, which show together; the dashboard's window covers them. */
const TILES = ['vscode', 'test-browser', 'runs'];

/** The last of `events` (`{ t }`, in order) at or before `t`, or null. */
function lastAt(events, t) {
  let found = null;
  for (const event of events) if (event.t <= t) found = event;
  return found;
}

/**
 * The stage's world: each window's content as the master holds it (`crop`, VS Code's without its own title bar), and
 * where the stage draws its frame and content (`frame`, `content`, in master pixels): the right column moved off VS
 * Code, and the Runs window off the test's browser, by `GAP` and the frame's bar. A test's browser the take never
 * reached takes its tile. `scale` is the master's device pixels a CSS pixel.
 */
export function world(windows, scale = 2) {
  const crop = { ...windows };
  const bar = VSCODE_TITLE_BAR * scale;
  crop.vscode = { ...windows.vscode, y: windows.vscode.y + bar, height: windows.vscode.height - bar };
  crop['test-browser'] ??= {
    x: windows.vscode.x + windows.vscode.width,
    y: windows.dashboard.y,
    width: windows.runs.width,
    height: windows.runs.y - windows.dashboard.y,
  };
  const right = Math.max(0, windows.vscode.x + windows.vscode.width + GAP - crop['test-browser'].x);
  const testBottom = crop['test-browser'].y + crop['test-browser'].height;
  const below = Math.max(0, testBottom + GAP + TITLE_BAR - crop.runs.y);
  const offsets = { dashboard: { x: 0, y: 0 }, vscode: { x: 0, y: 0 }, 'test-browser': { x: right, y: 0 } };
  offsets.runs = { x: right, y: below };
  const placed = {};
  for (const [id, r] of Object.entries(crop)) {
    const content = { x: r.x + offsets[id].x, y: r.y + offsets[id].y, width: r.width, height: r.height };
    const frame = { x: content.x, y: content.y - TITLE_BAR, width: r.width, height: r.height + TITLE_BAR };
    placed[id] = { crop: r, content, frame, offset: offsets[id] };
  }
  return placed;
}

/**
 * A beat's time cut into pieces (`{ a, b, rate }`, wall ms) from its `busy` stretches (`[a, b]`): each quiet stretch
 * longer than `FAST.afterMs` plays at `FAST.rate`, but for `FAST.keepMs` at each end.
 */
export function pieces(start, end, busy) {
  const spans = busy
    .map(([a, b]) => [Math.max(start, a), Math.min(end, b)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  let at = start;
  const quiet = (a, b) => {
    if (b - a > FAST.afterMs) {
      out.push({ a, b: a + FAST.keepMs, rate: 1 });
      out.push({ a: a + FAST.keepMs, b: b - FAST.keepMs, rate: FAST.rate });
      out.push({ a: b - FAST.keepMs, b, rate: 1 });
    } else if (b > a) out.push({ a, b, rate: 1 });
  };
  for (const [a, b] of spans) {
    if (a > at) quiet(at, a);
    if (b > at) {
      out.push({ a: Math.max(a, at), b, rate: 1 });
      at = b;
    }
  }
  quiet(at, end);
  // Neighbours at the same rate become one piece.
  return out.reduce((merged, p) => {
    const last = merged.at(-1);
    if (last && last.rate === p.rate && last.b === p.a) last.b = p.b;
    else merged.push({ ...p });
    return merged;
  }, []);
}

/** The cut's seconds at the wall-clock `w` within `segment`'s pieces. */
function cutAt(segment, w) {
  const clamped = Math.min(Math.max(w, segment.wall.start), segment.wall.end);
  for (const p of segment.pieces) {
    if (clamped <= p.b) return p.cut + (clamped - p.a) / p.rate / 1000;
  }
  return segment.end;
}

/** The wall-clock ms at the cut's `t` within `segment`, and the rate it plays at. */
function wallAt(segment, t) {
  let piece = segment.pieces[0];
  for (const p of segment.pieces) if (p.cut <= t) piece = p;
  return { w: Math.min(piece.b, piece.a + (t - piece.cut) * piece.rate * 1000), rate: piece.rate };
}

/** The windows a beat shows: those of its focus, then those its gestures act in. */
function beatWindows(story, gestures) {
  const ids = [...story.focus, ...gestures.map((g) => g.window)].filter((id) => id && id !== 'card');
  return [...new Set(ids)];
}

/** What the key strip shows for a gesture or a note, or null. */
function strip(g) {
  if (g.kind === 'key') return { caps: keyCaps(g.key), label: null };
  if (g.kind === 'command') return { caps: ['F1'], label: g.title };
  if (g.kind === 'note' && g.call) {
    const detail = g.call.args?.action ?? g.call.args?.kind ?? null;
    return { caps: ['Agent'], label: detail ? `${g.call.name} · ${detail}` : g.call.name };
  }
  if (g.kind === 'note') return { caps: [], label: g.what };
  return null;
}

/**
 * The plan of the cut of `log` (a take's `take.json`), whose master's first frame showing the sync flash is
 * `flashFrame` and which holds `frames` frames, for an output `width` CSS pixels wide at `dpr` device pixels each.
 * `only` keeps those beats alone, without the cards.
 */
export function planCut(log, { flashFrame, frames, width = 1920, dpr = 1, only = null }) {
  const fps = log.master.fps;
  const masterSeconds = (w) => (flashFrame - 0.5) / fps + (w - log.flash.t) / 1000;
  const placed = world(log.windows, log.screen.scale);
  const limits = { minWidth: width * dpr };
  const span = viewRect(fit(union(Object.values(placed).map((p) => p.frame)))).width;
  const raises = log.raises ?? [];
  const presence = log.presence ?? [];
  const layerAt = (w) => lastAt(raises, w)?.up ?? 'dashboard';
  const openAt = (id, w) =>
    lastAt(
      presence.filter((p) => p.window === id),
      w,
    )?.open ?? false;
  const showable = (id, w) =>
    id === 'dashboard'
      ? layerAt(w) === 'dashboard'
      : layerAt(w) === 'tiles' && (id !== 'test-browser' || openAt(id, w));
  const fitOf = (ids) => fit(union(ids.map((id) => placed[id].frame)));
  const toWorld = (g) => ({ x: g.point.x + placed[g.window].offset.x, y: g.point.y + placed[g.window].offset.y });

  // The timeline.
  const segments = [];
  let t = 0;
  const card = (story) => {
    let at = t;
    const lines = story.lines.map((text) => {
      const line = { text, start: at, end: at + lineMs(text) / 1000 - CUE_GAP_S };
      at += lineMs(text) / 1000;
      return line;
    });
    const seconds = Math.max(story.seconds ?? 0, at - t);
    segments.push({ kind: 'card', id: story.id, title: story.title, start: t, end: t + seconds, lines });
    t += seconds;
  };
  const cards = only ? [] : log.story.filter((s) => s.card);
  if (cards[0] && cards[0] === log.story[0]) card(cards[0]);
  let number = 0;
  for (const story of log.story) {
    if (story.card) continue;
    number++;
    const beat = log.beats.find((b) => b.id === story.id);
    if (!beat?.end || (only && !only.includes(story.id))) continue;
    const gestures = log.gestures.filter((g) => g.beat === story.id);
    const changes = [...raises, ...presence].filter((e) => e.t > beat.start && e.t < beat.end);
    const busy = [
      [beat.start, beat.start + 1000],
      [beat.end - 1200, beat.end],
      ...beat.lines.map((l) => [l.start, l.start + l.ms]),
      ...gestures.map((g) => (g.kind === 'note' ? [g.t - 300, g.t + 1600] : [g.t - 600, (g.act ?? g.t) + 1200])),
      ...changes.map((e) => [e.t - 400, e.t + 1600]),
    ];
    const segment = { kind: 'beat', id: story.id, title: story.title, number, story, beat, gestures, start: t };
    segment.wall = { start: beat.start, end: beat.end };
    segment.pieces = pieces(beat.start, beat.end, busy);
    for (const p of segment.pieces) {
      p.cut = t;
      t += (p.b - p.a) / p.rate / 1000;
    }
    segment.end = t;
    segment.windows = beatWindows(story, gestures);
    segment.lines = beat.lines.map((l) => ({
      text: l.text,
      start: cutAt(segment, l.start),
      end: cutAt(segment, l.start + l.ms) - CUE_GAP_S,
    }));
    segments.push(segment);
  }
  const last = cards.at(-1);
  if (last && last === log.story.at(-1)) card(last);
  const duration = t;
  const beats = segments.filter((s) => s.kind === 'beat');
  // A master that stopped early would freeze the cut on its last frame: it is refused.
  const needed = beats.length ? masterSeconds(beats.at(-1).wall.end) * fps : 0;
  if (needed > frames + 1) {
    throw new Error(
      `the master holds ${frames} frames, ${(frames / fps).toFixed(1)} s, but the take's last beat ends at its ` +
        `${(needed / fps).toFixed(1)} s: its capture stopped early`,
    );
  }

  // The camera's shots, the pointer's moves and the key strip, in the cut's seconds.
  const shots = [];
  const moves = [];
  const keys = [];
  for (const segment of beats) {
    const { story, gestures, beat } = segment;
    const inBeat = (id) => segment.windows.includes(id) && placed[id];
    const at = (w) => cutAt(segment, w);
    // The beat raises its window as it starts.
    const first = segment.windows.find((id) => showable(id, beat.start + 500)) ?? segment.windows[0];
    let key = first;
    const shoot = (time, ids, view = fitOf(ids)) => {
      const next = view.key ?? ids.join('+');
      if (next === key) return;
      key = next;
      // What the shot shows: its windows, or a zoom's region.
      const rect = view.key ? viewRect(view) : union(ids.map((id) => placed[id].frame));
      shots.push({ t: time, view, rect, ids, beat: segment.id });
    };
    const start = segment === beats[0] ? 0 : segment.start;
    shots.push({ t: start, view: fitOf([first]), rect: placed[first].frame, ids: [first], beat: segment.id });

    // What a beat's camera follows: its gestures, the window a raise brings up (before the gesture that needs it
    // waits for its element), the windows that come up in it, and, in a beat without gestures, its lines, each
    // showing the next window of its focus.
    const acting = gestures.filter((g) => g.kind !== 'note' && inBeat(g.window));
    const within = (e) => e.t > beat.start && e.t < beat.end;
    const raised = raises
      .filter((r) => within(r) && inBeat(r.window))
      .map((r) => ({ t: r.t, window: r.window, kind: 'raise' }));
    const appearing = presence
      .filter((p) => p.open && within(p) && inBeat(p.window))
      .map((p) => ({ t: p.t, window: p.window, kind: 'appear' }));
    const lineShots = [];
    if (!acting.length) {
      const focus = story.focus.filter(inBeat);
      beat.lines.forEach((line, i) => {
        if (i === 0) return;
        const all = i === beat.lines.length - 1 && focus.length > beat.lines.length;
        lineShots.push({ t: line.start, ids: all ? focus : [focus[Math.min(i, focus.length - 1)]], kind: 'line' });
      });
    }
    const events = [...acting, ...raised, ...appearing, ...lineShots].sort((a, b) => a.t - b.t);
    events.forEach((e, i) => {
      // A shot leads its event, within the beat: the beat's first shot comes first.
      const time = Math.max(segment.start + 0.001, at(e.t) - SHOT.leadS);
      const layer = e.window === 'dashboard' || e.ids?.includes('dashboard') ? 'dashboard' : 'tiles';
      if (e.kind === 'line') {
        const ids = e.ids.filter((id) => showable(id, e.t + 1));
        if (ids.length) shoot(time, ids);
        return;
      }
      if (e.kind === 'raise') {
        shoot(time, [e.window]);
        return;
      }
      if (e.kind === 'appear') {
        const ids = segment.windows.filter((id) => TILES.includes(id) && (id === e.window || showable(id, e.t + 1)));
        shoot(time, ids);
        return;
      }
      // Gestures soon after in other tiles share the shot.
      const soon = events
        .slice(i, i + 6)
        .filter((n) => n.window && !['appear', 'raise'].includes(n.kind) && n.t - e.t <= SHOT.groupS * 1000)
        .map((n) => n.window)
        .filter((id) => (layer === 'tiles') === TILES.includes(id));
      const ids = [...new Set(soon)];
      const whole = fitOf([e.window]);
      if (ids.length === 1 && e.point && (width * dpr) / whole.width < ZOOM.below) {
        const zoomed = around(toWorld(e), (width * dpr) / ZOOM.scale);
        const frame = placed[e.window].frame;
        const inside = (v, lo, size, w) => Math.min(Math.max(v, lo + w / 2), lo + size - w / 2);
        zoomed.cx = inside(zoomed.cx, frame.x, frame.width, zoomed.width);
        zoomed.cy = inside(zoomed.cy, frame.y, frame.height, zoomed.width / (16 / 9));
        zoomed.key = `${e.window}@${Math.round(zoomed.cx / 200)},${Math.round(zoomed.cy / 200)}`;
        shoot(time, ids, zoomed);
        const next = events[i + 1];
        const back = (e.act ?? e.t) + ZOOM.holdS * 1000;
        if (!next || next.t - 600 > back) shoot(at(back), ids);
      } else shoot(time, ids);
    });

    for (const g of gestures) {
      if (g.point && placed[g.window]) {
        moves.push({ t: at(g.t), act: at(g.act ?? g.t), to: toWorld(g), click: g.kind === 'click' });
      }
      const shown = strip(g);
      if (shown) keys.push({ at: at(g.kind === 'note' ? g.t : (g.act ?? g.t)), ...shown });
    }
  }

  shots.sort((a, b) => a.t - b.t);
  // A window reads at the cut's size when a CSS pixel of its page takes an output pixel or more.
  const dprOf = (id) => log.windows[id]?.dpr ?? log.screen.scale;
  const readable = (view, ids) => (width / view.width) * Math.min(...ids.map(dprOf)) >= CALM.readable;
  const camera = calmShots(shots, { limits, readable });
  /** The camera's moves along `list`: each shot whose view differs from the one before, with both scales. */
  const movesOf = (list) =>
    list.slice(1).flatMap((shot, i) => {
      const from = clamp(list[i].view, limits);
      const to = clamp(shot.view, limits);
      const same =
        Math.abs(from.cx - to.cx) < 1 && Math.abs(from.cy - to.cy) < 1 && Math.abs(from.width - to.width) < 1;
      return same ? [] : [{ t: shot.t, beat: shot.beat, from: width / from.width, to: width / to.width }];
    });

  // Every output frame, in order: what the stage draws.
  const count = frameCount(duration);
  const opacity = {};
  let fast = 0;
  const states = [];
  const titleCard = segments.find((s) => s.kind === 'card' && s === segments[0]);
  const endCard = segments.findLast((s) => s.kind === 'card' && s === segments.at(-1));
  for (let i = 0; i < count; i++) {
    const time = i / OUTPUT_FPS;
    const segment = segments.findLast((s) => s.start <= time) ?? segments[0];
    // A card shows over the beat next to it, held at its first or last frame.
    const beat = segment.kind === 'beat' ? segment : segment === titleCard ? beats[0] : beats.at(-1);
    let wall = null;
    let rate = 1;
    if (beat) {
      if (segment.kind === 'beat') ({ w: wall, rate } = wallAt(beat, time));
      else wall = segment === titleCard ? beat.wall.start : beat.wall.end;
    }
    const view = viewAt(camera, time, { limits, span });
    const fastStep = 1 / OUTPUT_FPS / FADE.fast;
    fast = Math.min(1, Math.max(0, fast + (rate > 1 ? fastStep : -fastStep)));
    const s = width / view.width;
    const rect = viewRect(view);
    const out = (r) => ({ x: (r.x - rect.x) * s, y: (r.y - rect.y) * s, width: r.width * s, height: r.height * s });
    const windows = [];
    for (const id of Object.keys(placed)) {
      const shown = Boolean(beat && wall !== null && beat.windows.includes(id) && showable(id, wall));
      const step = 1 / OUTPUT_FPS / FADE.window;
      opacity[id] = i === 0 ? Number(shown) : Math.min(1, Math.max(0, (opacity[id] ?? 0) + (shown ? step : -step)));
      if (opacity[id] > 0.001) {
        const p = placed[id];
        windows.push({
          id,
          name: WINDOW_NAMES[id],
          opacity: opacity[id],
          frame: out(p.frame),
          content: out(p.content),
          crop: p.crop,
        });
      }
    }
    let cardShown = null;
    if (titleCard && time < titleCard.end + FADE.card) {
      cardShown = { id: titleCard.id, opacity: Math.min(1, 1 - (time - titleCard.end) / FADE.card) };
    } else if (endCard && time >= endCard.start) {
      cardShown = { id: endCard.id, opacity: Math.min(1, (time - endCard.start) / FADE.card) };
    }
    const under = 1 - (cardShown?.opacity ?? 0);
    const pointer = pointerAt(moves, time);
    const chapter =
      segment.kind === 'beat'
        ? {
            number: segment.number,
            title: segment.title,
            opacity: Math.max(
              0,
              Math.min(1, (time - segment.start) / FADE.chapter, (segment.end - time) / FADE.chapter),
            ),
          }
        : null;
    const toOut = (p) => ({ x: (p.x - rect.x) * s, y: (p.y - rect.y) * s });
    states.push({
      t: time,
      frame: wall === null ? null : masterFrame(masterSeconds(wall), { fps, frames }),
      scale: s,
      windows,
      pointer:
        pointer && under > 0 ? { ...toOut(pointer), opacity: pointer.opacity * under, pressed: pointer.pressed } : null,
      rings: ringsAt(moves, time).map((r) => ({ ...toOut(r), progress: r.progress, opacity: r.opacity * under })),
      keys: segment.kind === 'beat' ? keysAt(keys, time) : null,
      chapter,
      fast: fast > 0 ? { rate: FAST.rate, opacity: fast } : null,
      card: cardShown,
    });
  }
  const cues = segments.flatMap((segment) =>
    segment.lines.map((line) => ({ ...line, card: segment.kind === 'card', beat: segment.id })),
  );
  const chapters = segments.map((segment) => ({
    start: segment.start,
    title: segment.title,
    id: segment.id,
    card: segment.kind === 'card',
  }));
  return {
    duration,
    frames: states,
    moves: { planned: movesOf(shots), kept: movesOf(camera) },
    cues,
    chapters,
    segments: segments.map((segment) => ({
      kind: segment.kind,
      id: segment.id,
      number: segment.number ?? null,
      title: segment.title,
      start: segment.start,
      end: segment.end,
      linesStart: segment.lines[0]?.start ?? segment.start,
      linesEnd: segment.lines.at(-1)?.end ?? segment.end,
      fast: segment.pieces?.filter((p) => p.rate > 1).reduce((sum, p) => sum + (p.b - p.a) / 1000, 0) ?? 0,
    })),
  };
}
