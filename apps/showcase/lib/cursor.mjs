// The cut's pointer and keys, without I/O: a pointer that travels to each gesture's point along a gentle arc and
// arrives before it acts, a ring where it clicks, and a strip naming the keys a gesture presses.
import { ease } from './camera.mjs';

/** The pointer's longest travel, how long it stays after its last move, its fade, and a click ring's life (s). */
export const POINTER = { travel: 0.65, idle: 2.5, fade: 0.25, ring: 0.55 };

/** How long a key strip shows, and its fade (s). */
export const KEYS = { show: 1.6, fade: 0.2 };

/** Where the pointer comes from for its first move: below and right of its point, in world pixels. */
const ENTRY = { x: 180, y: 240 };

/**
 * The point a fraction `p` along the arc from `from` to `to`: a quadratic curve whose control point stands off the
 * straight line by `bend` of its length, always to the same side.
 */
export function arcPoint(from, to, p, bend = 0.12) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const control = { x: (from.x + to.x) / 2 - dy * bend, y: (from.y + to.y) / 2 + dx * bend };
  const q = 1 - p;
  return {
    x: q * q * from.x + 2 * q * p * control.x + p * p * to.x,
    y: q * q * from.y + 2 * q * p * control.y + p * p * to.y,
  };
}

/**
 * The pointer at `t` along `moves` (`{ t, act, to }`, in order, the cut's seconds and world pixels): it leaves at a
 * move's `t` from where the last one left it, arrives `POINTER.travel` later at most and before `act`, and stays.
 * It fades in as it starts to move and out `POINTER.idle` after its last act. `pressed` is true for a moment at a
 * click's `act`. Null before the first move.
 */
export function pointerAt(moves, t) {
  if (!moves.length || t < moves[0].t - POINTER.fade) return null;
  let index = 0;
  while (index + 1 < moves.length && moves[index + 1].t <= t) index++;
  const move = moves[index];
  const from = index > 0 ? moves[index - 1].to : { x: move.to.x + ENTRY.x, y: move.to.y + ENTRY.y };
  const travel = Math.min(POINTER.travel, Math.max(0.15, move.act - move.t - 0.1));
  const { x, y } = t < move.t ? from : arcPoint(from, move.to, ease((t - move.t) / travel));
  // Hidden since the last move's idle ran out, the pointer fades in again just before it moves.
  const lastAct = index > 0 ? moves[index - 1].act : Number.NEGATIVE_INFINITY;
  const wasHidden = lastAct + POINTER.idle + POINTER.fade < move.t - POINTER.fade;
  const fadeIn = wasHidden ? (t - (move.t - POINTER.fade)) / POINTER.fade : 1;
  const fadeOut = 1 - (t - move.act - POINTER.idle) / POINTER.fade;
  const next = moves[index + 1];
  const comingBack = next ? (t - (next.t - POINTER.fade)) / POINTER.fade : 0;
  const opacity = Math.min(1, Math.max(0, Math.min(fadeIn, fadeOut), comingBack));
  if (opacity <= 0) return null;
  return { x, y, opacity, pressed: Boolean(move.click) && t >= move.act && t < move.act + 0.12 };
}

/** The click rings showing at `t`: each grows and fades for `POINTER.ring` after its click's `act`. */
export function ringsAt(moves, t) {
  return moves
    .filter((m) => m.click && t >= m.act && t < m.act + POINTER.ring)
    .map((m) => {
      const p = (t - m.act) / POINTER.ring;
      return { x: m.to.x, y: m.to.y, progress: p, opacity: 1 - p };
    });
}

/** A key as the strip names it: `Control+Shift+K` → `Ctrl`, `Shift`, `K`. */
export function keyCaps(key) {
  const names = { Control: 'Ctrl', Meta: 'Cmd', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓' };
  return key.split('+').map((part) => names[part] ?? part);
}

/** The key strip at `t` from `keys` (`{ at, caps, label }`, in order): the latest pressed, for `KEYS.show`. */
export function keysAt(keys, t) {
  let shown = null;
  for (const key of keys) if (key.at <= t) shown = key;
  if (!shown || t > shown.at + KEYS.show) return null;
  const opacity = Math.min(1, (t - shown.at) / KEYS.fade, (shown.at + KEYS.show - t) / KEYS.fade);
  return { caps: shown.caps, label: shown.label ?? null, opacity: Math.max(0, opacity) };
}
