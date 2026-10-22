import { describeStepInParts } from '@piwitests/core/bug-report';
import type { RecordedStep } from '@piwitests/core/recording';
import { interfacePhrases } from './core-words.js';
import type { RecordingState } from './recording-storage.js';

/** The longest title a recording keeps: a test's name, not a paragraph. */
export const RECORDING_TITLE_MAX = 120;

/** A title as kept: on one line, trimmed, at most {@link RECORDING_TITLE_MAX} characters; null when nothing is left. */
export function cleanTitle(text: string | null | undefined): string | null {
  const line = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, RECORDING_TITLE_MAX).trim();
  return line || null;
}

/**
 * The title a recording goes by when it has none of its own: its first action
 * in words, in the interface language (`Click button "Log in"`), or the path of
 * the page it starts on; null for a recording with no step.
 */
export function titleFromSteps(steps: readonly RecordedStep[]): string | null {
  const action = steps.find((step) => step.action !== 'goto');
  if (action) {
    return cleanTitle(
      describeStepInParts(action, interfacePhrases())
        .map((part) => part.text)
        .join(''),
    );
  }
  const start = steps[0];
  if (!start) return null;
  try {
    return cleanTitle(new URL(start.value ?? start.pageUrl).pathname);
  } catch {
    return cleanTitle(start.value ?? start.pageUrl);
  }
}

/**
 * The title of a recording's spec and steps file: the one it was given (the
 * review panel's field, filled from the first page's own title as the
 * recording starts), else one made from its steps.
 */
export function recordingTitle(state: Pick<RecordingState, 'title'>, steps: readonly RecordedStep[]): string | null {
  return cleanTitle(state.title) ?? titleFromSteps(steps);
}
