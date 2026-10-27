/**
 * The assistant's answers measured against a real model. A server of its own,
 * on its own port and a throwaway database seeded with the demo seed, answers
 * every question of `assistant-questions.ts` in a fresh conversation, with the
 * page context the panel sends; each answer is scored (`assistant-scoring.ts`)
 * and the report is written to `.live-temp/assistant/` after every answer:
 * `report.json` with each answer, its checks and what it missed, and
 * `summary.md` per topic and overall. The run fails only when the overall
 * score is below `PASS_THRESHOLD`.
 *
 * The model comes from the environment, as for the diagnosis live run:
 * `OPENCODE_API_KEY` (or `PIWI_AI_API_KEY`), `PIWI_AI_BASE_URL` and
 * `PIWI_AI_MODEL`, an OpenAI-compatible endpoint. `PIWI_ASSISTANT_LIVE_QUESTIONS`
 * (question ids or topics, comma-separated) asks part of the set.
 *
 * With no key and `PIWI_ASSISTANT_LIVE_MOCK=1`, a scripted mock model answers
 * a few questions the way their expectations describe and one badly, and the
 * run checks the scores and the report: the runner proved with no tokens.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import * as http from 'node:http';
import * as net from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantConversation, AssistantStatus } from '#shared/assistant';
import { findGuideAnchor } from '../../shared/guide-anchors/index.mjs';
import { APP_DIR, seedThrowawayDb, startServer } from '../../scripts/lib/dev-server.mjs';
import { LIVE_QUESTIONS, questionContext, type LiveQuestion } from './assistant-questions';
import {
  PASS_THRESHOLD,
  buildReport,
  renderSummary,
  scoreAnswer,
  type LiveAnswer,
  type LiveReport,
  type QuestionResult,
} from './assistant-scoring';

const API_KEY = process.env.OPENCODE_API_KEY || process.env.PIWI_AI_API_KEY || '';
const MOCK = !API_KEY && process.env.PIWI_ASSISTANT_LIVE_MOCK === '1';
const MODEL = MOCK ? 'mock-assistant' : process.env.PIWI_AI_MODEL || 'deepseek-v4-flash';

const PORT = 3104;
const LIVE_DIR = join(APP_DIR, '.live-temp', 'assistant');
const REPORT_JSON = join(LIVE_DIR, 'report.json');
const SUMMARY_MD = join(LIVE_DIR, 'summary.md');

/** How long one question may take: the server's turn timeout (180 s by default) and a margin. */
const QUESTION_TIMEOUT_MS = 240_000;

/**
 * The questions the mock model answers the way their expectations describe,
 * with the arguments of the read tool it calls first; and the one it answers
 * badly, with no tool and no fact.
 */
const MOCK_PERFECT: Readonly<Record<string, Record<string, unknown>>> = {
  'cluster-login-ticket': { clusterId: 3 },
  'checkout-quarantine-pick': { projectId: 1 },
  'github-actions': { page: 'guide/ci' },
  'show-flaky-list': { query: 'flaky tests' },
};
const MOCK_BAD = 'telemetry';

function questionsToAsk(): LiveQuestion[] {
  if (MOCK) return LIVE_QUESTIONS.filter((q) => q.id in MOCK_PERFECT || q.id === MOCK_BAD);
  const only = (process.env.PIWI_ASSISTANT_LIVE_QUESTIONS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!only.length) return [...LIVE_QUESTIONS];
  const picked = LIVE_QUESTIONS.filter((q) => only.includes(q.id) || only.includes(q.topic));
  if (!picked.length) throw new Error(`PIWI_ASSISTANT_LIVE_QUESTIONS names no question or topic: ${only.join(', ')}`);
  return picked;
}

const QUESTIONS = questionsToAsk();

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

// ── The mock model ───────────────────────────────────────────────────────────

type ChatMessage = { role: string; content?: string | null };
type ChatBody = { messages: ChatMessage[] };

/** The answer's words for each fact of a question: its first string alternative. */
function mockFactText(question: LiveQuestion): string {
  const said = question.facts.map((fact) => {
    const text = fact.any.find((a): a is string => typeof a === 'string');
    if (!text)
      throw new Error(`The mock model cannot say ${fact.from} of ${question.id}: it has no string alternative`);
    return text;
  });
  return said.length ? `From what I read: ${said.join('; ')}.` : 'Here it is.';
}

/** The block tool call that makes the first block kind a question expects. */
function mockBlockCall(question: LiveQuestion): { name: string; args: object } | null {
  const kind = question.blocks?.[0];
  if (kind === undefined) return null;
  if (kind === 'question') {
    const choices = [
      { id: 'first', label: 'The first one' },
      { id: 'second', label: 'The second one' },
    ];
    return { name: 'ask', args: { id: 'pick', prompt: 'Which ones?', multiple: true, choices } };
  }
  if (kind === 'checklist') {
    return {
      name: 'checklist',
      args: { id: 'steps', title: 'Set it up', steps: [{ id: 'first', text: 'Start here.' }] },
    };
  }
  if (kind === 'guide') {
    const anchor = findGuideAnchor(question.anchors![0]!)!;
    const stop = { anchor: anchor.id, route: anchor.sample.route, title: 'Here', body: 'Look here.' };
    return { name: 'show_guide', args: { id: 'where', title: 'Where it is', stops: [stop] } };
  }
  throw new Error(`The mock model makes no ${kind} block`);
}

/**
 * An OpenAI-compatible model that answers each of {@link MOCK_PERFECT} as its
 * expectations describe: it calls the question's first tool, then writes the
 * facts with the block it expects, then ends; a question or options block ends
 * the answer at once. It answers {@link MOCK_BAD}, and anything else, with a
 * sentence and no tool. It keeps each system prompt it read.
 */
function startMockModel(port: number): { server: http.Server; systemPrompts: string[] } {
  const systemPrompts: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as ChatBody;
      systemPrompts.push(body.messages.find((m) => m.role === 'system')?.content ?? '');
      const lastUser = body.messages.map((m) => m.role).lastIndexOf('user');
      const asked = body.messages[lastUser]?.content ?? '';
      const results = body.messages.slice(lastUser + 1).filter((m) => m.role === 'tool').length;
      const question = LIVE_QUESTIONS.find((q) => q.question === asked && q.id in MOCK_PERFECT);

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const write = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      const finish = (reason: 'stop' | 'tool_calls') => {
        write({
          choices: [{ delta: {}, finish_reason: reason }],
          usage: { prompt_tokens: 800, completion_tokens: 40 },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      };
      const say = (text: string) => write({ model: 'mock-assistant', choices: [{ delta: { content: text } }] });
      const call = (id: string, name: string, args: object) => {
        const toolCall = { index: 0, id, function: { name, arguments: JSON.stringify(args) } };
        write({ model: 'mock-assistant', choices: [{ delta: { tool_calls: [toolCall] } }] });
        finish('tool_calls');
      };

      if (!question) {
        say('I could not find anything about that.');
        return finish('stop');
      }
      const block = mockBlockCall(question);
      if (results === 0) return call('call-read', question.tools[0]!, MOCK_PERFECT[question.id]!);
      if (results === 1 && block) {
        say(mockFactText(question));
        return call('call-block', block.name, block.args);
      }
      say(results === 1 ? mockFactText(question) : 'That is all.');
      finish('stop');
    });
  });
  server.listen(port, '127.0.0.1');
  return { server, systemPrompts };
}

// ── Asking ──────────────────────────────────────────────────────────────────

/** The events of a Server-Sent Events body, in order. */
function parseEvents(body: string): Array<{ event: string; data: any }> {
  return body
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: '))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split('\n');
      return { event: eventLine!.slice('event: '.length), data: JSON.parse(dataLine!.slice('data: '.length)) };
    });
}

/**
 * Ask one question in a new conversation and read its answer: the stream for
 * how the turn ended and what it cost, the stored answer for its blocks and
 * its tool calls with their errors. A failure to get one is the answer's error.
 */
async function ask(api: APIRequestContext, question: LiveQuestion): Promise<LiveAnswer> {
  const started = Date.now();
  const answer: LiveAnswer = {
    blocks: [],
    toolCalls: [],
    error: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    durationMs: 0,
  };
  try {
    const created = await api.post('/api/assistant/conversations', { data: {} });
    if (created.status() !== 201) throw new Error(`starting a conversation answered HTTP ${created.status()}`);
    const { id } = (await created.json()) as { id: number };
    const res = await api.post(`/api/assistant/conversations/${id}/messages`, {
      data: { text: question.question, context: questionContext(question) },
      timeout: QUESTION_TIMEOUT_MS,
    });
    const body = await res.text();
    if (!res.ok()) throw new Error(`the question answered HTTP ${res.status()}: ${body.slice(0, 300)}`);
    const last = parseEvents(body).at(-1);
    if (last?.event === 'done') {
      answer.model = last.data.model;
      answer.inputTokens = last.data.inputTokens;
      answer.outputTokens = last.data.outputTokens;
    } else {
      answer.error = last?.event === 'error' ? `${last.data.code}: ${last.data.message}` : 'no done event';
    }

    const conversation = (await (await api.get(`/api/assistant/conversations/${id}`)).json()) as AssistantConversation;
    const stored = conversation.messages.findLast((m) => m.role === 'assistant');
    answer.blocks = stored?.blocks ?? [];
    answer.toolCalls = stored?.toolCalls ?? [];
  } catch (err) {
    answer.error = err instanceof Error ? err.message : String(err);
  }
  answer.durationMs = Date.now() - started;
  return answer;
}

function writeReport(report: LiveReport): void {
  mkdirSync(LIVE_DIR, { recursive: true });
  writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(SUMMARY_MD, renderSummary(report));
}

function checkLine(result: QuestionResult): string {
  const mark = (value: boolean | number | null) =>
    value === null ? '-' : typeof value === 'number' ? `${Math.round(value * 100)}%` : value ? 'yes' : 'no';
  return `${result.score.toFixed(2)}  tools ${mark(result.tools)}  facts ${mark(result.facts)}  blocks ${mark(result.blocks)}  anchors ${mark(result.anchors)}${result.error ? `  error: ${result.error}` : ''}`;
}

// ── The run ─────────────────────────────────────────────────────────────────

let api: APIRequestContext;
let stopServer = () => {};
let mock: ReturnType<typeof startMockModel> | null = null;

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  let baseUrl = process.env.PIWI_AI_BASE_URL || 'https://opencode.ai/zen/v1';
  if (MOCK) {
    const port = await getFreePort();
    mock = startMockModel(port);
    baseUrl = `http://127.0.0.1:${port}/v1`;
  }
  const server = await startServer({
    port: PORT,
    env: {
      // A throwaway database with the demo seed: no authentication, no AI, no issue tracker.
      ...seedThrowawayDb(join(LIVE_DIR, 'server')),
      PIWI_BUILD_DIR: join(LIVE_DIR, 'nuxt-build'),
      PIWI_SECRET_KEY: process.env.PIWI_SECRET_KEY || 'live-e2e-encryption-key-not-for-production',
      PIWI_AI_PROVIDER: 'openai',
      PIWI_AI_BASE_URL: baseUrl,
      PIWI_AI_MODEL: MODEL,
      PIWI_AI_API_KEY: MOCK ? 'mock' : API_KEY,
      // Reasoning tokens count toward the completion budget, which the default per-call cap cuts short.
      PIWI_AI_ASSISTANT_MAX_OUTPUT_TOKENS: '8192',
      // The whole set spends more than one user's daily cap.
      PIWI_AI_ASSISTANT_DAILY_TOKENS_PER_USER: '0',
      PIWI_AI_ASSISTANT_DAILY_TOKENS: '0',
    },
  });
  stopServer = server.stop;
  api = await playwrightRequest.newContext({ baseURL: server.base });

  // The seed stores the demo's own diagnosis role, whose model would override the environment's.
  expect((await api.put('/api/settings/ai', { data: { roles: null } })).ok()).toBeTruthy();
  const status = (await (await api.get('/api/assistant/status')).json()) as AssistantStatus;
  expect(status).toMatchObject({
    available: true,
    provider: 'openai',
    model: MOCK ? MODEL : process.env.PIWI_AI_ASSISTANT_MODEL || MODEL,
  });
});

test.afterAll(async () => {
  await api?.dispose();
  stopServer();
  mock?.server.close();
});

test(`the assistant answers ${QUESTIONS.length} questions above the threshold`, async () => {
  test.setTimeout(QUESTIONS.length * QUESTION_TIMEOUT_MS + 60_000);
  const run = {
    mode: MOCK ? 'mock' : 'live',
    provider: 'openai',
    model: MODEL,
    startedAt: new Date().toISOString(),
  } as const;
  const results: QuestionResult[] = [];
  for (const [i, question] of QUESTIONS.entries()) {
    const result = scoreAnswer(question, await ask(api, question));
    results.push(result);
    writeReport(buildReport(run, results));
    console.log(`[${i + 1}/${QUESTIONS.length}] ${question.id}  ${checkLine(result)}`);
  }
  const report = buildReport(run, results);
  writeReport(report);
  console.log(`\n${renderSummary(report)}\nReport: ${REPORT_JSON}`);

  if (MOCK) {
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const id of Object.keys(MOCK_PERFECT)) {
      expect(byId.get(id), `${id}: ${JSON.stringify(byId.get(id))}`).toMatchObject({ score: 1, error: null });
    }
    expect(byId.get(MOCK_BAD)).toMatchObject({ score: 0, tools: false, facts: 0, error: null });
    expect(report.overall.score).toBeCloseTo(0.8);
    // The page context reached the model: the ticket question was asked on its cluster.
    expect(mock!.systemPrompts.some((prompt) => prompt.includes('"route":"/failure-clusters/3"'))).toBe(true);
    const written = JSON.parse(readFileSync(REPORT_JSON, 'utf8')) as LiveReport;
    expect(written.results.map((r) => r.id)).toEqual(QUESTIONS.map((q) => q.id));
    expect(written.topics.flaky).toMatchObject({ questions: 1, score: 1, blocks: 1 });
    expect(written.topics.piwi).toMatchObject({ questions: 1, score: 0, tools: 0, facts: 0 });
    const summary = readFileSync(SUMMARY_MD, 'utf8');
    expect(summary).toContain('| show-me | 1 | 1.00 |');
    expect(summary).toContain(`**${MOCK_BAD}** (piwi, 0.00)`);
  }

  expect(report.overall.score, `the overall score, threshold ${PASS_THRESHOLD}`).toBeGreaterThanOrEqual(PASS_THRESHOLD);
});
