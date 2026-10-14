/**
 * What the page was doing at test end beyond its DOM, as the capture fixtures read it: the element holding
 * keyboard focus, the element under the mouse, a text selection, the checkboxes in the indeterminate state. A
 * trace snapshot records none of these, so the dashboard applies them to the failure-time DOM it renders.
 *
 * An element is named by its **element path**: the tag and the position among same-tag siblings
 * (`:nth-of-type`) of each element from the root down, `/`-separated (`html:1/body:1/form:1/input:2`), with
 * `|` stepping into the open shadow root of the element before it (`html:1/body:1/x-card:1|button:1`). Only
 * same-tag siblings count, so the elements a trace snapshot drops (scripts, `noscript`, preload links) never
 * shift it. A text position is an element path and a character offset into that element's text, scripts and
 * styles left out, so it holds however the text was split into nodes. Positions only: a field's value and
 * the selected text are never read.
 */

/** One element of the page, by element path, with a short label for people (`input#email`, `button "Save"`). */
export interface ElementRef {
  path: string;
  label: string;
}

/** A position in the page's text: an element and a character offset into its text. */
export interface TextPoint {
  path: string;
  offset: number;
}

export interface PageInteraction {
  /** The focused element; `visible` when the browser drew its focus ring (`:focus-visible`). */
  focus?: {
    element: ElementRef;
    visible: boolean;
    /** The caret or selected range in a text field, as `[start, end]`. */
    selection?: [number, number];
  };
  /** The innermost element under the mouse (`:hover`). */
  hover?: ElementRef;
  /** A text selection in the page outside a field, and its length in characters. */
  selection?: { start: TextPoint; end: TextPoint; length: number };
  /** Checkboxes in the indeterminate state, which only a script can set. */
  indeterminate?: ElementRef[];
}

export const ELEMENT_PATH_MAX_CHARS = 2000;
const ELEMENT_LABEL_MAX_CHARS = 120;
const MAX_INDETERMINATE = 20;

const STEP = String.raw`[a-zA-Z][\w.-]*:[1-9]\d*`;
const LEVEL = `${STEP}(?:/${STEP})*`;
const ELEMENT_PATH_RE = new RegExp(`^${LEVEL}(?:\\|${LEVEL})*$`);

/** Whether `path` is a well-formed element path. */
export function isElementPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= ELEMENT_PATH_MAX_CHARS && ELEMENT_PATH_RE.test(path);
}

const offsetOf = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : null;

function elementRef(v: unknown): ElementRef | null {
  if (!v || typeof v !== 'object') return null;
  const { path, label } = v as Record<string, unknown>;
  if (!isElementPath(path)) return null;
  return { path, label: typeof label === 'string' ? label.slice(0, ELEMENT_LABEL_MAX_CHARS) : '' };
}

function textPoint(v: unknown): TextPoint | null {
  if (!v || typeof v !== 'object') return null;
  const { path, offset } = v as Record<string, unknown>;
  const at = offsetOf(offset);
  return isElementPath(path) && at !== null ? { path, offset: at } : null;
}

/**
 * The well-formed part of an untrusted page-interaction record: malformed parts are dropped, labels and the
 * indeterminate list are capped. Used by the reporter on what the page returned and by the server on what a
 * submitter sent.
 */
export function sanitizePageInteraction(raw: unknown): PageInteraction {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: PageInteraction = {};

  const focus = r.focus as Record<string, unknown> | undefined;
  const focused = focus && typeof focus === 'object' ? elementRef(focus.element) : null;
  if (focus && focused) {
    out.focus = { element: focused, visible: focus.visible === true };
    const range = Array.isArray(focus.selection) && focus.selection.length === 2 ? focus.selection : [];
    const [start, end] = range.map(offsetOf);
    if (start != null && end != null && start <= end) out.focus.selection = [start, end];
  }

  const hover = elementRef(r.hover);
  if (hover) out.hover = hover;

  const selection = r.selection as Record<string, unknown> | undefined;
  if (selection && typeof selection === 'object') {
    const start = textPoint(selection.start);
    const end = textPoint(selection.end);
    const length = offsetOf(selection.length);
    if (start && end && length !== null && length > 0) out.selection = { start, end, length };
  }

  if (Array.isArray(r.indeterminate)) {
    const boxes = r.indeterminate
      .map(elementRef)
      .filter((ref): ref is ElementRef => ref !== null)
      .slice(0, MAX_INDETERMINATE);
    if (boxes.length) out.indeterminate = boxes;
  }
  return out;
}
