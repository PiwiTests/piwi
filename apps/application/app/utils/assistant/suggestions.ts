/**
 * The "Ask about this page" suggestions: questions the panel and the command
 * palette offer on a page, by its `app/pages` pattern, each answerable from the
 * assistant's read tools and the docs. The live demo, which has no model,
 * offers its prepared questions instead (`shared/demo/assistant-questions.mjs`),
 * so a suggestion always gets a real answer there. Also the question the
 * input offers next, in its placeholder.
 */
import { assistantMessageText, type AssistantMessageView } from '#shared/assistant';
import { demoQuestionsFor } from '#shared/demo/assistant-questions.mjs';
import { historyKey } from './history';

/** Offered on every page, after the page's own. */
const ANY_PAGE = 'What does this page show?';

/** The questions of a page, by its pattern; a page missing here offers {@link ANY_PAGE} only. */
export const ASSISTANT_PAGE_SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  '/': ['What failed most this week?', 'Which projects need attention?'],
  '/projects': ['Which project fails most often?'],
  '/projects/[id]': ['Which tests in this project are flaky?', 'What are the open failures here?'],
  '/projects/[id]/test-cases': ['Which tests here are the slowest?'],
  '/projects/[id]/coverage': ['Which files do no tests cover?'],
  '/projects/[id]/locators': ['Which locators are likely to break?'],
  '/test-runs/[id]': ['Why did this run fail?', 'Which failures in this run are new?'],
  '/test-run-cases/[id]': ['Why did this test fail?', 'Is this failure flaky or a real regression?'],
  '/failure-clusters/[id]': ['What is the likely cause of this failure?', 'How do I fix it?'],
  '/test-cases/[id]': ['How stable is this test?', 'When did this test start failing?'],
  '/analytics': ['How has the pass rate moved this month?'],
  '/setup': ['What should I set up next?'],
  '/settings/ai': ['Which model answers my questions?'],
  '/mcp': ['How do I connect a coding agent?'],
};

/**
 * The suggestions of the page `page` (a pattern of `app/pages`, or null when no
 * page matched); in the demo, the prepared questions offered there.
 */
export function assistantSuggestionsFor(page: string | null | undefined, demo = false): readonly string[] {
  if (demo) return demoQuestionsFor(page).map((q) => q.question);
  return [...((page && ASSISTANT_PAGE_SUGGESTIONS[page]) || []), ANY_PAGE];
}

/**
 * The question the empty input offers next, in its placeholder: the `next`
 * block of the conversation's last answer, else the first of the page's
 * suggestions `suggestions` not asked in it yet. None after a failed answer,
 * which offers to try again, nor while the last answer waits for a pick in a
 * question or options block.
 */
export function nextAssistantQuestion(
  messages: readonly AssistantMessageView[],
  suggestions: readonly string[],
): string | null {
  const last = messages.at(-1);
  if (last?.role === 'assistant') {
    if (last.status === 'failed') return null;
    const waiting = last.blocks.some(
      (block) => (block.kind === 'question' && !block.answer) || (block.kind === 'options' && !block.picked),
    );
    if (waiting) return null;
    const next = last.blocks.find((block) => block.kind === 'next');
    if (next?.kind === 'next') return next.question;
  }
  const asked = new Set(
    messages
      .filter((message) => message.role === 'user')
      .map((message) => historyKey(assistantMessageText(message.blocks))),
  );
  return suggestions.find((suggestion) => !asked.has(historyKey(suggestion))) ?? null;
}
