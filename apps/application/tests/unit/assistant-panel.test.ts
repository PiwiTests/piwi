import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assistantFrame,
  assistantPageContextSchema,
  type AssistantBlock,
  type AssistantEvent,
  type AssistantMessageView,
} from '#shared/assistant';
import { GUIDE_ANCHORS } from '#shared/guide-anchors/index.mjs';
import {
  ASSISTANT_STREAM_CUT,
  assistantDraftMessage,
  emptyAssistantDraft,
  endAssistantDraft,
  readAssistantFrames,
  reduceAssistantEvent,
  type AssistantDraft,
} from '../../app/utils/assistant/events';
import { assistantGuideId, assistantGuideRun } from '../../app/utils/assistant/guide';
import { assistantPageContext, assistantPagePattern, renderedAnchors } from '../../app/utils/assistant/page-context';
import {
  answerableMessageId,
  assistantKnownEntities,
  listInWords,
  optionReply,
  questionReply,
} from '../../app/utils/assistant/replies';
import {
  ASSISTANT_PAGE_SUGGESTIONS,
  assistantSuggestionsFor,
  nextAssistantQuestion,
} from '../../app/utils/assistant/suggestions';
import {
  caretOnFirstLine,
  caretOnLastLine,
  rememberAssistantQuestion,
  stepAssistantHistory,
} from '../../app/utils/assistant/history';
import { assistantTime, assistantUsageView } from '../../app/utils/assistant/usage';
import type { AssistantStatus } from '#shared/assistant';
import { assistantOutcome, isAppRoute } from '../../app/utils/assistant/display';
import { inlineMarkdownHtml } from '../../app/utils/markdown-inline';

const appDir = join(__dirname, '../..');

function fold(events: AssistantEvent[]): AssistantDraft {
  return events.reduce((draft, event) => reduceAssistantEvent(draft, event), emptyAssistantDraft());
}

const DONE: AssistantEvent = {
  event: 'done',
  data: {
    messageId: 42,
    provider: 'openai',
    model: 'mock-chat',
    toolMode: 'native',
    inputTokens: 900,
    outputTokens: 30,
    costUsd: null,
  },
};

const ENTITY_BLOCK: AssistantBlock = {
  kind: 'entity',
  id: 'run-12',
  entity: { type: 'run', id: 12, label: 'Run #12' },
  status: 'failed',
};

describe('the event reducer', () => {
  test('appends streamed text to one text block', () => {
    const draft = fold([
      { event: 'text', data: { text: 'The run ' } },
      { event: 'text', data: { text: 'failed.' } },
    ]);
    expect(draft.blocks).toEqual([{ kind: 'text', text: 'The run failed.' }]);
    expect(draft.state).toBe('streaming');
  });

  test('records each tool call with its summary and the entities it named', () => {
    const entities = [{ type: 'run' as const, id: 12, label: 'Run #12' }];
    const draft = fold([
      { event: 'tool', data: { name: 'list_projects', summary: 'List projects' } },
      { event: 'tool', data: { name: 'get_run', summary: 'Read run 12', entities } },
    ]);
    expect(draft.toolCalls).toEqual([
      { name: 'list_projects', arguments: {}, summary: 'List projects' },
      { name: 'get_run', arguments: {}, summary: 'Read run 12', entities },
    ]);
  });

  test('keeps blocks in stream order, starting a new text block after another kind', () => {
    const draft = fold([
      { event: 'text', data: { text: 'First.' } },
      { event: 'block', data: { block: ENTITY_BLOCK } },
      { event: 'text', data: { text: 'Then.' } },
    ]);
    expect(draft.blocks).toEqual([{ kind: 'text', text: 'First.' }, ENTITY_BLOCK, { kind: 'text', text: 'Then.' }]);
  });

  test('done completes the answer with its id, model and tokens', () => {
    const draft = fold([{ event: 'text', data: { text: 'Hi.' } }, DONE]);
    expect(draft).toMatchObject({ state: 'completed', messageId: 42, error: null });
    expect(assistantDraftMessage(draft, '2026-10-22T10:00:00.000Z')).toMatchObject({
      id: 42,
      role: 'assistant',
      model: 'mock-chat',
      provider: 'openai',
      inputTokens: 900,
      outputTokens: 30,
      status: 'completed',
      blocks: [{ kind: 'text', text: 'Hi.' }],
    });
  });

  test('an error fails the answer', () => {
    const draft = fold([{ event: 'error', data: { code: 'limit', message: 'Daily cap reached', messageId: null } }]);
    expect(draft).toMatchObject({ state: 'failed', error: 'Daily cap reached', errorCode: 'limit', messageId: null });
    expect(assistantDraftMessage(draft, '').id).toBe(0);
  });

  test('an error after some text keeps the text as a failed answer', () => {
    const draft = fold([
      { event: 'text', data: { text: 'Half an answer' } },
      { event: 'error', data: { code: 'timeout', message: 'Timed out', messageId: 7 } },
    ]);
    expect(draft.blocks).toEqual([{ kind: 'text', text: 'Half an answer' }]);
    expect(assistantDraftMessage(draft, '')).toMatchObject({ id: 7, status: 'failed', error: 'Timed out' });
  });

  test('ignores events after the end', () => {
    const draft = fold([DONE, { event: 'text', data: { text: 'late' } }]);
    expect(draft.blocks).toEqual([]);
  });

  test('a stream that ends without done or error fails', () => {
    const ended = endAssistantDraft(fold([{ event: 'text', data: { text: 'Cut' } }]));
    expect(ended).toMatchObject({ state: 'failed', error: ASSISTANT_STREAM_CUT });
    expect(endAssistantDraft(fold([DONE])).state).toBe('completed');
  });
});

describe('readAssistantFrames', () => {
  test('parses complete frames and keeps the one still arriving', () => {
    const body = [
      assistantFrame({ event: 'tool', data: { name: 'list_projects', summary: 'List projects' } }),
      assistantFrame({ event: 'text', data: { text: 'Hello' } }),
    ].join('');
    const { events, rest } = readAssistantFrames(`${body}event: done\ndata: {"messageId"`);
    expect(events.map((e) => e.event)).toEqual(['tool', 'text']);
    expect(rest).toBe('event: done\ndata: {"messageId"');
  });

  test('reads CRLF frames and skips unknown events, comments and bad JSON', () => {
    const { events } = readAssistantFrames(
      ': keep-alive\r\n\r\nevent: ping\r\ndata: {}\r\n\r\nevent: text\r\ndata: {bad\r\n\r\nevent: text\r\ndata: {"text":"ok"}\r\n\r\n',
    );
    expect(events).toEqual([{ event: 'text', data: { text: 'ok' } }]);
  });
});

describe('the page context', () => {
  test.each([
    ['/', '/'],
    ['/projects/:id()', '/projects/[id]'],
    ['/projects/:id()/coverage', '/projects/[id]/coverage'],
    ['/projects/:id', '/projects/[id]'],
    ['/settings/ai', '/settings/ai'],
    ['/docs/:slug(.*)*', '/docs/[...slug]'],
    ['/reports/:id()?', '/reports/[[id]]'],
    ['/analytics/', '/analytics'],
  ])('the record path %s is the page %s', (recordPath, page) => {
    expect(assistantPagePattern(recordPath)).toBe(page);
  });

  test('sends the route, its page, params and query, and the project a project page shows', () => {
    expect(
      assistantPageContext({
        path: '/projects/3',
        fullPath: '/projects/3?tab=flaky-tests',
        recordPath: '/projects/:id()',
        params: { id: '3' },
        query: { tab: 'flaky-tests', branch: ['main', 'dev'], empty: null },
      }),
    ).toEqual({
      route: '/projects/3?tab=flaky-tests',
      page: '/projects/[id]',
      params: { id: '3' },
      query: { tab: 'flaky-tests', branch: 'main' },
      projectId: 3,
    });
  });

  test('names no project on a page that does not show one by its route', () => {
    const context = assistantPageContext({
      path: '/test-runs/12',
      fullPath: '/test-runs/12',
      recordPath: '/test-runs/:id()',
      params: { id: '12' },
      query: {},
    });
    expect(context).toEqual({ route: '/test-runs/12', page: '/test-runs/[id]', params: { id: '12' }, projectId: null });
  });

  test('keeps within the schema: no page when none matched, long values cut, at most 20 entries', () => {
    const query = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, 'v'.repeat(300)]));
    const context = assistantPageContext({
      path: '/nowhere',
      fullPath: `/nowhere?${'x'.repeat(600)}`,
      recordPath: undefined,
      params: { slug: ['a', 'b'] },
      query: { ...query, ['k'.repeat(61)]: 'too long a key' },
    });
    expect(context.route).toBe('/nowhere');
    expect(context.page).toBeNull();
    expect(context.projectId).toBeNull();
    expect(context.params).toEqual({ slug: 'a/b' });
    expect(Object.keys(context.query!)).toHaveLength(20);
    expect(Object.values(context.query!).every((v) => v.length === 200)).toBe(true);
  });

  test('a project page with a bad id names no project', () => {
    const context = assistantPageContext({
      path: '/projects/abc',
      fullPath: '/projects/abc',
      recordPath: '/projects/:id()/locators',
      params: { id: 'abc' },
      query: {},
    });
    expect(context.projectId).toBeNull();
  });

  test('takes at most 300 rendered anchors, each of at most 60 characters', () => {
    const page = { route: '/', page: '/' };
    const ids = (n: number, length = 12) => Array.from({ length: n }, (_, i) => `a${i}`.padEnd(length, 'x'));
    expect(assistantPageContextSchema.safeParse({ ...page, anchors: ids(300, 60) }).success).toBe(true);
    expect(assistantPageContextSchema.safeParse({ ...page, anchors: ids(301) }).success).toBe(false);
    expect(assistantPageContextSchema.safeParse({ ...page, anchors: ids(1, 61) }).success).toBe(false);
    expect(assistantPageContextSchema.safeParse(page).success).toBe(true);
  });

  test("lists the page's rendered anchors once each, in order, within the schema's bounds", () => {
    const element = (id: string | null, rendered = true) => ({
      getAttribute: () => id,
      checkVisibility: () => rendered,
    });
    const root = (elements: ReturnType<typeof element>[]) => ({ querySelectorAll: () => elements }) as never;
    expect(
      renderedAnchors(
        root([
          element('project-health'),
          element('failure-inbox-row'),
          element('project-health'),
          element('folded-away', false),
          element(''),
          element('x'.repeat(61)),
          element('nav-home'),
        ]),
      ),
    ).toEqual(['project-health', 'failure-inbox-row', 'nav-home']);
    const many = renderedAnchors(root(Array.from({ length: 320 }, (_, i) => element(`anchor-${i}`))));
    expect(many).toHaveLength(300);
    expect(assistantPageContextSchema.safeParse({ route: '/', anchors: many }).success).toBe(true);
  });
});

describe('links in an answer', () => {
  const entities = { known: new Set(['run:12', 'cluster:3']), baseURL: '/demo/' };

  test('a link to an entity a tool result named routes to its page', () => {
    expect(inlineMarkdownHtml('See [Run #12](piwi:run/12).', entities)).toBe(
      'See <a href="/demo/test-runs/12" data-route="/test-runs/12" class="underline decoration-dotted underline-offset-2 hover:decoration-solid">Run #12</a>.',
    );
  });

  test('a link to an entity no tool result named is its label, as plain text', () => {
    const html = inlineMarkdownHtml('See [Run #99](piwi:run/99) and [the test](piwi:test-case/5).', entities);
    expect(html).toBe('See Run #99 and the test.');
  });

  test('any other link follows the safe-URL rules', () => {
    expect(inlineMarkdownHtml('[docs](https://piwitests.dev/features/assistant)', entities)).toContain(
      '<a href="https://piwitests.dev/features/assistant" target="_blank" rel="noopener"',
    );
    const unsafe = inlineMarkdownHtml('[x](javascript:alert(1))', entities);
    expect(unsafe).not.toContain('<a ');
    const unknownScheme = inlineMarkdownHtml('[x](piwi:user/1)', entities);
    expect(unknownScheme).toBe('[x](piwi:user/1)');
  });

  test('the label is escaped like any text', () => {
    expect(inlineMarkdownHtml('[<img src=x onerror=alert(1)>](piwi:cluster/3)', entities)).toContain(
      '>&lt;img src=x onerror=alert(1)&gt;</a>',
    );
  });

  test('without entity options an entity link stays as written', () => {
    expect(inlineMarkdownHtml('[Run #12](piwi:run/12)')).toBe('[Run #12](piwi:run/12)');
  });
});

describe('replies', () => {
  const question: Extract<AssistantBlock, { kind: 'question' }> = {
    kind: 'question',
    id: 'ci-provider',
    prompt: 'Which CI runs your suite?',
    multiple: false,
    other: true,
    choices: [
      { id: 'github', label: 'GitHub Actions' },
      { id: 'gitlab', label: 'GitLab CI' },
    ],
  };

  test('lists words as a sentence does', () => {
    expect(listInWords([])).toBe('');
    expect(listInWords(['A'])).toBe('A');
    expect(listInWords(['A', 'B'])).toBe('A and B');
    expect(listInWords(['A', 'B', 'C'])).toBe('A, B and C');
  });

  test('a single choice says the pick and carries its id', () => {
    expect(questionReply(9, question, ['gitlab'])).toEqual({
      text: 'GitLab CI',
      reply: { messageId: 9, blockId: 'ci-provider', choiceIds: ['gitlab'] },
    });
  });

  test('a single choice keeps one pick; unknown ids are dropped', () => {
    expect(questionReply(9, question, ['nope', 'github', 'gitlab'])?.reply.choiceIds).toEqual(['github']);
  });

  test('several picks keep the block order, with the Other text last', () => {
    const multiple = { ...question, multiple: true };
    expect(questionReply(9, multiple, ['gitlab', 'github'], '  Buildkite ')).toEqual({
      text: 'GitHub Actions, GitLab CI and Buildkite',
      reply: { messageId: 9, blockId: 'ci-provider', choiceIds: ['github', 'gitlab'], other: 'Buildkite' },
    });
  });

  test('the Other text alone is an answer; nothing picked is none', () => {
    expect(questionReply(9, question, [], 'Jenkins')).toEqual({
      text: 'Jenkins',
      reply: { messageId: 9, blockId: 'ci-provider', choiceIds: [], other: 'Jenkins' },
    });
    expect(questionReply(9, question, [], '   ')).toBeNull();
    expect(questionReply(9, { ...question, other: false }, [], 'Jenkins')).toBeNull();
  });

  test('picking an option says its title', () => {
    const options: Extract<AssistantBlock, { kind: 'options' }> = {
      kind: 'options',
      id: 'fix',
      prompt: 'How to fix it?',
      options: [
        { id: 'wait', title: 'Wait for the response', summary: 'Wait for the cart call.' },
        { id: 'retry', title: 'Retry the click', summary: 'Retry twice.' },
      ],
    };
    expect(optionReply(4, options, 'retry')).toEqual({
      text: 'Retry the click',
      reply: { messageId: 4, blockId: 'fix', choiceIds: ['retry'] },
    });
    expect(optionReply(4, options, 'nope')).toBeNull();
  });
});

describe('the conversation', () => {
  function message(id: number, role: 'user' | 'assistant', toolCalls: AssistantMessageView['toolCalls'] = []) {
    return {
      id,
      role,
      blocks: [],
      context: null,
      toolCalls,
      provider: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      status: 'completed' as const,
      error: null,
      createdAt: '',
    };
  }

  test('knows the entities every tool result named', () => {
    const known = assistantKnownEntities([
      message(1, 'assistant', [
        { name: 'get_run', arguments: {}, summary: '', entities: [{ type: 'run', id: 12, label: 'Run #12' }] },
        { name: 'list_projects', arguments: {}, summary: '' },
      ]),
      {
        toolCalls: [
          { name: 'get_cluster', arguments: {}, summary: '', entities: [{ type: 'cluster', id: 3, label: 'c' }] },
        ],
      },
    ]);
    expect([...known]).toEqual(['run:12', 'cluster:3']);
  });

  test('only the last stored answer takes replies', () => {
    expect(answerableMessageId([message(1, 'user'), message(2, 'assistant')])).toBe(2);
    expect(answerableMessageId([message(1, 'user'), message(2, 'assistant'), message(3, 'user')])).toBeNull();
    expect(answerableMessageId([message(1, 'user'), message(0, 'assistant')])).toBeNull();
    expect(answerableMessageId([])).toBeNull();
  });
});

describe('composed guides', () => {
  test('play each stop on its registry anchor, with the anchor’s docs page', () => {
    const anchor = GUIDE_ANCHORS.find((a) => a.doc)!;
    const run = assistantGuideRun(
      {
        title: 'Where to look',
        stops: [
          { anchor: anchor.id, route: '/', title: 'This block', body: 'Shows **this**.' },
          { anchor: 'no-such-anchor', title: 'Gone', body: 'Shown centered.' },
        ],
      },
      assistantGuideId(5, 'guide-1'),
    );
    expect(run.id).toBe('assistant-5-guide-1');
    expect(run.lang).toBe('en');
    expect(run.stops).toEqual([
      { id: 'stop-1', anchor: anchor.id, route: '/', title: 'This block', body: 'Shows **this**.', doc: anchor.doc },
      { id: 'stop-2', anchor: undefined, route: undefined, title: 'Gone', body: 'Shown centered.', doc: undefined },
    ]);
    expect(run.words.next).toBe('Next');
    expect(assistantGuideId(5, 'steps', 'ci')).toBe('assistant-5-steps-ci');
  });
});

describe('display', () => {
  test('colors outcomes only', () => {
    expect(assistantOutcome('timedout')).toBe('failed');
    expect(assistantOutcome('passed')).toBe('passed');
    expect(assistantOutcome('open')).toBeNull();
    expect(assistantOutcome(undefined)).toBeNull();
  });

  test('opens app routes in place only', () => {
    expect(isAppRoute('/test-runs/12?tab=workers')).toBe(true);
    for (const route of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '/\\evil', '/a b']) {
      expect(isAppRoute(route), route).toBe(false);
    }
  });
});

describe('page suggestions', () => {
  test('key every page by a pattern of app/pages', () => {
    for (const pattern of Object.keys(ASSISTANT_PAGE_SUGGESTIONS)) {
      const base = join(appDir, 'app/pages', pattern === '/' ? 'index' : pattern);
      expect(existsSync(`${base}.vue`) || existsSync(join(base, 'index.vue')), `${pattern} is a page`).toBe(true);
    }
  });

  test('every page offers a few, the page’s own first', () => {
    expect(assistantSuggestionsFor('/test-runs/[id]')).toEqual([
      'Why did this run fail?',
      'Which failures in this run are new?',
      'What does this page show?',
    ]);
    expect(assistantSuggestionsFor(null)).toEqual(['What does this page show?']);
    for (const questions of Object.values(ASSISTANT_PAGE_SUGGESTIONS)) {
      expect(questions.length).toBeLessThanOrEqual(2);
      for (const q of questions) expect(q.endsWith('?'), q).toBe(true);
    }
  });
});

/** A message of a conversation with these blocks, completed unless it says otherwise. */
function said(
  role: 'user' | 'assistant',
  blocks: AssistantBlock[],
  status: AssistantMessageView['status'] = 'completed',
): AssistantMessageView {
  return {
    id: 1,
    role,
    blocks,
    context: null,
    toolCalls: [],
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    status,
    error: null,
    createdAt: '',
  };
}

describe('the next question', () => {
  const PAGE = ['Why did this run fail?', 'Which failures in this run are new?', 'What does this page show?'];
  const asked = (text: string) => said('user', [{ kind: 'text', text }]);
  const answered = (...blocks: AssistantBlock[]) => said('assistant', [{ kind: 'text', text: 'Because.' }, ...blocks]);

  test("is the last answer's suggestion", () => {
    const next: AssistantBlock = { kind: 'next', id: 'next', question: 'How do I fix it?' };
    expect(nextAssistantQuestion([asked('Why did this run fail?'), answered(next)], PAGE)).toBe('How do I fix it?');
  });

  test("else the first of the page's suggestions not asked yet, in any case or spacing", () => {
    expect(nextAssistantQuestion([], PAGE)).toBe('Why did this run fail?');
    expect(nextAssistantQuestion([asked('why did  this run FAIL?'), answered()], PAGE)).toBe(
      'Which failures in this run are new?',
    );
    expect(
      nextAssistantQuestion(
        PAGE.flatMap((q) => [asked(q), answered()]),
        PAGE,
      ),
    ).toBeNull();
  });

  test('is none after a failed answer, nor while the last answer waits for a pick', () => {
    const failed = said('assistant', [{ kind: 'text', text: 'Half' }], 'failed');
    expect(nextAssistantQuestion([asked('Why?'), failed], PAGE)).toBeNull();
    const question: AssistantBlock = {
      kind: 'question',
      id: 'which',
      prompt: 'Which test?',
      multiple: false,
      choices: [{ id: 'a', label: 'A' }],
      other: false,
    };
    expect(nextAssistantQuestion([asked('Why?'), answered(question)], PAGE)).toBeNull();
    expect(nextAssistantQuestion([asked('Why?'), answered({ ...question, answer: { choiceIds: ['a'] } })], PAGE)).toBe(
      'Why did this run fail?',
    );
  });
});

describe('the question history', () => {
  test('Up recalls from the first line and Down moves on from the last, with nothing selected', () => {
    expect(caretOnFirstLine('', 0, 0)).toBe(true);
    expect(caretOnFirstLine('one\ntwo', 2, 2)).toBe(true);
    expect(caretOnFirstLine('one\ntwo', 5, 5)).toBe(false);
    expect(caretOnFirstLine('one', 0, 3)).toBe(false);
    expect(caretOnLastLine('one\ntwo', 5, 5)).toBe(true);
    expect(caretOnLastLine('one\ntwo', 2, 2)).toBe(false);
  });

  test('steps toward the oldest question and back to what is being typed', () => {
    const questions = ['newest', 'older', 'oldest'];
    expect(stepAssistantHistory(questions, -1, 'older')).toBe(0);
    expect(stepAssistantHistory(questions, 1, 'older')).toBe(2);
    expect(stepAssistantHistory(questions, 2, 'older')).toBeNull();
    expect(stepAssistantHistory(questions, 0, 'newer')).toBe(-1);
    expect(stepAssistantHistory(questions, -1, 'newer')).toBeNull();
    expect(stepAssistantHistory([], -1, 'older')).toBeNull();
  });

  test('a question asked again moves first, once', () => {
    expect(rememberAssistantQuestion(['b', 'Why?', 'c'], ' why? ')).toEqual(['why?', 'b', 'c']);
    expect(rememberAssistantQuestion(['a'], '  ')).toEqual(['a']);
  });
});

describe('the usage limits', () => {
  const time = (iso: string) => `at ${iso.slice(11, 16)}`;
  const status = (extra: Partial<AssistantStatus>): AssistantStatus => ({
    available: true,
    reason: null,
    provider: 'claude-cli',
    model: 'sonnet',
    toolMode: 'native',
    ...extra,
  });

  test('none without a cap or a subscription report', () => {
    expect(assistantUsageView(status({}), time)).toEqual({ meters: [], peak: null, warning: null, blocked: null });
    expect(assistantUsageView(null, time).meters).toEqual([]);
  });

  test('the allowance: what it counted, when it frees up, a warning from 80% and the input stopped once spent', () => {
    const allowance = { scope: 'user' as const, limit: 1000, used: 300, freesAt: '2026-10-27T09:30:00.000Z' };
    const quiet = assistantUsageView(status({ allowance }), time);
    expect(quiet.meters).toEqual([
      {
        id: 'allowance',
        label: 'Your daily allowance',
        share: 0.3,
        detail: '300 of 1,000 tokens in the last 24 hours',
        resets: 'Frees up at 09:30, as earlier answers pass 24 hours',
      },
    ]);
    expect(quiet).toMatchObject({ peak: 0.3, warning: null, blocked: null });
    expect(assistantUsageView(status({ allowance: { ...allowance, used: 850 } }), time).warning).toBe(
      '85% of your daily assistant allowance is spent. It frees up at 09:30.',
    );
    const spent = assistantUsageView(status({ allowance: { ...allowance, scope: 'instance', used: 1200 } }), time);
    expect(spent).toMatchObject({ peak: 1, warning: null });
    expect(spent.blocked).toBe('This instance reached its daily assistant allowance. It frees up at 09:30.');
  });

  test("the Claude subscription's window, warned when nearly or wholly spent, never stopping the input", () => {
    const subscription = {
      status: 'allowed' as const,
      window: 'five_hour',
      utilization: 0.4,
      resetsAt: '2026-10-26T15:00:00.000Z',
      reportedAt: '2026-10-26T11:00:00.000Z',
    };
    const quiet = assistantUsageView(status({ subscription }), time);
    expect(quiet.meters).toEqual([
      {
        id: 'subscription',
        label: 'Claude subscription · 5-hour window',
        share: 0.4,
        detail: '40% used',
        resets: 'Resets at 15:00',
      },
    ]);
    expect(quiet.warning).toBeNull();
    const nearly = assistantUsageView(
      status({ subscription: { ...subscription, status: 'allowed_warning', utilization: null } }),
      time,
    );
    expect(nearly).toMatchObject({ peak: null, blocked: null });
    expect(nearly.warning).toBe('Your Claude subscription’s 5-hour window is nearly spent. It resets at 15:00.');
    const rejected = assistantUsageView(status({ subscription: { ...subscription, status: 'rejected' } }), time);
    expect(rejected).toMatchObject({ peak: 1, blocked: null });
    expect(rejected.warning).toBe(
      'Your Claude subscription reached the limit of its 5-hour window. It resets at 15:00.',
    );
  });

  test('a time within a day reads as its hour, a later one with its day', () => {
    const now = Date.parse('2026-10-26T10:00:00Z');
    expect(assistantTime('2026-10-26T15:00:00Z', now)).toMatch(/^at /);
    expect(assistantTime('2026-10-28T15:00:00Z', now)).toMatch(/^on /);
  });
});
