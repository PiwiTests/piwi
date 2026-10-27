/**
 * The assistant's panel. Against a mock OpenAI-compatible model, a question
 * asked in the panel streams its answer and the tool it called; a proposed
 * change is applied with a click through its own route, or dismissed, and the
 * stored card says which; and the tests picked in a question become one
 * proposal card each. With the ask route answered by a fixed event stream,
 * every kind of block renders, a question is answered with the reply the
 * contract describes, a checklist tick reaches its route and **Show me** plays
 * a guide on a registry anchor, and a link to another tab of the page the
 * question was asked on opens that tab. From 1280 px the panel docks beside
 * the page, folding the sidebar while it needs the room, or floats over it;
 * Up brings back earlier questions, Right takes the suggested next one, what
 * is typed stays, Ctrl+I opens and closes it, Stop ends an answer and Try
 * again asks its question again, and the usage limits warn and stop the
 * input. At phone width the panel fills the screen without scrolling sideways.
 */
import { test, expect } from './fixtures';
import type { APIRequestContext, Page, Request } from '@playwright/test';
import * as http from 'http';
import * as net from 'net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROJECT } from '#shared/test-project-names';
import {
  assistantFrame,
  type AssistantBlock,
  type AssistantConversation,
  type AssistantConversationSummary,
  type AssistantEvent,
  type AssistantStatus,
} from '#shared/assistant';
import { lockAiSettings } from './utils/ai-settings-lock';
import { waitForHydration } from './utils';

// Each test opens the dashboard cold and waits for streamed answers.
test.describe.configure({ timeout: 90_000 });

interface AnswerFixture {
  status: AssistantStatus;
  conversation: AssistantConversationSummary;
  question: string;
  answer: AssistantEvent[];
  replyAnswer: AssistantEvent[];
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/assistant-answer.json', import.meta.url)), 'utf8'),
) as AnswerFixture;

const MOCK_ANSWER = 'Two projects report here, and both ran today.';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

/** The questions the mock model answers with proposals, each naming the failure cluster it is about. */
const RESOLVE = 'Resolve failure cluster';
const IGNORE = 'Ignore failure cluster';
const PICK = 'Which tests should I quarantine in failure cluster';

type MockMessage = { role: string; content?: string | null; tool_call_id?: string };

/**
 * A model that calls `list_projects` on a question, then answers
 * {@link MOCK_ANSWER} in two pieces. Asked to resolve or ignore a failure
 * cluster, it reads the cluster, proposes the change and, once the card is
 * shown, answers. Asked which tests of a cluster to quarantine, it reads the
 * cluster and asks with its tests as checkboxes; given the picks, it proposes
 * one quarantine per test.
 */
function startMockModel(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { messages: MockMessage[] };
      const last = body.messages.at(-1);
      const question = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const write = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const callTools = (calls: Array<{ id: string; name: string; args: object }>, text = '') => {
        if (text) write({ model: 'mock-chat', choices: [{ delta: { content: text } }] });
        write({
          model: 'mock-chat',
          choices: [
            {
              delta: {
                tool_calls: calls.map((c, index) => ({
                  index,
                  id: c.id,
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              },
            },
          ],
        });
        write({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 700, completion_tokens: 12 },
        });
      };
      const answer = (text: string) => {
        write({ model: 'mock-chat', choices: [{ delta: { content: text } }] });
        write({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 900, completion_tokens: 20 },
        });
      };
      const clusterId = Number(/cluster (\d+)/.exec(question)?.[1] ?? 0);
      const reply = /<user_reply>\n(.+)\n<\/user_reply>/.exec(question);
      const readCluster = () => callTools([{ id: 'call_read', name: 'get_cluster', args: { clusterId } }]);

      if (reply) {
        if (last?.role === 'tool') answer('One card per test: apply the ones you want.');
        else {
          const picked = (JSON.parse(reply[1]!) as { picked: Array<{ entity?: { type: string; id: number } }> }).picked;
          callTools(
            picked.map((pick, n) => ({
              id: `call_propose_${n}`,
              name: 'propose_change',
              args: {
                id: `quarantine-${pick.entity!.id}`,
                action: 'quarantine-test',
                title: 'Quarantine this test',
                change: 'It keeps running and stops failing the CI gate until it is released.',
                target: pick.entity,
              },
            })),
          );
        }
      } else if (question.startsWith(RESOLVE) || question.startsWith(IGNORE)) {
        const resolve = question.startsWith(RESOLVE);
        if (last?.role !== 'tool') readCluster();
        else if (last.tool_call_id === 'call_read') {
          callTools(
            [
              {
                id: 'call_propose',
                name: 'propose_change',
                args: resolve
                  ? {
                      id: 'resolve',
                      action: 'resolve-cluster',
                      title: 'Resolve the checkout cluster',
                      change: 'The cluster leaves the failure inbox with the note.',
                      target: { type: 'cluster', id: clusterId },
                      params: { note: 'Fixed by waiting for the cart call' },
                    }
                  : {
                      id: 'ignore',
                      action: 'ignore-cluster',
                      title: 'Ignore the checkout cluster',
                      change: 'The fix verdicts never change its status again.',
                      target: { type: 'cluster', id: clusterId },
                    },
              },
            ],
            'Here is the change:',
          );
        } else answer('Apply it once the fix is in.');
      } else if (question.startsWith(PICK)) {
        if (last?.role !== 'tool') readCluster();
        else {
          const cluster = JSON.parse(last.content ?? '{}') as { affectedTestCases?: Array<{ testCaseId: number }> };
          callTools([
            {
              id: 'call_ask',
              name: 'ask',
              args: {
                id: 'pick',
                prompt: 'Which tests should I quarantine?',
                multiple: true,
                choices: (cluster.affectedTestCases ?? []).map((t) => ({
                  id: `t${t.testCaseId}`,
                  entity: { type: 'test-case', id: t.testCaseId },
                })),
              },
            },
          ]);
        }
      } else if (last?.role === 'tool') {
        write({ model: 'mock-chat', choices: [{ delta: { content: 'Two projects report here, ' } }] });
        write({ choices: [{ delta: { content: 'and both ran today.' } }] });
        write({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 900, completion_tokens: 20 },
        });
      } else {
        write({
          model: 'mock-chat',
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_projects', arguments: '{}' } }] },
            },
          ],
        });
        write({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 700, completion_tokens: 12 },
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

/** A Server-Sent Events body of `events`, as the ask route streams it. */
function eventStream(events: AssistantEvent[]): string {
  return events.map(assistantFrame).join('');
}

/** Opens the panel from the sidebar, through the sidebar's drawer below `lg`. */
async function openPanel(page: Page) {
  const launcher = page.getByRole('button', { name: 'Ask Piwi' });
  if (!(await launcher.isVisible())) await page.getByRole('button', { name: 'Open sidebar' }).first().click();
  await launcher.click();
  const panel = page
    .getByRole('dialog', { name: 'Ask Piwi' })
    .or(page.getByRole('complementary', { name: 'Ask Piwi' }));
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Answers every assistant route in the browser: the status (`options.status`,
 * else the fixture's), a conversation, the fixture's answers or `answer`, and
 * the question history (`options.questions`, else none).
 */
async function routeAssistant(
  page: Page,
  answer: AssistantEvent[] = fixture.answer,
  options: { status?: AssistantStatus; questions?: string[] } = {},
) {
  const asks: Request[] = [];
  const ticks: Request[] = [];
  /** Answers each tick with the block the server would return, in order, when the test says. */
  const tickAnswers: Array<(block: object) => void> = [];
  const outcomes: Request[] = [];
  await page.route('**/api/assistant/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname.endsWith('/assistant/status')) return route.fulfill({ json: options.status ?? fixture.status });
    if (pathname.endsWith('/assistant/questions')) return route.fulfill({ json: { items: options.questions ?? [] } });
    if (pathname.endsWith('/assistant/conversations')) {
      return request.method() === 'POST'
        ? route.fulfill({ status: 201, json: fixture.conversation })
        : route.fulfill({ json: { items: [] } });
    }
    if (pathname.endsWith('/messages')) {
      asks.push(request);
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: eventStream(asks.length === 1 ? answer : fixture.replyAnswer),
      });
    }
    if (pathname.endsWith('/checklist')) {
      ticks.push(request);
      const block = await new Promise<object>((resolve) => tickAnswers.push(resolve));
      return route.fulfill({ json: { block } });
    }
    if (pathname.endsWith('/proposal')) {
      outcomes.push(request);
      const { blockId, status } = request.postDataJSON() as { blockId: string; status: string };
      const block = fixture.answer
        .flatMap((e) => (e.event === 'block' ? [e.data.block] : []))
        .find((b) => 'id' in b && b.id === blockId);
      return route.fulfill({ json: { block: { ...block, outcome: { status, at: new Date().toISOString() } } } });
    }
    return route.fallback();
  });
  // The fixture's proposal resolves cluster 3: its own route answers as the server would.
  const applied: Request[] = [];
  await page.route('**/api/failure-clusters/3/status', (route) => {
    applied.push(route.request());
    return route.fulfill({ json: { id: 3, status: 'resolved' } });
  });
  return { asks, ticks, tickAnswers, outcomes, applied };
}

/** A failure cluster of two failing tests, reported to its own project. */
async function reportCluster(request: APIRequestContext): Promise<{ clusterId: number; projectId: number }> {
  const error = "TimeoutError: locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByTestId('pay')";
  const submitted = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.ASSISTANT_PROPOSALS,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 2000,
      totalTests: 2,
      passedTests: 0,
      failedTests: 2,
      skippedTests: 0,
      testCases: [
        { title: 'checkout pays by card', status: 'failed', duration: 900, location: 'tests/pay.spec.ts:3:1', error },
        {
          title: 'checkout pays by voucher',
          status: 'failed',
          duration: 900,
          location: 'tests/pay.spec.ts:9:1',
          error,
        },
      ],
    },
  });
  expect(submitted.ok()).toBeTruthy();
  const { runId, projectId } = (await submitted.json()) as { runId: number; projectId: number };
  const run = (await (await request.get(`/api/test-runs/${runId}`)).json()) as {
    testCases: Array<{ failureClusterId: number }>;
  };
  return { clusterId: run.testCases[0]!.failureClusterId, projectId };
}

/** The proposal blocks of the stored answers of the conversation titled `title`. */
async function storedProposals(request: APIRequestContext, title: string) {
  const list = (await (await request.get('/api/assistant/conversations')).json()) as {
    items: AssistantConversationSummary[];
  };
  const id = list.items.find((c) => c.title === title)!.id;
  const conversation = (await (
    await request.get(`/api/assistant/conversations/${id}`)
  ).json()) as AssistantConversation;
  return conversation.messages.flatMap((m) =>
    m.blocks.filter((b): b is Extract<AssistantBlock, { kind: 'proposal' }> => b.kind === 'proposal'),
  );
}

/** Asks `question` in a new conversation of the panel, and waits for the answer to be stored. */
async function askInPanel(page: Page, question: string) {
  const panel = await openPanel(page);
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await panel.getByLabel('Your question').fill(question);
  await panel.getByLabel('Your question').press('Enter');
  const answer = panel.locator('[data-assistant-message="assistant"]').last();
  await expect(answer.locator('[data-assistant-read]')).toBeVisible({ timeout: 30_000 });
  return { panel, answer };
}

test.describe.serial('Assistant panel with a model', () => {
  let releaseAiSettings = () => {};
  let mock: http.Server;
  let isEnvManaged = false;

  test.beforeAll(async ({ request }) => {
    test.setTimeout(10 * 60_000);
    // Other specs point Settings → AI at their own mock model and read the shared conversation list.
    releaseAiSettings = await lockAiSettings();
    const status = await request.get('/api/ai/status');
    isEnvManaged = status.ok() && ((await status.json()) as { source?: string }).source === 'env';
    const port = await getFreePort();
    mock = startMockModel(port);
    if (isEnvManaged) return;
    const res = await request.put('/api/settings/ai', {
      data: {
        roles: { diagnosis: { provider: 'openai', model: 'mock-chat', baseUrl: `http://127.0.0.1:${port}/v1` } },
        autoDiagnose: false,
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    const list = (await (await request.get('/api/assistant/conversations')).json()) as {
      items?: AssistantConversationSummary[];
    };
    const asked = ['Which projects report to this instance?', RESOLVE, IGNORE, PICK];
    for (const conversation of list.items ?? []) {
      if (asked.some((question) => conversation.title.startsWith(question))) {
        await request.delete(`/api/assistant/conversations/${conversation.id}`);
      }
    }
    if (!isEnvManaged) await request.put('/api/settings/ai', { data: { roles: null } });
    mock?.close();
    releaseAiSettings();
  });

  test('asks a question and shows the streamed answer and the tool it called', async ({ page }) => {
    test.skip(isEnvManaged, 'The AI configuration is managed by the environment');
    await page.goto('/');
    await waitForHydration(page);
    const panel = await openPanel(page);
    await expect(panel.getByText('mock-chat writes the answers.')).toBeVisible();

    await panel.getByLabel('Your question').fill('Which projects report to this instance?');
    await panel.getByLabel('Your question').press('Enter');

    await expect(panel.locator('[data-assistant-message="user"]')).toHaveText(
      'Which projects report to this instance?',
    );
    const answer = panel.locator('[data-assistant-message="assistant"]');
    await expect(answer.getByText(MOCK_ANSWER)).toBeVisible({ timeout: 30_000 });

    const read = answer.getByRole('button', { name: 'What it read · 1 tool' });
    await expect(read).toHaveAttribute('aria-expanded', 'false');
    await read.click();
    await expect(answer.locator('[data-assistant-read] li')).toHaveText(/List projects\s*· list_projects/);
    await expect(answer.locator('[data-assistant-read]')).toContainText('mock-chat');
  });

  test('a proposed change is applied with a click through its own route, and the card says so', async ({
    page,
    request,
  }) => {
    test.skip(isEnvManaged, 'The AI configuration is managed by the environment');
    const { clusterId } = await reportCluster(request);
    await page.goto(`/failure-clusters/${clusterId}`);
    await waitForHydration(page);
    const asked = page.waitForRequest((r) => r.url().endsWith('/messages') && r.method() === 'POST');
    const question = `${RESOLVE} ${clusterId}`;
    const { answer } = await askInPanel(page, question);
    // The question carries the guide anchors the page rendered.
    expect((await asked).postDataJSON().context.anchors).toEqual(expect.arrayContaining(['cluster-heading']));

    const card = answer.locator('[data-assistant-block="proposal"]');
    await expect(card).toContainText('Resolve a failure cluster');
    await expect(card).toContainText('Resolve the checkout cluster');
    await expect(card).toContainText('The cluster leaves the failure inbox with the note.');
    await expect(card.getByRole('link', { name: `Cluster #${clusterId}` })).toHaveAttribute(
      'href',
      new RegExp(`/failure-clusters/${clusterId}$`),
    );
    await expect(answer.getByText('Apply it once the fix is in.')).toBeVisible();

    const status = page.waitForRequest((r) => r.url().endsWith(`/api/failure-clusters/${clusterId}/status`));
    const outcome = page.waitForRequest((r) => r.url().endsWith('/proposal') && r.method() === 'PATCH');
    const refreshed = page.waitForRequest(
      (r) => new URL(r.url()).pathname === `/api/failure-clusters/${clusterId}` && r.method() === 'GET',
    );
    await card.getByRole('button', { name: 'Apply', exact: true }).click();
    expect((await status).method()).toBe('PATCH');
    expect((await status).postDataJSON()).toEqual({
      status: 'resolved',
      triageNote: 'Fixed by waiting for the cart call',
    });
    expect((await outcome).postDataJSON()).toEqual({ blockId: 'resolve', status: 'applied' });
    await refreshed;
    await expect(card.getByText('Applied')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);

    const cluster = (await (await request.get(`/api/failure-clusters/${clusterId}`)).json()) as { status: string };
    expect(cluster.status).toBe('resolved');
    expect(await storedProposals(request, question)).toEqual([
      expect.objectContaining({
        id: 'resolve',
        target: expect.objectContaining({ id: clusterId }),
        outcome: { status: 'applied', at: expect.any(String) },
      }),
    ]);
  });

  test('a dismissed proposal calls nothing and stays dismissed', async ({ page, request }) => {
    test.skip(isEnvManaged, 'The AI configuration is managed by the environment');
    const { clusterId } = await reportCluster(request);
    const before = (await (await request.get(`/api/failure-clusters/${clusterId}`)).json()) as { status: string };
    const statusCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/status') && r.method() === 'PATCH') statusCalls.push(r.url());
    });
    await page.goto('/');
    await waitForHydration(page);
    const question = `${IGNORE} ${clusterId}`;
    const { answer } = await askInPanel(page, question);
    const card = answer.locator('[data-assistant-block="proposal"]');
    await expect(card).toContainText('Ignore the checkout cluster');

    const outcome = page.waitForRequest((r) => r.url().endsWith('/proposal') && r.method() === 'PATCH');
    await card.getByRole('button', { name: 'Dismiss' }).click();
    expect((await outcome).postDataJSON()).toEqual({ blockId: 'ignore', status: 'dismissed' });
    await expect(card.getByText('Dismissed')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);

    expect(statusCalls).toEqual([]);
    const after = (await (await request.get(`/api/failure-clusters/${clusterId}`)).json()) as { status: string };
    expect(after.status).toBe(before.status);
    expect(await storedProposals(request, question)).toEqual([
      expect.objectContaining({ id: 'ignore', outcome: { status: 'dismissed', at: expect.any(String) } }),
    ]);
  });

  test('the tests picked in a question become one proposal card each', async ({ page, request }) => {
    test.skip(isEnvManaged, 'The AI configuration is managed by the environment');
    const { clusterId, projectId } = await reportCluster(request);
    await page.goto('/');
    await waitForHydration(page);
    const question = `${PICK} ${clusterId}?`;
    const { panel, answer } = await askInPanel(page, question);
    const pick = answer.locator('[data-assistant-block="question"]');
    await pick.getByRole('checkbox', { name: 'checkout pays by card' }).click();
    await pick.getByRole('checkbox', { name: 'checkout pays by voucher' }).click();
    await pick.getByRole('button', { name: 'Answer' }).click();

    const reply = panel.locator('[data-assistant-message="assistant"]').last();
    await expect(reply.getByText('One card per test: apply the ones you want.')).toBeVisible({ timeout: 30_000 });
    const cards = reply.locator('[data-assistant-block="proposal"]');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('Quarantine a test');
    await expect(cards.nth(0).getByRole('link', { name: 'checkout pays by card' })).toBeVisible();
    await expect(cards.nth(1).getByRole('link', { name: 'checkout pays by voucher' })).toBeVisible();

    const quarantined = page.waitForRequest((r) => r.url().endsWith(`/api/projects/${projectId}/quarantine`));
    await cards.nth(0).getByRole('button', { name: 'Apply', exact: true }).click();
    const body = (await quarantined).postDataJSON() as { testCaseId: number };
    await expect(cards.nth(0).getByText('Applied')).toBeVisible();
    await expect(cards.nth(1).getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();

    const stored = await storedProposals(request, question);
    expect(stored.map((p) => p.action)).toEqual(['quarantine-test', 'quarantine-test']);
    expect(stored[0]).toMatchObject({ target: { id: body.testCaseId }, projectId, outcome: { status: 'applied' } });
    expect(stored[1]).not.toHaveProperty('outcome');
    await request.delete(`/api/projects/${projectId}/quarantine/${body.testCaseId}`);
  });
});

test.describe('Assistant panel blocks', () => {
  let runId: number;

  test.beforeAll(async ({ request }) => {
    // Project health, the guide's anchor on Home, renders once the instance has a project.
    const submitted = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.ASSISTANT_PANEL,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'opens the cart', status: 'passed', duration: 900 }],
      },
    });
    expect(submitted.ok()).toBeTruthy();
    ({ runId } = (await submitted.json()) as { runId: number });
  });

  test('renders every block, answers a question, ticks a step and plays a guide', async ({ page }) => {
    test.setTimeout(120_000);
    const { asks, ticks, tickAnswers, outcomes, applied } = await routeAssistant(page);
    await page.goto('/');
    await waitForHydration(page);
    const panel = await openPanel(page);
    await panel.getByLabel('Your question').fill(fixture.question);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();

    // The question goes with the page it was asked on, and the guide anchors rendered on it.
    await expect.poll(() => asks.length).toBe(1);
    const home = {
      route: '/',
      page: '/',
      projectId: null,
      anchors: expect.arrayContaining(['project-health', 'nav-home']),
    };
    expect(asks[0]!.postDataJSON()).toEqual({ text: fixture.question, context: home });

    const answer = panel.locator('[data-assistant-message="assistant"]');
    await expect(answer.getByRole('button', { name: 'What it read · 3 tools' })).toBeVisible();

    // Text: a link to an entity a tool named, plain text for one none did, a numbered list.
    await expect(answer.getByRole('link', { name: 'Run #12' }).first()).toHaveAttribute('href', /\/test-runs\/12$/);
    await expect(answer.getByRole('link', { name: 'Run #99' })).toHaveCount(0);
    await expect(answer.getByText('The tool results name no Run #99')).toBeVisible();
    await expect(answer.getByText('1.', { exact: true })).toBeVisible();
    // Entity card, code, patch with its check, command in both shells.
    await expect(answer.locator('[data-assistant-entity]')).toContainText('Test run · Failed · 3 of 48 tests failed');
    await expect(answer.getByText('The check that fails')).toBeVisible();
    await expect(answer.getByText('Applies cleanly')).toBeVisible();
    await expect(answer.getByRole('tab', { name: 'Windows (PowerShell)' })).toBeVisible();
    // Options, checklist, guide, navigate, question.
    const options = answer.locator('[data-assistant-block="options"]');
    await expect(options.getByText('Recommended')).toBeVisible();
    await expect(options.getByRole('button', { name: 'Choose Wait for the cart response' })).toBeVisible();
    await expect(options.getByRole('button', { name: 'Show me' })).toBeVisible();
    const checklist = answer.locator('[data-assistant-block="checklist"]');
    await expect(checklist.getByText('0 of 3 done')).toBeVisible();
    await expect(answer.locator('[data-assistant-block="guide"]')).toContainText('2 stops');
    await expect(answer.getByRole('link', { name: 'Open the failure cluster' })).toHaveAttribute(
      'href',
      /\/failure-clusters\/3$/,
    );
    // A proposed change: Apply calls its own route, then the outcome is kept with the conversation.
    const proposal = answer.locator('[data-assistant-block="proposal"]');
    await expect(proposal).toContainText('Resolve a failure cluster');
    await expect(proposal.getByRole('link', { name: 'Cart total is stale after removing an item' })).toHaveAttribute(
      'href',
      /\/failure-clusters\/3$/,
    );
    await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(proposal.getByText('Applied')).toBeVisible();
    expect(applied.map((r) => [r.method(), r.postDataJSON()])).toEqual([
      ['PATCH', { status: 'resolved', triageNote: 'Fixed by waiting for the cart call' }],
    ]);
    expect(new URL(outcomes[0]!.url()).pathname).toBe('/api/assistant/conversations/501/messages/101/proposal');
    expect(outcomes[0]!.postDataJSON()).toEqual({ blockId: 'resolve', status: 'applied' });

    // A checklist tick is saved through its route; the next one shows at once and is sent once the first is saved.
    const verify = fixture.answer
      .flatMap((e) => (e.event === 'block' ? [e.data.block] : []))
      .find((b): b is Extract<AssistantBlock, { kind: 'checklist' }> => b.kind === 'checklist')!;
    const savedBlock = (...done: string[]) => ({
      ...verify,
      steps: verify.steps.map((step) => (done.includes(step.id) ? { ...step, done: true } : step)),
    });
    await checklist.getByRole('checkbox', { name: 'Run the test five times' }).click();
    await expect(checklist.getByText('1 of 3 done')).toBeVisible();
    await expect.poll(() => ticks.length).toBe(1);
    expect(new URL(ticks[0]!.url()).pathname).toBe('/api/assistant/conversations/501/messages/101/checklist');
    expect(ticks[0]!.method()).toBe('PATCH');
    expect(ticks[0]!.postDataJSON()).toEqual({ blockId: 'verify', stepId: 'repeat', done: true });
    await checklist.getByRole('checkbox', { name: 'Watch the project on the next run' }).click();
    await expect(checklist.getByText('2 of 3 done')).toBeVisible();
    await page.waitForTimeout(300);
    expect(ticks).toHaveLength(1);
    tickAnswers[0]!(savedBlock('repeat'));
    await expect.poll(() => ticks.length).toBe(2);
    expect(ticks[1]!.postDataJSON()).toEqual({ blockId: 'verify', stepId: 'watch', done: true });
    // The first tick's saved block does not undo the second, still being saved.
    await expect(checklist.getByText('2 of 3 done')).toBeVisible();
    tickAnswers[1]!(savedBlock('repeat', 'watch'));
    await expect(checklist.getByRole('checkbox', { name: 'Watch the project on the next run' })).toBeChecked();
    await expect(checklist.getByText('2 of 3 done')).toBeVisible();

    // The question: picks and an Other answer go back as words and as ids.
    const question = answer.locator('[data-assistant-block="question"]');
    await expect(question.getByRole('checkbox', { name: /cart › removes an item/ })).toBeChecked();
    await question.getByRole('checkbox', { name: /search › filters by price/ }).click();
    await question.getByLabel('Other').fill('checkout › pays by card');
    await question.getByRole('button', { name: 'Answer' }).click();
    await expect.poll(() => asks.length).toBe(2);
    expect(asks[1]!.postDataJSON()).toEqual({
      text: 'cart › removes an item, search › filters by price and checkout › pays by card',
      context: home,
      reply: {
        messageId: 101,
        blockId: 'next-tests',
        choiceIds: ['t21', 't23'],
        other: 'checkout › pays by card',
      },
    });
    await expect(panel.getByText('Then start with')).toBeVisible();
    // Answered, the question shows its answer read-only, and the options take no pick.
    await expect(question.getByText('Answered')).toBeVisible();
    await expect(question.getByRole('checkbox', { name: /search › filters by price/ })).toBeDisabled();
    await expect(question.getByLabel('Other')).toHaveValue('checkout › pays by card');
    await expect(options.getByRole('button', { name: /^Choose / })).toHaveCount(0);

    // Show me: the guide plays on the registry anchor; docked beside the page, the panel stays open.
    await answer.locator('[data-assistant-block="guide"]').getByRole('button', { name: 'Show me' }).click();
    await expect(panel).toHaveAttribute('data-assistant-docked');
    const popover = page.locator('.piwi-guide[data-guide="assistant-101-where"]');
    await expect(popover).toBeVisible({ timeout: 20_000 });
    await expect(popover).toHaveAttribute('data-guide-stop', 'stop-1');
    await expect(popover).toHaveAttribute('data-guide-anchor', 'project-health');
    await expect(popover).toContainText('Project health');

    // The panel kept the conversation.
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await openPanel(page);
    await expect(
      page
        .getByRole('dialog', { name: 'Ask Piwi' })
        .or(page.getByRole('complementary', { name: 'Ask Piwi' }))
        .getByText('Then start with'),
    ).toBeVisible();
  });

  test('a link to another tab of the page it was asked on opens that tab', async ({ page }) => {
    const done = fixture.replyAnswer.find((e) => e.event === 'done')!;
    const label = 'Open the run’s Changes tab';
    await routeAssistant(page, [
      {
        event: 'block',
        data: { block: { kind: 'navigate', id: 'open-changes', route: `/test-runs/${runId}?tab=changes`, label } },
      },
      done,
    ]);
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await expect(page.getByRole('button', { name: /^Tests/ })).toHaveAttribute('aria-current', 'true');

    const panel = await openPanel(page);
    await panel.getByLabel('Your question').fill('What changed since the baseline?');
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();
    await panel.getByRole('link', { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`/test-runs/${runId}\\?tab=changes$`));
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Changes', exact: true })).toHaveAttribute('aria-current', 'true');
  });

  test('the command palette asks its text in the panel', async ({ page }) => {
    const { asks } = await routeAssistant(page);
    await page.goto('/');
    await waitForHydration(page);
    await page.getByRole('button', { name: /^Search…/ }).click();
    await page.getByPlaceholder('Type a command or search…').fill('Why is the cart test flaky?');
    await page.getByRole('option', { name: /Ask Piwi/ }).click();
    await expect(
      page.getByRole('dialog', { name: 'Ask Piwi' }).or(page.getByRole('complementary', { name: 'Ask Piwi' })),
    ).toBeVisible();
    await expect.poll(() => asks.length).toBe(1);
    expect(asks[0]!.postDataJSON()).toMatchObject({ text: 'Why is the cart test flaky?' });
  });
});

test.describe('Assistant panel layout and input', () => {
  const done = fixture.replyAnswer.find((e) => e.event === 'done')!;

  test('docks beside the page from 1280 px, folding the sidebar while it is open, or floats over it', async ({
    page,
  }) => {
    await routeAssistant(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForHydration(page);
    const sidebar = page.locator('#dashboard-sidebar-default');
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');

    const docked = await openPanel(page);
    await expect(docked).toHaveAttribute('data-assistant-docked');
    // The page narrows beside it instead of being covered, and keeps its room with the sidebar folded.
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    const main = (await page.locator('#main-content').boundingBox())!;
    const box = (await docked.boundingBox())!;
    expect(main.x + main.width).toBeLessThanOrEqual(box.x + 1);
    expect(main.width).toBeGreaterThanOrEqual(760);

    // Floating, it covers the page and gives the sidebar back; the choice holds after a reload.
    await docked.getByRole('button', { name: 'Float over the page' }).click();
    const floating = page.getByRole('dialog', { name: 'Ask Piwi' });
    await expect(floating).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
    await page.reload();
    await waitForHydration(page);
    await openPanel(page);
    await expect(floating).toBeVisible();

    await floating.getByRole('button', { name: 'Dock beside the page' }).click();
    const again = page.getByRole('complementary', { name: 'Ask Piwi' });
    await expect(again).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    // Closed, it unfolds the sidebar it folded.
    await again.getByRole('button', { name: 'Close' }).click();
    await expect(again).toBeHidden();
    await expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  });

  test('Up brings back earlier questions, Right takes the suggested next one, and what is typed stays', async ({
    page,
  }) => {
    const next: AssistantBlock = { kind: 'next', id: 'next', question: 'How do I fix it?' };
    const { asks } = await routeAssistant(
      page,
      [{ event: 'text', data: { text: 'Run 12 timed out.' } }, { event: 'block', data: { block: next } }, done],
      { questions: ['What changed since yesterday?'] },
    );
    await page.goto('/');
    await waitForHydration(page);
    const panel = await openPanel(page);
    const input = panel.getByLabel('Your question');

    // An empty conversation offers the page's first question; after an answer, the one it suggests.
    await expect(input).toHaveAttribute('placeholder', 'What failed most this week?');
    await input.fill('Why did run 12 fail?');
    await input.press('Enter');
    await expect(panel.getByText('Run 12 timed out.')).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', 'How do I fix it?');
    await input.press('ArrowRight');
    await expect(input).toHaveValue('How do I fix it?');

    // Up walks back through this question and the earlier ones, Down returns to what was typed.
    await input.fill('');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('Why did run 12 fail?');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('What changed since yesterday?');
    await input.press('ArrowDown');
    await expect(input).toHaveValue('Why did run 12 fail?');
    await input.press('ArrowDown');
    await expect(input).toHaveValue('');
    expect(asks).toHaveLength(1);

    // What is typed stays when the panel closes; Ctrl+I opens it with the caret in the input, and closes it.
    await input.fill('Half a thought');
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(panel).toBeHidden();
    await page.keyboard.press('ControlOrMeta+i');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Half a thought');
    await page.keyboard.press('ControlOrMeta+i');
    await expect(panel).toBeHidden();
  });

  test('Stop ends the answer being written, and Try again asks its question again', async ({ page }) => {
    await routeAssistant(page);
    const asked: Request[] = [];
    const stops: Request[] = [];
    let release = () => {};
    const stopped = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/assistant/conversations/*/stop', (route) => {
      stops.push(route.request());
      release();
      return route.fulfill({ json: { stopped: true } });
    });
    await page.route('**/api/assistant/conversations/*/messages', async (route) => {
      asked.push(route.request());
      const first = asked.length === 1;
      if (first) await stopped;
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: eventStream(
          first
            ? [
                { event: 'text', data: { text: 'Run 12 failed' } },
                { event: 'error', data: { code: 'stopped', message: 'You stopped this answer.', messageId: 102 } },
              ]
            : [{ event: 'text', data: { text: 'Run 12 failed on a timeout.' } }, done],
        ),
      });
    });
    await page.goto('/');
    await waitForHydration(page);
    const panel = await openPanel(page);
    const input = panel.getByLabel('Your question');
    await input.fill('Why did run 12 fail?');
    await input.press('Enter');

    await expect(panel.getByRole('button', { name: 'Stop' })).toBeVisible();
    await input.press('Escape');
    await expect(panel.getByText('You stopped this answer.')).toBeVisible();
    expect(new URL(stops[0]!.url()).pathname).toBe('/api/assistant/conversations/501/stop');
    await expect(panel.getByRole('button', { name: 'Stop' })).toHaveCount(0);

    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(panel.getByText('Run 12 failed on a timeout.')).toBeVisible();
    expect(asked).toHaveLength(2);
    expect(asked[1]!.postDataJSON()).toEqual(asked[0]!.postDataJSON());
  });

  test('the usage gauge says what the limits leave, warns from 80% and stops the input once spent', async ({
    page,
  }) => {
    const freesAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const status: AssistantStatus = {
      ...fixture.status,
      allowance: { scope: 'user', limit: 1_000_000, used: 850_000, freesAt },
      subscription: {
        status: 'allowed',
        window: 'five_hour',
        utilization: 0.3,
        resetsAt: freesAt,
        reportedAt: new Date().toISOString(),
      },
    };
    await routeAssistant(page, fixture.answer, { status });
    await page.goto('/');
    await waitForHydration(page);
    const panel = await openPanel(page);
    await expect(panel.locator('[data-assistant-usage-warning]')).toContainText(
      '85% of your daily assistant allowance is spent. It frees up at',
    );
    await panel.getByRole('button', { name: 'Usage limits: 85% spent' }).click();
    const details = page.locator('[data-assistant-usage-details]');
    await expect(details).toContainText('Your daily allowance');
    await expect(details).toContainText('850,000 of 1,000,000 tokens in the last 24 hours');
    await expect(details).toContainText('Claude subscription · 5-hour window');
    await expect(details).toContainText('30% used');
    await page.keyboard.press('Escape');

    await page.unroute('**/api/assistant/**');
    await routeAssistant(page, fixture.answer, {
      status: { ...status, allowance: { ...status.allowance!, used: 1_000_000 } },
    });
    await page.reload();
    await waitForHydration(page);
    const spent = await openPanel(page);
    await expect(spent.locator('[data-assistant-usage-warning]')).toContainText(
      'You reached your daily assistant allowance.',
    );
    await spent.getByLabel('Your question').fill('Why did run 12 fail?');
    await expect(spent.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  });
});

test.describe('Assistant panel on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('fills the screen with no sideways scroll', async ({ page }) => {
    await routeAssistant(page);
    await page.goto('/');
    await waitForHydration(page);
    const panel = await openPanel(page);
    await panel.getByLabel('Your question').fill(fixture.question);
    await panel.getByLabel('Your question').press('Enter');
    await expect(panel.locator('[data-assistant-block="question"]')).toBeVisible();

    const box = await panel.boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 375, height: 812 });
    const widths = await page.evaluate(() => {
      const scroller = document.querySelector('[data-assistant-panel]')!;
      return {
        page: document.documentElement.scrollWidth,
        panel: scroller.scrollWidth,
        panelClient: scroller.clientWidth,
      };
    });
    expect(widths.page).toBeLessThanOrEqual(375);
    expect(widths.panel).toBeLessThanOrEqual(widths.panelClient);
  });
});
