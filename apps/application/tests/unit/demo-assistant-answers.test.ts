/**
 * The demo assistant's prepared answers, computed on the generated seed as the
 * demo computes them in the browser: every prepared question matches its own
 * answer on its pages, and each answer, asked at its sample route, reads the
 * seed through the shared handlers, links only entities its reads named,
 * makes every block through the block checks with none refused, points its
 * guides at registry anchors on their pages, and offers the follow-up its
 * blocks promise (the quarantine cards after the flaky picks, applied
 * through the demo's own route; the CI checklist after the provider). A seed
 * change that breaks an answer fails here, naming the question.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assistantFrame,
  parseAssistantLink,
  type AssistantBlock,
  type AssistantMessageView,
  type AssistantPageContext,
} from '#shared/assistant';
import { assistantActionRequest } from '#shared/assistant-actions';
import { ADMIN_ACCESS, projectScopeFor, type AccessSummary } from '#shared/permissions';
import { DEMO_ASSISTANT_QUESTIONS, demoQuestionsFor } from '#shared/demo/assistant-questions.mjs';
import { findGuideAnchor } from '#shared/guide-anchors/index.mjs';
import { guideMarkupProblem, needsRoute } from '#shared/guide-anchor-search';
import { routeOnPage } from '#shared/guide-stops';
import { POSITIONING } from '#shared/piwi-ecosystem';
import { assistantPageContext } from '~/utils/assistant/page-context';
import { demoAccessFor } from '~~/app/demo/demo-users';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));

const { matchDemoQuestion } = await import('~~/app/demo/api/assistant-match');
const { answerDemoQuestion } = await import('~~/app/demo/api/assistant-answers');
const { handleDemoRequest } = await import('~~/app/demo/api/router');
type DemoAnswer = Awaited<ReturnType<typeof answerDemoQuestion>>;

const rootDir = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
let tmpDir: string;
let closeDb: () => void;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-demo-assistant-'));
  execFileSync('node', ['scripts/generate-demo-seed.mjs'], {
    cwd: rootDir,
    stdio: 'ignore',
    env: { ...process.env, PIWI_DEMO_SEED_OUTPUT_DIR: tmpDir },
  });
  const { createClient } = await import('@libsql/client');
  const { drizzle } = await import('drizzle-orm/libsql');
  const schema = await import('~~/server/database/schema.sqlite');
  const client = createClient({ url: `file:${join(tmpDir, 'demo.db')}` });
  await client.executeMultiple(readFileSync(join(tmpDir, 'seed.sql'), 'utf8'));
  state.db = drizzle(client, { schema });
  closeDb = () => client.close();
}, 120_000);

afterAll(() => {
  closeDb?.();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The pages the prepared questions are asked on, for the context a route builds. */
const PAGES = [
  '/',
  '/projects',
  '/setup',
  '/projects/[id]',
  '/test-runs/[id]',
  '/test-run-cases/[id]',
  '/failure-clusters/[id]',
  '/test-cases/[id]',
];

/** The context the panel sends for a question asked on `route`. */
function contextOn(route: string): AssistantPageContext {
  const [path = '/', query = ''] = route.split('?');
  const page = PAGES.find((p) => routeOnPage(path, p));
  if (!page) throw new Error(`no page for ${route}`);
  const id = /\/(\d+)(?:\/|$)/.exec(path)?.[1];
  return assistantPageContext({
    path,
    fullPath: route,
    recordPath: page.replace('[id]', ':id()'),
    params: id ? { id } : {},
    query: Object.fromEntries(new URLSearchParams(query)),
  });
}

interface Asker {
  access: AccessSummary;
  userId: number | null;
}

const ADMIN: Asker = { access: ADMIN_ACCESS, userId: null };

function env(asker: Asker = ADMIN) {
  return {
    db: state.db as never,
    access: asker.access,
    scope: projectScopeFor(asker.access, 'project:read'),
    get: async <T>(path: string, query?: Record<string, string | number>) =>
      (await handleDemoRequest(
        path,
        'GET',
        undefined,
        query ? new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : undefined,
        asker.userId,
      )) as T,
  };
}

/** The answer as the panel stores it, for a follow-up's earlier messages. */
function message(id: number, answer: DemoAnswer): AssistantMessageView {
  const blocks: AssistantBlock[] = [];
  for (const part of answer.parts) {
    if (part.kind === 'block') blocks.push(part.block);
    else if (part.kind === 'text') blocks.push({ kind: 'text', text: part.text });
  }
  return {
    id,
    role: 'assistant',
    blocks,
    context: null,
    toolCalls: answer.parts.flatMap((part) => (part.kind === 'tool' ? [part.call] : [])),
    provider: 'demo',
    model: 'demo',
    inputTokens: null,
    outputTokens: null,
    status: 'completed',
    error: null,
    createdAt: new Date().toISOString(),
  };
}

function ask(text: string, route: string, asker?: Asker) {
  return answerDemoQuestion({ text, context: contextOn(route), reply: null, earlier: [] }, env(asker));
}

/** The follow-up a pick on block `blockId` of `answer` gets. */
function pick(answer: DemoAnswer, blockId: string, choiceIds: string[], route: string, asker?: Asker) {
  const earlier = message(1, answer);
  const block = earlier.blocks.find((b) => 'id' in b && b.id === blockId);
  if (!block) throw new Error(`no block ${blockId}`);
  const picked = choiceIds.map((id) => {
    if (block.kind === 'options') return { id, label: block.options.find((o) => o.id === id)!.title };
    const choice = (block as Extract<AssistantBlock, { kind: 'question' }>).choices.find((c) => c.id === id)!;
    return { id, label: choice.label, ...(choice.entity ? { entity: choice.entity } : {}) };
  });
  return answerDemoQuestion(
    {
      text: picked.map((p) => p.label).join(', '),
      context: contextOn(route),
      reply: { blockId, picked, answer: earlier },
      earlier: [earlier],
    },
    env(asker),
  );
}

const blocksOf = (answer: DemoAnswer) => answer.parts.flatMap((p) => (p.kind === 'block' ? [p.block] : []));
const textOf = (answer: DemoAnswer) => answer.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n\n');
const toolsOf = (answer: DemoAnswer) => answer.parts.flatMap((p) => (p.kind === 'tool' ? [p.call.name] : []));
function only<K extends AssistantBlock['kind']>(answer: DemoAnswer, kind: K) {
  return blocksOf(answer).filter((b): b is Extract<AssistantBlock, { kind: K }> => b.kind === kind);
}

/**
 * What every answer holds to: no block refused, every link and card an entity
 * its reads (or the earlier answer's) named, every guide on registry anchors
 * on their pages, at most one block that ends it, last, and every event
 * serializable.
 */
function expectSound(answer: DemoAnswer, route: string, earlier: DemoAnswer[] = []) {
  expect(answer.refused).toEqual([]);
  const known = new Set(
    [...earlier, answer].flatMap((a) =>
      a.parts.flatMap((p) => (p.kind === 'tool' ? (p.call.entities ?? []).map((e) => `${e.type}:${e.id}`) : [])),
    ),
  );
  for (const [, href] of textOf(answer).matchAll(/\]\((piwi:[^)]+)\)/g)) {
    const entity = parseAssistantLink(href!);
    expect(entity, href).not.toBeNull();
    expect(known.has(`${entity!.type}:${entity!.id}`), `${href} was named by a read`).toBe(true);
  }
  const blocks = blocksOf(answer);
  const ending = blocks.filter((b) => b.kind === 'question' || b.kind === 'options');
  expect(ending.length).toBeLessThanOrEqual(1);
  if (ending.length) expect(blocks.at(-1)).toBe(ending[0]);
  const plans = blocks.flatMap((b) =>
    b.kind === 'guide'
      ? [b.guide]
      : b.kind === 'options'
        ? b.options.flatMap((o) => (o.guide ? [o.guide] : []))
        : b.kind === 'checklist'
          ? b.steps.flatMap((s) => (s.guide ? [s.guide] : []))
          : [],
  );
  for (const plan of plans) {
    expect(plan.title.length).toBeLessThanOrEqual(60);
    let current = route.split('?')[0]!;
    for (const stop of plan.stops) {
      const anchor = findGuideAnchor(stop.anchor);
      expect(anchor, stop.anchor).toBeDefined();
      expect(stop.title.length, stop.title).toBeLessThanOrEqual(60);
      expect(stop.body.length, stop.body).toBeLessThanOrEqual(360);
      expect(guideMarkupProblem(stop.title)).toBeNull();
      expect(guideMarkupProblem(stop.body)).toBeNull();
      if (stop.route) {
        expect(
          anchor!.pages.some((p) => routeOnPage(stop.route!.split('?')[0]!, p)),
          `${stop.route} opens a page of ${stop.anchor}`,
        ).toBe(true);
        current = stop.route.split('?')[0]!;
      } else {
        expect(needsRoute(anchor!, current), `${stop.anchor} needs a route from ${current}`).toBe(false);
      }
    }
  }
  for (const part of answer.parts) {
    if (part.kind === 'block')
      expect(() => assistantFrame({ event: 'block', data: { block: part.block } })).not.toThrow();
  }
}

describe('matching a question to a prepared answer', () => {
  test('every prepared question gets its own answer on each page it is offered on', () => {
    for (const q of DEMO_ASSISTANT_QUESTIONS) {
      const pages = q.pages.includes('*') ? PAGES : q.pages;
      for (const page of pages) expect(matchDemoQuestion(q.question, page), `${q.id} on ${page}`).toBe(q.answer);
    }
  });

  test('a question in other words reaches the same answer, on the page it needs', () => {
    expect(matchDemoQuestion('why is this broken', '/failure-clusters/[id]')).toBe('failure');
    expect(matchDemoQuestion('How do I fix it?', '/test-run-cases/[id]')).toBe('failure');
    expect(matchDemoQuestion('why did it fail', '/projects')).toBeNull();
    expect(matchDemoQuestion('which tests flake the most?', '/projects/[id]')).toBe('flaky');
    expect(matchDemoQuestion('What is new in this run compared to the last good one?', '/test-runs/[id]')).toBe(
      'run-changes',
    );
    expect(matchDemoQuestion('Can I run it on GitLab?', '/')).toBe('ci');
    expect(matchDemoQuestion('Where do I set the SCM token?', '/')).toBe('guide');
    expect(matchDemoQuestion('what’s Piwi', '/')).toBe('about');
    expect(matchDemoQuestion('What is the weather tomorrow?', '/')).toBeNull();
  });

  test('every page offers at most four questions, its own first', () => {
    expect(demoQuestionsFor('/test-run-cases/[id]').map((q) => q.id)).toEqual([
      'why-did-this-test-fail',
      'show-network-requests',
      'what-is-piwi',
      'what-can-you-do',
    ]);
    expect(demoQuestionsFor(null).map((q) => q.answer)).toEqual(['about', 'about']);
    for (const page of PAGES) expect(demoQuestionsFor(page).length).toBeLessThanOrEqual(4);
  });

  test('each sample route opens a page the question is offered on', () => {
    for (const q of DEMO_ASSISTANT_QUESTIONS) {
      const path = q.sample.split('?')[0]!;
      expect(q.pages.includes('*') || q.pages.some((p) => routeOnPage(path, p)), `${q.id} sample ${q.sample}`).toBe(
        true,
      );
    }
  });
});

describe('every prepared question, asked at its sample route', () => {
  for (const q of DEMO_ASSISTANT_QUESTIONS) {
    test(`${q.id}: ${q.question}`, async () => {
      const answer = await ask(q.question, q.sample);
      expect(answer.answer, `${q.id} got the answer it names`).toBe(q.answer);
      expectSound(answer, q.sample);
      expect(textOf(answer).length).toBeGreaterThan(80);
    });
  }
});

describe('why it failed', () => {
  test('on an execution: the situation, the clues, the next step, the cluster, the fix and the ways to fix it', async () => {
    const answer = await ask('Why did this test fail?', '/test-run-cases/37');
    expect(toolsOf(answer)).toEqual(expect.arrayContaining(['explain_failure', 'get_cluster']));
    const text = textOf(answer);
    expect(text).toContain('[should complete checkout with credit card](piwi:execution/37)');
    expect(text).toMatch(/\(piwi:cluster\/1\)/);
    expect(text).toContain('**Next:**');
    expect(text).toContain('The clues, strongest first');
    expect(only(answer, 'entity').map((b) => b.entity.id)).toEqual([1]);
    expect(only(answer, 'patch')).toHaveLength(1);
    expect(only(answer, 'patch')[0]!.validation?.status).toBe('applies');
    expect(toolsOf(answer)).toContain('get_fix_plan');
    expect(only(answer, 'command')[0]!.command.bash).toContain('npx playwright test');
    const options = only(answer, 'options')[0]!;
    expect(options.options.map((o) => o.id)).toEqual(expect.arrayContaining(['apply-patch', 'quarantine']));
    expect(options.options.find((o) => o.id === 'apply-patch')?.guide?.stops[0]?.anchor).toBe('diagnosis-fix');
  });

  test('on a cluster with a broken locator: the replacement line as code', async () => {
    const answer = await ask('What is the likely cause of this failure?', '/failure-clusters/2');
    expectSound(answer, '/failure-clusters/2');
    expect(toolsOf(answer)).toContain('get_locator_healing');
    expect(only(answer, 'code')).toHaveLength(1);
    expect(only(answer, 'options')[0]!.options.map((o) => o.id)).toEqual(
      expect.arrayContaining(['replace-locator', 'diagnose']),
    );
  });

  test('picking a way to fix proposes it as a card', async () => {
    const answer = await ask('What is the likely cause of this failure?', '/failure-clusters/2');
    const diagnose = await pick(answer, 'ways-to-fix', ['diagnose'], '/failure-clusters/2');
    expectSound(diagnose, '/failure-clusters/2', [answer]);
    expect(only(diagnose, 'proposal').map((b) => [b.action, b.target?.id, b.projectId])).toEqual([
      ['diagnose-cluster', 2, 1],
    ]);
    const resolve = await pick(answer, 'ways-to-fix', ['resolve'], '/failure-clusters/2');
    expect(only(resolve, 'proposal').map((b) => [b.action, b.target?.id, b.projectId])).toEqual([
      ['resolve-cluster', 2, 1],
    ]);
  });

  // Project 4 has no quarantined test, so a decline there is not outweighed by data.
  test('a project that declines quarantine gets no quarantine card, and is told why', async () => {
    const route = '/failure-clusters/7';
    const quarantinePick = async () =>
      pick(await ask('What is the likely cause of this failure?', route), 'ways-to-fix', ['quarantine'], route);
    expect(only(await quarantinePick(), 'proposal').map((b) => [b.action, b.projectId])).toEqual([
      ['quarantine-test', 4],
    ]);
    await handleDemoRequest('/api/projects/4/capabilities', 'PATCH', { decisions: { quarantine: 'declined' } });
    try {
      const refused = await quarantinePick();
      expect(only(refused, 'proposal')).toEqual([]);
      expect(textOf(refused)).toContain('the quarantine capability is declined for this project');
    } finally {
      await handleDemoRequest('/api/projects/4/capabilities', 'PATCH', { decisions: { quarantine: null } });
    }
  });
});

describe('which tests are flaky', () => {
  test('a persona without quarantine:write gets no card, and is told why', async () => {
    const viewer: Asker = { access: demoAccessFor(3), userId: 3 };
    const answer = await ask('Which tests in this project are flaky?', '/projects/1', viewer);
    const question = only(answer, 'question')[0]!;
    const cards = await pick(answer, 'flaky-tests-to-quarantine', [question.choices[0]!.id], '/projects/1', viewer);
    expect(only(cards, 'proposal')).toEqual([]);
    expect(textOf(cards)).toContain('quarantine:write');
  });

  test('a question with checkboxes over the flakiest tests, then one quarantine card per pick, applied by the demo', async () => {
    const answer = await ask('Which tests in this project are flaky?', '/projects/1');
    expect(toolsOf(answer)).toEqual(['list_flaky_tests']);
    const question = only(answer, 'question')[0]!;
    expect(question.multiple).toBe(true);
    expect(question.choices.length).toBeGreaterThanOrEqual(2);
    expect(question.choices.every((c) => c.entity?.type === 'test-case')).toBe(true);
    const picks = question.choices.filter((c) => c.checked).map((c) => c.id);
    expect(picks.length).toBeGreaterThan(0);

    const cards = await pick(answer, 'flaky-tests-to-quarantine', picks, '/projects/1');
    expectSound(cards, '/projects/1', [answer]);
    const proposals = only(cards, 'proposal');
    expect(proposals.map((p) => p.target?.id)).toEqual(
      question.choices.filter((c) => c.checked).map((c) => c.entity!.id),
    );
    for (const proposal of proposals) {
      expect(proposal.action).toBe('quarantine-test');
      expect(proposal.projectId).toBe(1);
      const request = assistantActionRequest(proposal);
      await handleDemoRequest(request.path, request.method, request.body, undefined, null);
    }
    const quarantine = (await handleDemoRequest('/api/projects/1/quarantine', 'GET')) as {
      entries: { testCaseId: number }[];
    };
    for (const proposal of proposals) {
      expect(quarantine.entries.map((e) => e.testCaseId)).toContain(proposal.target!.id);
    }
  });
});

describe('why a quarantined test failed', () => {
  test('still offers ways to fix, without quarantining it again', async () => {
    const answer = await ask('Why did this test fail?', '/test-run-cases/37');
    expectSound(answer, '/test-run-cases/37');
    const ways = only(answer, 'options')[0]!.options.map((o) => o.id);
    expect(ways).not.toContain('quarantine');
    expect(ways.length).toBeGreaterThanOrEqual(2);
  });
});

describe('what changed in a run', () => {
  test('against its baseline, linked, with the baseline as a card and the Changes tab', async () => {
    const answer = await ask('What changed since this run’s baseline?', '/test-runs/2');
    expect(toolsOf(answer)).toEqual(['get_run_insights']);
    expect(textOf(answer)).toMatch(/\[Run #2\]\(piwi:run\/2\) against its baseline, \[Run #\d+\]\(piwi:run\/\d+\)/);
    expect(only(answer, 'entity')[0]!.entity.type).toBe('run');
    expect(only(answer, 'navigate')[0]!.route).toBe('/test-runs/2?tab=changes');
  });
});

describe('running the suite in CI', () => {
  test('which CI, picked from the project’s runs, then the steps with commands in bash and PowerShell', async () => {
    const answer = await ask('How do I set up sharding?', '/projects/5');
    const question = only(answer, 'question')[0]!;
    expect(question.multiple).toBe(false);
    expect(question.choices.find((c) => c.checked)?.label).toBe('GitHub Actions');
    expect(textOf(answer)).toMatch(/ran as 2 shards/);

    const steps = await pick(answer, 'ci-provider', ['github-actions'], '/projects/5');
    expectSound(steps, '/projects/5', [answer]);
    const checklist = only(steps, 'checklist')[0]!;
    expect(checklist.steps.some((s) => s.command?.powershell?.includes('$env:PIWI_DASHBOARD_URL'))).toBe(true);
    expect(checklist.steps.find((s) => s.id === 'install')?.command?.bash).toContain('--project web-dashboard');
    expect(only(steps, 'code')[0]!.code).toContain('--shard=${{ matrix.shard }}/2');

    const gitlab = await pick(answer, 'ci-provider', ['gitlab-ci'], '/projects/5');
    expect(only(gitlab, 'code')[0]!.code).toContain('parallel: 2');
  });
});

describe('where something is', () => {
  test.each([
    ['Show me the network requests this test made', '/test-run-cases/37', 'evidence-network'],
    ['Where is the Diagnose with AI button?', '/failure-clusters/2', 'diagnose-with-ai'],
    ['Show me where this project’s flaky tests are', '/projects/1', 'flaky-tests-list'],
  ])('%s, on %s, points at %s', async (question, route, anchor) => {
    const answer = await ask(question, route);
    expect(only(answer, 'guide')[0]!.guide.stops[0]!.anchor).toBe(anchor);
  });

  // The seed's project 4 declines markers and the Test Map; project 1 decides neither.
  test.each([
    ['Where is the Gaps tab?', 'project-gaps-tab'],
    ['Where are the markers on the runs timeline?', 'project-markers'],
  ])('%s points at %s on a project, and not on one that declines its capability', async (question, anchor) => {
    const stopsOn = async (route: string) =>
      only(await ask(question, route), 'guide').flatMap((b) => b.guide.stops.map((stop) => stop.anchor));
    expect(await stopsOn('/projects/1')).toContain(anchor);
    expect(await stopsOn('/projects/4')).not.toContain(anchor);
  });

  test('a task an authored guide covers plays that guide', async () => {
    const answer = await ask('Where do I connect Jira?', '/');
    expectSound(answer, '/');
    expect(only(answer, 'guide')[0]!.guide.title).toBe('Connect Jira');
  });
});

describe('what Piwi is', () => {
  test('the positioning line, what the demo answers and links to try it', async () => {
    const answer = await ask('What is Piwi?', '/');
    expect(textOf(answer)).toContain(POSITIONING.tagline);
    expect(only(answer, 'navigate').length).toBeGreaterThanOrEqual(3);
  });
});

describe('a question no prepared answer matches', () => {
  test('says the demo answers prepared questions, offers those of the page and the authored guides', async () => {
    const answer = await ask('What is the weather tomorrow?', '/test-run-cases/37');
    expect(answer.answer).toBe('prepared-questions');
    expectSound(answer, '/test-run-cases/37');
    expect(textOf(answer)).toContain('prepared questions');
    expect(only(answer, 'guide').length).toBeGreaterThan(0);
    const question = only(answer, 'question')[0]!;
    expect(question.choices.map((c) => c.id)).toEqual(demoQuestionsFor('/test-run-cases/[id]').map((q) => q.id));

    const picked = await pick(answer, 'prepared-questions', ['why-did-this-test-fail'], '/test-run-cases/37');
    expect(picked.answer).toBe('failure');
    expectSound(picked, '/test-run-cases/37', [answer]);
  });
});

describe('the prepared answers and their follow-ups', () => {
  test('use every kind of block at least once', async () => {
    const failure = await ask('Why did this test fail?', '/test-run-cases/37');
    const locator = await ask('What is the likely cause of this failure?', '/failure-clusters/2');
    const diagnose = await pick(locator, 'ways-to-fix', ['diagnose'], '/failure-clusters/2');
    const flaky = await ask('Which tests flake here?', '/projects/3');
    const ci = await ask('How do I run this suite in CI?', '/');
    const steps = await pick(ci, 'ci-provider', ['github-actions'], '/');
    const run = await ask('What changed since this run’s baseline?', '/test-runs/2');
    const guide = await ask('Where is the Diagnose with AI button?', '/failure-clusters/2');
    const kinds = new Set(
      [failure, locator, diagnose, flaky, ci, steps, run, guide].flatMap((a) => [
        ...blocksOf(a).map((b) => b.kind),
        ...(textOf(a) ? ['text'] : []),
      ]),
    );
    expect([...kinds].sort()).toEqual(
      [
        'checklist',
        'code',
        'command',
        'entity',
        'guide',
        'navigate',
        'options',
        'patch',
        'proposal',
        'question',
        'text',
      ].sort(),
    );
  });
});
