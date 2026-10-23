/**
 * Type declarations for the demo assistant's prepared questions.
 * See `assistant-questions.mjs` for the entries and the checks that hold them.
 */

/**
 * The answer a prepared question gets, each computed from the seed:
 * - `failure`: on an execution or a failure cluster, why it failed, its fix and the ways to fix it;
 * - `flaky`: on a project, its flakiest tests to pick, then a quarantine card for each pick;
 * - `run-changes`: on a run, what changed since its baseline;
 * - `ci`: which CI runs the suite, then the steps to report from it, sharded;
 * - `guide`: where something is, as a guide on the screens;
 * - `about`: what Piwi is and what the demo's assistant answers, with links to try it.
 */
export type DemoAssistantAnswer = 'failure' | 'flaky' | 'run-changes' | 'ci' | 'guide' | 'about';

export interface DemoAssistantQuestion {
  /** Kebab-case, unique. */
  id: string;
  answer: DemoAssistantAnswer;
  /** The question as the panel suggests it. */
  question: string;
  /** The patterns of `app/pages` it is suggested on; `*` for every page. */
  pages: readonly string[];
  /** A seeded route, on one of its pages, where the checks ask it. */
  sample: string;
}

export const DEMO_ASSISTANT_QUESTIONS: readonly DemoAssistantQuestion[];

export function demoQuestionsFor(page: string | null | undefined): DemoAssistantQuestion[];
