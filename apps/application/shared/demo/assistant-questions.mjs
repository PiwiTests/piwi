/**
 * The questions the live demo's assistant answers. The demo has no AI model,
 * so its assistant answers a set of prepared questions about the sample data,
 * each answer computed from the in-browser database through the handlers the
 * server reads (`app/demo/api/assistant-answers.ts`), in the blocks a real
 * answer uses. A question typed in other words reaches the same answer when
 * its words and its page match it (`app/demo/api/assistant-match.ts`).
 *
 * Each entry names the answer that computes it; the pages of `app/pages` it
 * is offered on, as the panel's "Ask about this page" suggestions, `*` for
 * every page; and a seeded route where the checks ask it:
 * `tests/unit/demo-assistant-answers.test.ts` computes every answer there on
 * the generated seed, and `scripts/check-demo-runtime.mjs` asks one question
 * of each answer from the panel in the built demo.
 *
 * Plain ESM so that Node script reads the same file.
 */

/** @type {readonly import('./assistant-questions.d.mts').DemoAssistantQuestion[]} */
export const DEMO_ASSISTANT_QUESTIONS = [
  {
    id: 'why-did-this-test-fail',
    answer: 'failure',
    question: 'Why did this test fail?',
    pages: ['/test-run-cases/[id]'],
    sample: '/test-run-cases/37',
  },
  {
    id: 'cause-of-this-failure',
    answer: 'failure',
    question: 'What is the likely cause of this failure?',
    pages: ['/failure-clusters/[id]'],
    sample: '/failure-clusters/1',
  },
  {
    id: 'which-tests-are-flaky',
    answer: 'flaky',
    question: 'Which tests in this project are flaky?',
    pages: ['/projects/[id]'],
    sample: '/projects/1',
  },
  {
    id: 'what-changed-in-this-run',
    answer: 'run-changes',
    question: 'What changed since this run’s baseline?',
    pages: ['/test-runs/[id]'],
    sample: '/test-runs/2',
  },
  {
    id: 'run-in-ci',
    answer: 'ci',
    question: 'How do I run this suite in CI?',
    pages: ['/', '/projects', '/setup'],
    sample: '/',
  },
  {
    id: 'set-up-sharding',
    answer: 'ci',
    question: 'How do I set up sharding?',
    pages: ['/projects/[id]', '/setup'],
    sample: '/projects/5',
  },
  {
    id: 'show-network-requests',
    answer: 'guide',
    question: 'Show me the network requests this test made',
    pages: ['/test-run-cases/[id]'],
    sample: '/test-run-cases/37',
  },
  {
    id: 'where-to-diagnose',
    answer: 'guide',
    question: 'Where is the Diagnose with AI button?',
    pages: ['/failure-clusters/[id]'],
    sample: '/failure-clusters/2',
  },
  {
    id: 'where-are-flaky-tests',
    answer: 'guide',
    question: 'Show me where this project’s flaky tests are',
    pages: ['/projects/[id]'],
    sample: '/projects/1',
  },
  {
    id: 'what-is-piwi',
    answer: 'about',
    question: 'What is Piwi?',
    pages: ['*'],
    sample: '/',
  },
  {
    id: 'what-can-you-do',
    answer: 'about',
    question: 'What can you do here?',
    pages: ['*'],
    sample: '/projects',
  },
];

/** The most suggestions a page offers. */
const MAX_SUGGESTIONS = 4;

/**
 * The prepared questions offered on the page `page` (a pattern of
 * `app/pages`, or null when no page matched): the page's own first, then
 * those offered everywhere, at most four.
 *
 * @param {string | null | undefined} page
 * @returns {import('./assistant-questions.d.mts').DemoAssistantQuestion[]}
 */
export function demoQuestionsFor(page) {
  const own = page ? DEMO_ASSISTANT_QUESTIONS.filter((q) => q.pages.includes(page)) : [];
  const everywhere = DEMO_ASSISTANT_QUESTIONS.filter((q) => q.pages.includes('*'));
  return [...own, ...everywhere].slice(0, MAX_SUGGESTIONS);
}
