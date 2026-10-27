/**
 * The answers this process is writing, one per conversation, each with the
 * controller that stops it: a second question to the same conversation is
 * refused while one is written, and **Stop** aborts the one being written.
 */

const running = new Map<number, AbortController>();

/** Mark the conversation as answering, with the controller its answer listens to; null when it already is. */
export function startAssistantAnswer(conversationId: number): AbortController | null {
  if (running.has(conversationId)) return null;
  const controller = new AbortController();
  running.set(conversationId, controller);
  return controller;
}

/** The conversation's answer has ended: it takes questions again. */
export function endAssistantAnswer(conversationId: number, controller: AbortController): void {
  if (running.get(conversationId) === controller) running.delete(conversationId);
}

/** Stop the answer the conversation is writing; false when it is writing none in this process. */
export function stopAssistantAnswer(conversationId: number): boolean {
  const controller = running.get(conversationId);
  if (!controller) return false;
  controller.abort();
  return true;
}
