import { describeFailureText, stepHeadlineContext, type HeadlineStepLike } from '@piwitests/core/describe-failure';
import type { Logger } from './logger.js';

/** A test whose final attempt failed, with what the dashboard needs to find its execution. */
export interface FailedTest {
  title: string;
  /** Spec path relative to the working directory, POSIX separators. */
  file: string;
  /** Attempt index of the failing (final) attempt. */
  retry: number;
  /** Playwright project name the test ran under, when known. */
  browser: string | null;
  /** Which `--repeat-each` repetition failed (`TestCase.repeatEachIndex`); 0 or absent without repeats. */
  repeatEachIndex?: number;
  /** The one-line explanation of the failure, built from the error text by `@piwitests/core`. */
  headline: string | null;
}

/**
 * The headline for a collected failure: the parsed error, read with the
 * recorded steps — the failed step's title for a test-timeout line, the hook or
 * fixture a failure outside the test body happened in. Null when there is no
 * error text.
 */
export function failureHeadline(
  error: string | null | undefined,
  steps?: readonly HeadlineStepLike[] | null,
): string | null {
  return describeFailureText(error, stepHeadlineContext(steps, error))?.headline ?? null;
}

/** A failed test paired with the dashboard link that resolves to its execution. */
export interface FailureLink extends FailedTest {
  url: string;
}

/**
 * Deterministic dashboard URL for one execution, built from what the reporter
 * knows before the server assigns execution ids: the run id plus the test's
 * file, title, retry, project and, past the first, its `--repeat-each`
 * repetition. The dashboard's `/test-runs/:id/locate` route resolves it to
 * `/test-run-cases/:id`.
 */
export function caseLocateUrl(serverUrl: string, runId: number | string, test: FailedTest): string {
  const params = [
    `file=${encodeURIComponent(test.file)}`,
    `title=${encodeURIComponent(test.title)}`,
    `retry=${test.retry}`,
  ];
  if (test.browser) params.push(`browser=${encodeURIComponent(test.browser)}`);
  if (test.repeatEachIndex) params.push(`repeat=${test.repeatEachIndex}`);
  return `${serverUrl.replace(/\/+$/, '')}/test-runs/${runId}/locate?${params.join('&')}`;
}

/** The terminal line printed for one failed test: `✗ <title> — <headline> → <url>`. */
export function formatFailureLine(link: FailureLink): string {
  const headline = link.headline ? ` — ${link.headline}` : '';
  return `✗ ${link.title}${headline} → ${link.url}`;
}

/**
 * Collects the failed tests of a run and prints one link line per failure as
 * soon as a run id is known: right after the test while streaming, after the
 * submit in batch mode. Lines are never printed twice.
 */
export class FailureLinks {
  private readonly failures: FailedTest[] = [];
  private printed = 0;

  constructor(
    private readonly serverUrl: string,
    private readonly logger: Logger,
  ) {}

  /** Number of failed tests recorded so far. */
  get count(): number {
    return this.failures.length;
  }

  add(test: FailedTest): void {
    this.failures.push(test);
  }

  /** Every recorded failure with its link under `runId`. */
  resolve(runId: number | string): FailureLink[] {
    return this.failures.map((test) => ({ ...test, url: caseLocateUrl(this.serverUrl, runId, test) }));
  }

  /** Print the lines that have not been printed yet. */
  printPending(runId: number | string): void {
    const links = this.resolve(runId);
    for (const link of links.slice(this.printed)) this.logger.info(formatFailureLine(link));
    this.printed = links.length;
  }
}
