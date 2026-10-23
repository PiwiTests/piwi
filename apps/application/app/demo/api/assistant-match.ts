/**
 * Which prepared answer a question typed in the demo's assistant panel gets,
 * from its words and the page it was asked on. The rules run in order and the
 * first that matches wins; an answer about the page's own entity (a failure,
 * a run's changes) matches only on that entity's page. A question no rule
 * matches gets the demo's "prepared questions" answer.
 */
import type { DemoAssistantAnswer } from '#shared/demo/assistant-questions.mjs';

interface MatchRule {
  answer: DemoAssistantAnswer;
  /** The pages of `app/pages` it answers on; every page when omitted. */
  pages?: readonly string[];
  words: RegExp;
}

const RULES: readonly MatchRule[] = [
  {
    answer: 'about',
    words:
      /\b(what('s| is| does) piwi|what can (you|it|piwi) do|what do you (do|answer)|who are you|what are you|what can i ask)\b/,
  },
  {
    answer: 'ci',
    words:
      /\b(ci|pipelines?|github actions|gitlab|jenkins|azure|circleci|buildkite|continuous integration|shard(s|ing|ed)?)\b/,
  },
  {
    answer: 'guide',
    words: /^(where|show me|take me|point me|walk me|guide me)\b|\b(where (is|are|do|can|does)|show me)\b/,
  },
  { answer: 'flaky', words: /\b(flak(y|e|es|iness|iest)|unstable|quarantin\w*)\b/ },
  {
    answer: 'failure',
    pages: ['/test-run-cases/[id]', '/failure-clusters/[id]'],
    words: /\b(why|cause[sd]?|fail\w*|broke\w*|break\w*|wrong|errors?|fix\w*|happen\w*|explain)\b/,
  },
  {
    answer: 'run-changes',
    pages: ['/test-runs/[id]'],
    words: /\b(chang\w*|baseline|compar\w*|since|differ\w*|regress\w*|new|fail\w*|why)\b/,
  },
];

/** The prepared answer `text`, asked on the page `page` (a pattern of `app/pages`), gets; null when none fits. */
export function matchDemoQuestion(text: string, page: string | null | undefined): DemoAssistantAnswer | null {
  const words = text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const rule = RULES.find((r) => (!r.pages || (page != null && r.pages.includes(page))) && r.words.test(words));
  return rule?.answer ?? null;
}
