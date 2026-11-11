import { FAILURE_SCREENSHOT_ATTACHMENT } from '@piwitests/core/wire';

/** One image of a `ScreenshotLightbox`, with what its details panel says about it. */
export interface LightboxImage {
  src: string;
  /** What the image shows — its caption. */
  name: string;
  /** The image shows the page at the failure: a failed dot before its caption. */
  failed?: boolean;
  /** The step the page was captured at, as its title (`click getByRole('button')`). */
  step?: string | null;
  /** The error raised on this page, shown in full. */
  error?: string | null;
  /** Short facts about the image (`1280×720`, `4.20% of pixels changed`). */
  facts?: string[];
  /** The name the test attached the image under, in full; see `attachmentOwnName`. */
  attachmentName?: string | null;
}

/** The test every image of a lightbox belongs to, named once in its details panel. */
export interface LightboxSubject {
  title?: string | null;
  /** The test's `file:line[:col]`, opened in the IDE from the panel. */
  location?: string | null;
  projectKey?: string | number | null;
  projectName?: string | null;
}

/**
 * The name a test gave an attached image, or null when it says nothing of its
 * own: no name, the capture fixtures' failure screenshot, Playwright's
 * `screenshot`, or the file's own name.
 */
export function attachmentOwnName(name: string | null | undefined, path: string): string | null {
  const own = name?.trim();
  if (!own || own === FAILURE_SCREENSHOT_ATTACHMENT || own === 'screenshot') return null;
  if (own === path.split('/').pop()) return null;
  return own;
}

/** The ` | Expected:` that separates a step from its expected result in a screenshot's name. */
const EXPECTED_SEPARATOR = /\s*\|\s*Expected:\s*/;

/**
 * Splits a screenshot's name at its first ` | Expected:` into the step and the
 * expected result. `expected` is null when the name has none, or an empty one.
 */
export function splitExpected(name: string): { step: string; expected: string | null } {
  const match = EXPECTED_SEPARATOR.exec(name);
  const step = match ? name.slice(0, match.index).trim() : '';
  if (!match || !step) return { step: name.trim(), expected: null };
  const expected = name.slice(match.index + match[0].length).trim();
  return { step, expected: expected || null };
}
