/**
 * A test's card (`piwi/testCard`), laid out as the dashboard's test row: its latest results as a strip, each to its
 * run, how they went, its last failure, its owner, tags and quarantine, in the words both clients show.
 */
import type { TestExecution } from './piwi-client.js';
import { TEST_CARD_RESULTS, type TestCard, type TestCardResult } from './protocol.js';

/** What a card is built from: the test, its history newest first, and the instance's pages. */
export interface TestCardInput {
  testCaseId: number;
  title: string;
  url: string;
  owner: string | null;
  tags: string[];
  /** Its quarantine in words (`quarantined 3 d · 2/5 passes toward release`); null when it is not quarantined. */
  quarantine: string | null;
  executions: TestExecution[];
  runUrl: (runId: number) => string;
  now: number;
}

/** Each result's mark in the strip. */
const MARKS: Record<TestCardResult['status'], string> = { passed: '✓', failed: '✗', flaky: '◐', skipped: '○' };

/** The longest part of a failure's message a card shows. */
const MAX_FAILURE = 160;

/** An execution's outcome as the card counts it; null for one it does not show (a run that did not finish it). */
export function cardStatus(e: TestExecution): TestCardResult['status'] | null {
  if (e.status === 'passed') return e.passedAfterFailure ? 'flaky' : 'passed';
  if (e.status === 'flaky') return 'flaky';
  if (e.status === 'failed' || e.status === 'timedOut' || e.status === 'interrupted') return 'failed';
  if (e.status === 'skipped') return 'skipped';
  return null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A duration in ms as the dashboard says it: `850 ms`, `1.4 s`, `2 min`. */
export function durationWords(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** How long ago `at` was: `just now`, `5 min ago`, `3 h ago`, `2 d ago`; null for an unknown time. */
export function agoWords(at: string | null, now: number): string | null {
  const t = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  const minutes = Math.max(0, Math.round((now - t) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** The first line of a failure's message, cut to `MAX_FAILURE` characters. */
function failureLine(error: string): string {
  const line =
    error
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  return line.length > MAX_FAILURE ? `${line.slice(0, MAX_FAILURE - 1)}…` : line;
}

const mdText = (text: string) => text.replace(/[\\`*_[\]<>#|]/g, (c) => `\\${c}`);
const mdCode = (text: string) => `\`${text.replace(/`/g, "'")}\``;
const html = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A test's card from its history. */
export function testCard(input: TestCardInput): TestCard {
  const results = input.executions
    .flatMap((e): TestCardResult[] => {
      const status = cardStatus(e);
      return status
        ? [{ status, runId: e.runId, url: input.runUrl(e.runId), at: e.startTime, durationMs: e.duration }]
        : [];
    })
    .slice(0, TEST_CARD_RESULTS);
  const counted = results.filter((r) => r.status !== 'skipped');
  const passed = counted.filter((r) => r.status === 'passed').length;
  const flaky = counted.filter((r) => r.status === 'flaky').length;
  const durations = results
    .map((r) => r.durationMs)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : null;
  const summary = counted.length
    ? [
        `Passed ${passed} of the last ${plural(counted.length, 'run')}`,
        flaky ? `${flaky} flaky` : '',
        median !== null ? `median ${durationWords(median)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : 'No result yet';
  const failed = input.executions.find((e) => cardStatus(e) === 'failed');
  const failedAgo = failed ? agoWords(failed.startTime, input.now) : null;
  const failedWhere = failed ? `Last failed in run #${failed.runId}${failedAgo ? `, ${failedAgo}` : ''}` : null;
  const failedWhy = failed?.error ? failureLine(failed.error) : null;
  const about = [
    input.owner ? `owner ${input.owner}` : '',
    input.tags.length ? input.tags.map((t) => `@${t}`).join(' ') : '',
    input.quarantine ?? '',
  ].filter(Boolean);
  // The strip reads as the dashboard's: oldest on the left, newest on the right.
  const strip = [...results].reverse();
  const tip = (r: TestCardResult) =>
    [`run #${r.runId}`, r.status, r.durationMs !== null ? durationWords(r.durationMs) : ''].filter(Boolean).join(' · ');

  const markdown = [
    `**Piwi** · ${mdText(input.title)}`,
    strip.length ? strip.map((r) => `[${MARKS[r.status]}](${r.url} "${tip(r)}")`).join(' ') : '',
    summary,
    failedWhere ? `${failedWhere}${failedWhy ? `: ${mdCode(failedWhy)}` : ''}` : '',
    about.map(mdText).join(' · '),
  ]
    .filter(Boolean)
    .join('\n\n');
  const htmlText = [
    `<b>Piwi</b> · ${html(input.title)}`,
    strip.length
      ? strip.map((r) => `<a href="${html(r.url)}" title="${html(tip(r))}">${MARKS[r.status]}</a>`).join(' ')
      : '',
    html(summary),
    failedWhere ? `${html(failedWhere)}${failedWhy ? `: <code>${html(failedWhy)}</code>` : ''}` : '',
    about.map(html).join(' · '),
  ]
    .filter(Boolean)
    .join('<br>');
  return { testCaseId: input.testCaseId, title: input.title, url: input.url, results, markdown, html: htmlText };
}
