/**
 * The input's question history, as a shell's: Up on the first line brings
 * back the previous question, Down on the last line the next one, and Down
 * past the newest gives back what was being typed. The questions are the
 * user's own, newest first (`GET /api/assistant/questions`), with the ones
 * asked since they were read put first.
 */

/** Where the input stands in the history: -1 on what is being typed, else the index of the question shown. */
export type AssistantHistoryIndex = number;

/** Whether the caret, with nothing selected, is on the first line of `value`: Up then recalls. */
export function caretOnFirstLine(value: string, selectionStart: number, selectionEnd: number): boolean {
  return selectionStart === selectionEnd && !value.slice(0, selectionStart).includes('\n');
}

/** Whether the caret, with nothing selected, is on the last line of `value`: Down then moves on. */
export function caretOnLastLine(value: string, selectionStart: number, selectionEnd: number): boolean {
  return selectionStart === selectionEnd && !value.slice(selectionEnd).includes('\n');
}

/**
 * The index one step `direction` from `index` in `questions` (newest first):
 * `older` moves toward the oldest and stops there, `newer` moves back to -1,
 * what is being typed. Null when there is nowhere to go.
 */
export function stepAssistantHistory(
  questions: readonly string[],
  index: AssistantHistoryIndex,
  direction: 'older' | 'newer',
): AssistantHistoryIndex | null {
  if (direction === 'older') return index + 1 < questions.length ? index + 1 : null;
  return index >= 0 ? index - 1 : null;
}

/** `questions` with `question` put first, once: the history after it was asked. */
export function rememberAssistantQuestion(questions: readonly string[], question: string): string[] {
  const text = question.trim();
  if (!text) return [...questions];
  const key = historyKey(text);
  return [text, ...questions.filter((q) => historyKey(q) !== key)];
}

/** Two questions are the same one when they differ only in case and spacing. */
export function historyKey(question: string): string {
  return question.replace(/\s+/g, ' ').trim().toLowerCase();
}
