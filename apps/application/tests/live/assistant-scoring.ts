/**
 * How `assistant-live.spec.ts` scores an answer against its question
 * (`assistant-questions.ts`), and the report it writes.
 *
 * Each question has up to four checks, each counted only when the question
 * sets it:
 *
 * - tools: the answer called one of the question's tools, and the call did
 *   not fail;
 * - facts: the share of the question's facts the answer says, in its text or
 *   in the words of its blocks (a choice's label, a checklist step, a
 *   command, a guide's stops);
 * - blocks: the answer has a block of one of the question's kinds; a guide in
 *   a checklist step or an option counts as a guide;
 * - anchors: a guide of the answer stops on one of the question's anchors.
 *
 * An answer's score is the mean of its checks, between 0 and 1. An answer
 * that ended in an error, or that never arrived, scores 0. A topic's score
 * and the overall score are the mean of their answers' scores, and the run
 * fails when the overall score is below {@link PASS_THRESHOLD}.
 */
import type { AssistantBlock, AssistantGuidePlan, AssistantToolCall } from '#shared/assistant';
import { QUESTION_TOPICS, type LiveQuestion, type QuestionFact, type QuestionTopic } from './assistant-questions';

/** The overall score below which the live run fails. */
export const PASS_THRESHOLD = 0.6;

/**
 * Text as facts are matched in it: color codes dropped, quotes made straight
 * and single, Markdown emphasis and code marks dropped, every arrow written
 * ` > `, white space collapsed.
 */
export function normalizeFactText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const colors = /\u001b\[[0-9;]*m/g;
  return text
    .replace(colors, '')
    .replace(/[‘’"“”]/g, "'")
    .replace(/[*`]/g, '')
    .replace(/\s*(?:→|›|->|>)\s*/g, ' > ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether `text`, already normalized, holds one of the fact's alternatives. */
export function factIn(fact: QuestionFact, text: string): boolean {
  const lower = text.toLowerCase();
  return fact.any.some((alternative) =>
    typeof alternative === 'string'
      ? lower.includes(normalizeFactText(alternative).toLowerCase())
      : alternative.test(text),
  );
}

/** What one question got back: the stream's blocks and outcome, and the tool calls stored with the answer. */
export interface LiveAnswer {
  blocks: AssistantBlock[];
  toolCalls: AssistantToolCall[];
  /** The error the turn ended with, or why no answer arrived. */
  error: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

export interface QuestionResult {
  id: string;
  topic: QuestionTopic;
  question: string;
  on: string | null;
  score: number;
  /** Each check the question sets: true or false, the share of facts found, or null when it sets none. */
  tools: boolean | null;
  facts: number | null;
  blocks: boolean | null;
  anchors: boolean | null;
  error: string | null;
  called: string[];
  failedCalls: string[];
  blockKinds: string[];
  anchorsUsed: string[];
  missingFacts: string[];
  answer: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

const SKIPPED_KEYS = new Set(['id', 'kind', 'type', 'anchor', 'route', 'validation', 'language', 'answer']);

/** Every word a block shows: its text, or the strings of its fields but ids, routes and anchors. */
function blockWords(value: unknown, key = ''): string[] {
  if (SKIPPED_KEYS.has(key)) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => blockWords(item));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => blockWords(v, k));
  }
  return [];
}

/** The guides of an answer: its guide blocks, and those of its checklist steps and options. */
function answerGuides(blocks: readonly AssistantBlock[]): AssistantGuidePlan[] {
  return blocks.flatMap((block): AssistantGuidePlan[] => {
    if (block.kind === 'guide') return [block.guide];
    if (block.kind === 'checklist') return block.steps.flatMap((step) => (step.guide ? [step.guide] : []));
    if (block.kind === 'options') return block.options.flatMap((option) => (option.guide ? [option.guide] : []));
    return [];
  });
}

function describeFact(fact: QuestionFact): string {
  return `${fact.from}: ${fact.any.map((a) => (typeof a === 'string' ? `"${a}"` : String(a))).join(' | ')}`;
}

export function scoreAnswer(question: LiveQuestion, answer: LiveAnswer): QuestionResult {
  const called = answer.toolCalls.filter((call) => !call.error).map((call) => call.name);
  const failedCalls = answer.toolCalls.filter((call) => call.error).map((call) => `${call.name}: ${call.error}`);
  const guides = answerGuides(answer.blocks);
  const blockKinds = [...new Set([...answer.blocks.map((b) => b.kind), ...(guides.length ? ['guide'] : [])])].filter(
    (kind) => kind !== 'text',
  );
  const anchorsUsed = [...new Set(guides.flatMap((guide) => guide.stops.map((stop) => stop.anchor)))];
  const answerText = normalizeFactText(blockWords(answer.blocks).join('\n'));
  const missing = question.facts.filter((fact) => !factIn(fact, answerText));

  const failed = answer.error !== null;
  const tools = question.tools.length ? !failed && question.tools.some((name) => called.includes(name)) : null;
  const facts = question.facts.length ? (failed ? 0 : 1 - missing.length / question.facts.length) : null;
  const blocks = question.blocks?.length ? !failed && question.blocks.some((kind) => blockKinds.includes(kind)) : null;
  const anchors = question.anchors?.length
    ? !failed && question.anchors.some((anchor) => anchorsUsed.includes(anchor))
    : null;

  const checks = [tools, facts, blocks, anchors].filter((c): c is boolean | number => c !== null).map(Number);
  const score = failed || checks.length === 0 ? 0 : checks.reduce((sum, c) => sum + c, 0) / checks.length;

  return {
    id: question.id,
    topic: question.topic,
    question: question.question,
    on: question.on ?? null,
    score,
    tools,
    facts,
    blocks,
    anchors,
    error: answer.error,
    called,
    failedCalls,
    blockKinds,
    anchorsUsed,
    missingFacts: (failed ? question.facts : missing).map(describeFact),
    answer: answerText.slice(0, 2000),
    inputTokens: answer.inputTokens,
    outputTokens: answer.outputTokens,
    durationMs: answer.durationMs,
  };
}

export interface ScoreSummary {
  questions: number;
  score: number;
  /** The share of answers passing each check, over the questions that set it; null when none does. */
  tools: number | null;
  facts: number | null;
  blocks: number | null;
  anchors: number | null;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LiveReport {
  mode: 'live' | 'mock';
  provider: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  threshold: number;
  passed: boolean;
  overall: ScoreSummary;
  topics: Partial<Record<QuestionTopic, ScoreSummary>>;
  results: QuestionResult[];
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function summarize(results: readonly QuestionResult[]): ScoreSummary {
  const rate = (pick: (r: QuestionResult) => boolean | number | null) =>
    mean(
      results
        .map(pick)
        .filter((v): v is boolean | number => v !== null)
        .map(Number),
    );
  return {
    questions: results.length,
    score: mean(results.map((r) => r.score)) ?? 0,
    tools: rate((r) => r.tools),
    facts: rate((r) => r.facts),
    blocks: rate((r) => r.blocks),
    anchors: rate((r) => r.anchors),
    errors: results.filter((r) => r.error).length,
    inputTokens: results.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
    outputTokens: results.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
  };
}

export function buildReport(
  run: Pick<LiveReport, 'mode' | 'provider' | 'model' | 'startedAt'>,
  results: readonly QuestionResult[],
): LiveReport {
  const overall = summarize(results);
  const topics: LiveReport['topics'] = {};
  for (const topic of QUESTION_TOPICS) {
    const ofTopic = results.filter((r) => r.topic === topic);
    if (ofTopic.length) topics[topic] = summarize(ofTopic);
  }
  return {
    ...run,
    finishedAt: new Date().toISOString(),
    threshold: PASS_THRESHOLD,
    passed: overall.score >= PASS_THRESHOLD,
    overall,
    topics,
    results: [...results],
  };
}

const percent = (value: number | null) => (value === null ? '–' : `${Math.round(value * 100)}%`);

function summaryRow(name: string, s: ScoreSummary): string {
  return `| ${name} | ${s.questions} | ${s.score.toFixed(2)} | ${percent(s.tools)} | ${percent(s.facts)} | ${percent(s.blocks)} | ${percent(s.anchors)} | ${s.errors} | ${s.inputTokens + s.outputTokens} |`;
}

/** The report as a short Markdown summary: per topic and overall, then the weakest answers. */
export function renderSummary(report: LiveReport): string {
  const weakest = report.results
    .filter((r) => r.score < 1)
    .sort((a, b) => a.score - b.score)
    .slice(0, 15)
    .map((r) => {
      const misses = [
        r.error ? `error: ${r.error}` : null,
        r.tools === false ? `no tool of the expected ones (called: ${r.called.join(', ') || 'none'})` : null,
        r.missingFacts.length ? `missing ${r.missingFacts.join('; ')}` : null,
        r.blocks === false ? `no expected block (got: ${r.blockKinds.join(', ') || 'text only'})` : null,
        r.anchors === false ? `no expected anchor (used: ${r.anchorsUsed.join(', ') || 'none'})` : null,
      ].filter(Boolean);
      return `- **${r.id}** (${r.topic}, ${r.score.toFixed(2)}): ${misses.join('; ')}`;
    });
  return [
    `# Assistant live run: ${report.provider} ${report.model}`,
    '',
    `${report.mode === 'mock' ? 'Mock model. ' : ''}${report.results.length} questions, ${report.startedAt} to ${report.finishedAt}.`,
    `Overall score **${report.overall.score.toFixed(2)}**, threshold ${report.threshold}: ${report.passed ? 'passed' : 'failed'}.`,
    '',
    '| Topic | Questions | Score | Tools | Facts | Blocks | Anchors | Errors | Tokens |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...QUESTION_TOPICS.flatMap((topic) => {
      const summary = report.topics[topic];
      return summary ? [summaryRow(topic, summary)] : [];
    }),
    summaryRow('**overall**', report.overall),
    '',
    '## Weakest answers',
    '',
    ...(weakest.length ? weakest : ['Every answer scored 1.']),
    '',
  ].join('\n');
}
