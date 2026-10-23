/**
 * The assistant's panel. Against a mock OpenAI-compatible model, a question
 * asked in the panel streams its answer and the tool it called. With the ask
 * route answered by a fixed event stream, every kind of block renders, a
 * question is answered with the reply the contract describes, a checklist
 * tick reaches its route and **Show me** plays a guide on a registry anchor.
 * At phone width the panel fills the screen without scrolling sideways.
 */
import { test, expect } from './fixtures';
import type { Page, Request } from '@playwright/test';
import * as http from 'http';
import * as net from 'net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROJECT } from '#shared/test-project-names';
import {
  assistantFrame,
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

/** A model that calls `list_projects` on a question, then answers {@link MOCK_ANSWER} in two pieces. */
function startMockModel(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { messages: Array<{ role: string }> };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const write = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (body.messages.at(-1)?.role === 'tool') {
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
  const panel = page.getByRole('dialog', { name: 'Ask Piwi' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Answers every assistant route in the browser: the status, a conversation, the fixture's answers. */
async function routeAssistant(page: Page) {
  const asks: Request[] = [];
  const ticks: Request[] = [];
  await page.route('**/api/assistant/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname.endsWith('/assistant/status')) return route.fulfill({ json: fixture.status });
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
        body: eventStream(asks.length === 1 ? fixture.answer : fixture.replyAnswer),
      });
    }
    if (pathname.endsWith('/checklist')) {
      ticks.push(request);
      return route.fulfill({ json: { success: true } });
    }
    return route.fallback();
  });
  return { asks, ticks };
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
    for (const conversation of list.items ?? []) {
      if (conversation.title === 'Which projects report to this instance?') {
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
});

test.describe('Assistant panel blocks', () => {
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
  });

  test('renders every block, answers a question, ticks a step and plays a guide', async ({ page }) => {
    test.setTimeout(120_000);
    const { asks, ticks } = await routeAssistant(page);
    await page.goto('/');
    await waitForHydration(page);
    const panel = await openPanel(page);
    await panel.getByLabel('Your question').fill(fixture.question);
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();

    // The question goes with the page it was asked on.
    await expect.poll(() => asks.length).toBe(1);
    expect(asks[0]!.postDataJSON()).toEqual({
      text: fixture.question,
      context: { route: '/', page: '/', projectId: null },
    });

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

    // A checklist tick is saved through its route.
    await checklist.getByRole('checkbox', { name: 'Run the test five times' }).click();
    await expect(checklist.getByText('1 of 3 done')).toBeVisible();
    await expect.poll(() => ticks.length).toBe(1);
    expect(new URL(ticks[0]!.url()).pathname).toBe('/api/assistant/conversations/501/messages/101/checklist');
    expect(ticks[0]!.method()).toBe('PATCH');
    expect(ticks[0]!.postDataJSON()).toEqual({ blockId: 'verify', stepId: 'repeat', done: true });

    // The question: picks and an Other answer go back as words and as ids.
    const question = answer.locator('[data-assistant-block="question"]');
    await expect(question.getByRole('checkbox', { name: /cart › removes an item/ })).toBeChecked();
    await question.getByRole('checkbox', { name: /search › filters by price/ }).click();
    await question.getByLabel('Other').fill('checkout › pays by card');
    await question.getByRole('button', { name: 'Answer' }).click();
    await expect.poll(() => asks.length).toBe(2);
    expect(asks[1]!.postDataJSON()).toEqual({
      text: 'cart › removes an item, search › filters by price and checkout › pays by card',
      context: { route: '/', page: '/', projectId: null },
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

    // Show me: the panel closes and the guide plays on the registry anchor.
    await answer.locator('[data-assistant-block="guide"]').getByRole('button', { name: 'Show me' }).click();
    await expect(panel).toBeHidden();
    const popover = page.locator('.piwi-guide[data-guide="assistant-101-where"]');
    await expect(popover).toBeVisible({ timeout: 20_000 });
    await expect(popover).toHaveAttribute('data-guide-stop', 'stop-1');
    await expect(popover).toHaveAttribute('data-guide-anchor', 'project-health');
    await expect(popover).toContainText('Project health');

    // The panel kept the conversation.
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await openPanel(page);
    await expect(page.getByRole('dialog', { name: 'Ask Piwi' }).getByText('Then start with')).toBeVisible();
  });

  test('the command palette asks its text in the panel', async ({ page }) => {
    const { asks } = await routeAssistant(page);
    await page.goto('/');
    await waitForHydration(page);
    await page.getByRole('button', { name: /^Search…/ }).click();
    await page.getByPlaceholder('Type a command or search…').fill('Why is the cart test flaky?');
    await page.getByRole('option', { name: /Ask Piwi/ }).click();
    await expect(page.getByRole('dialog', { name: 'Ask Piwi' })).toBeVisible();
    await expect.poll(() => asks.length).toBe(1);
    expect(asks[0]!.postDataJSON()).toMatchObject({ text: 'Why is the cart test flaky?' });
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
