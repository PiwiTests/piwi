/**
 * Pure helpers for the recorder — classifying a DOM element's input kind, and
 * telling a page the person reached on their own — split out of `record-panel.ts` (the entry point, which calls
 * `probeElementAttrs`/`generateAlternatives` and therefore can't be
 * reconstructed via `Function.prototype.toString()` per the two-strategy
 * rule in `extension/AGENTS.md`) so this half stays plain-unit-testable with
 * no DOM at all.
 */

export type InputKind = 'checkbox' | 'radio' | 'select' | 'text' | null;

/** Maps a tag/type pair to the `inputType` normalizeSteps (in `@piwitests/core/recording`) switches on — null for anything that isn't a checkbox/radio/select. */
export function classifyInputKind(tagName: string, typeAttr: string | null): InputKind {
  const tag = tagName.toLowerCase();
  if (tag === 'select') return 'select';
  if (tag !== 'input') return null;
  const type = (typeAttr ?? 'text').toLowerCase();
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  return 'text';
}

/** Whether a tag/type pair is a password field, one of the fields whose value is never captured (see `sensitive-fields.ts`). */
export function isPasswordInput(tagName: string, typeAttr: string | null): boolean {
  return tagName.toLowerCase() === 'input' && (typeAttr ?? '').toLowerCase() === 'password';
}

/** How soon after an action of the person a move through the history or a reload still follows from it. */
export const ACTION_LED_NAVIGATION_MS = 1_500;

/** The capture events that are the person's own actions, any of which can lead to another page. */
const ACTION_KINDS: ReadonlySet<string> = new Set(['click', 'dblclick', 'input', 'change', 'files', 'drop', 'keydown']);

/** Whether a capture event of `kind` is an action of the person. */
export function isActionKind(kind: string): boolean {
  return ACTION_KINDS.has(kind);
}

/**
 * When the person's last action among `events` (the recording's so far) was
 * recorded, if no page was reached since: one reached since is where that
 * action led, and a move through the history after it is the person's own.
 */
export function lastActionOf(events: readonly { kind: string; timestamp: number }[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const { kind, timestamp } = events[i]!;
    if (kind === 'navigate') return null;
    if (ACTION_KINDS.has(kind)) return timestamp;
  }
  return null;
}

/**
 * Whether a page the recorder attaches to is a step of its own: reached
 * through the history (`back_forward`, as the browser's navigation entry or
 * a page restored from the back/forward cache says) or by reloading, more
 * than {@link ACTION_LED_NAVIGATION_MS} after the person's last action
 * (`lastActionAt`, null when none was recorded since the last page was
 * reached). A page an action led to (a link's `history.back()`, a form that
 * reloads) is not.
 */
export function ownNavigation(
  type: string | null | undefined,
  at: number,
  lastActionAt: number | null,
): 'history' | 'reload' | null {
  const navigation = type === 'back_forward' ? 'history' : type === 'reload' ? 'reload' : null;
  if (!navigation) return null;
  return lastActionAt != null && at - lastActionAt < ACTION_LED_NAVIGATION_MS ? null : navigation;
}
