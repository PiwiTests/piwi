// The cut's camera, without I/O: a view of the stage's world (its center and width, at the output's aspect), eased from
// one shot to the next, never closer than the master's own pixels.

/** The output's aspect. */
export const ASPECT = 16 / 9;

/** A move's length, by how far it goes: 0.6 s for a small one, up to 0.9 s across the world. */
export const MOVE_S = { min: 0.6, max: 0.9 };

/** Ease in and out, cubic: 0 at 0, 1 at 1, flat at both ends. */
export function ease(x) {
  const t = Math.min(1, Math.max(0, x));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** The smallest rectangle holding `rects` (`{ x, y, width, height }`). */
export function union(rects) {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** The view (`{ cx, cy, width }`) that shows `rect` whole with a margin of `pad` of its size on each side. */
export function fit(rect, pad = 0.04) {
  const width = Math.max(rect.width * (1 + 2 * pad), rect.height * (1 + 2 * pad) * ASPECT);
  return { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, width };
}

/** The view `around` a point, `width` wide. */
export function around(point, width) {
  return { cx: point.x, cy: point.y, width };
}

/**
 * `view` no closer than `minWidth` of the world (the output's width in master pixels: one output pixel a master
 * pixel at most), nor wider than `maxWidth`.
 */
export function clamp(view, { minWidth, maxWidth = Number.POSITIVE_INFINITY }) {
  return { ...view, width: Math.min(maxWidth, Math.max(minWidth, view.width)) };
}

/** How long the move from `from` to `to` takes, in seconds, for a world `span` wide. */
export function moveSeconds(from, to, span) {
  const distance = Math.hypot(to.cx - from.cx, to.cy - from.cy) + Math.abs(Math.log(to.width / from.width)) * span;
  return MOVE_S.min + (MOVE_S.max - MOVE_S.min) * Math.min(1, distance / span);
}

/** The view a fraction `p` of the way from `from` to `to`: the center in a line, the width in proportion. */
export function between(from, to, p) {
  if (p <= 0) return from;
  if (p >= 1) return to;
  return {
    cx: from.cx + (to.cx - from.cx) * p,
    cy: from.cy + (to.cy - from.cy) * p,
    width: Math.exp(Math.log(from.width) + (Math.log(to.width) - Math.log(from.width)) * p),
  };
}

/**
 * The camera at `t` along `shots` (`{ t, view }`, in order): each shot eases from wherever the camera is when it
 * starts, over `moveSeconds`, and holds until the next. Every view is clamped by `limits` (`clamp`).
 */
export function viewAt(shots, t, { limits, span }) {
  if (!shots.length) return null;
  let move = { from: clamp(shots[0].view, limits), to: clamp(shots[0].view, limits), start: shots[0].t, seconds: 0 };
  const at = (m, time) => (m.seconds ? between(m.from, m.to, ease((time - m.start) / m.seconds)) : m.to);
  for (const shot of shots.slice(1)) {
    if (shot.t > t) break;
    const from = at(move, shot.t);
    const to = clamp(shot.view, limits);
    move = { from, to, start: shot.t, seconds: moveSeconds(from, to, span) };
  }
  return at(move, t);
}

/** The view's rectangle in the world. */
export function viewRect(view) {
  const height = view.width / ASPECT;
  return { x: view.cx - view.width / 2, y: view.cy - height / 2, width: view.width, height };
}

/**
 * When the camera moves. A move to what is already on screen (`onScreen` of the windows it frames, or of a zoom's
 * region, inside the current view) is left out when it would come closer by less than `minRatio`, or when the current
 * view already shows those windows at `readable` output pixels a page's CSS pixel or more: the camera stays at the
 * wider framing. A move `mergeS` or less after the last kept one, in the same beat, joins it: one move, at the first's
 * time, to a view holding both, itself left out when it comes out barely different from the view before it.
 */
export const CALM = { minRatio: 1.35, onScreen: 0.85, readable: 1.0, mergeS: 2.5 };

/** The fraction of `inner`'s area inside `outer`. */
export function overlap(inner, outer) {
  const w = Math.max(0, Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x));
  const h = Math.max(0, Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y));
  return (w * h) / (inner.width * inner.height);
}

/**
 * The shots (`{ t, view, rect, ids, beat }`, in order: `rect` what the shot shows, `ids` its windows) the camera
 * keeps (`CALM`), each view clamped by `limits`; `readable(view, ids)` tells whether `view` shows the windows `ids`
 * readably.
 */
export function calmShots(shots, { limits, readable }) {
  const kept = [];
  // Whether moving from `from` to `shot` gains nothing: what it shows is on screen, and close enough or readable.
  const idle = (from, shot, view) =>
    overlap(shot.rect, viewRect(from)) >= CALM.onScreen &&
    (from.width / view.width < CALM.minRatio || readable(from, shot.ids));
  for (const shot of shots) {
    const view = clamp(shot.view, limits);
    const current = kept.at(-1)?.view;
    if (current && idle(current, shot, view)) continue;
    const last = kept.at(-1);
    if (kept.length > 1 && last.beat === shot.beat && shot.t - last.t <= CALM.mergeS) {
      const rect = union([last.rect, shot.rect]);
      const merged = { ...last, rect, view: clamp(fit(union([viewRect(last.view), viewRect(view)]), 0), limits) };
      merged.ids = [...new Set([...last.ids, ...shot.ids])];
      kept.pop();
      if (!idle(kept.at(-1).view, merged, merged.view)) kept.push(merged);
      continue;
    }
    kept.push({ ...shot, view });
  }
  return kept;
}
