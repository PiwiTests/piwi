/**
 * The run events a streamed test's `begin` and `complete` publish to the run page, built once for the server's events
 * route and the demo's ingest.
 */
import {
  normalizeTestLocks,
  normalizeTestTags,
  parseTestMetadata,
  sanitizeTestMetadata,
} from '@piwitests/core/test-meta';
import { DEFAULT_INGEST_LIMITS } from '#shared/ingest-limits';
import { parseLocation } from '#shared/parse-location';
import type { StreamEventPayload } from '#shared/types';
import { resolveRepeatEachIndex } from './inserted-run-cases';
import { hiddenErrorText, hiddenStepEventErrors } from './sanitize';
import { displayTitleOf, externalIdOf } from './test-case-match';

/** A count the reporter sent, or null for none or one of the wrong shape. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The `test-begin` run event a streamed `begin` publishes, which the stream's catch-up replays while the test runs:
 * where the test is, who runs it, which attempt begins (`retries`, null from a reporter that does not say) of how many
 * allowed, and what the run page's search reads (tags, locks, metadata). Pure, so the server's events route and the
 * demo's ingest share it; `now` stands in for a start the reporter did not send.
 */
export function testBeginData(
  tc: StreamEventPayload,
  now: number,
  maxLocks: number = DEFAULT_INGEST_LIMITS.locks,
): Record<string, unknown> {
  return {
    title: tc.title,
    filePath: tc.location ? parseLocation(tc.location).filePath : 'unknown',
    suitePath: tc.suitePath ?? null,
    location: tc.location,
    workerIndex: tc.workerIndex ?? null,
    shardIndex: tc.shardIndex ?? null,
    startedAt: typeof tc.startedAt === 'number' ? tc.startedAt : now,
    browser: tc.browser ?? null,
    repeatEachIndex: resolveRepeatEachIndex(tc.repeatEachIndex),
    retries: count(tc.retries),
    maxRetries: count(tc.maxRetries),
    ...searchFields(tc, maxLocks),
  };
}

/**
 * What the run page's search reads of a test, as its run case stores it: its tags, its locks up to `maxLocks`, and its
 * `piwi:` metadata, read from its annotations when it sent them.
 */
function searchFields(tc: StreamEventPayload, maxLocks: number) {
  const tags = normalizeTestTags(tc.tags);
  const locks = normalizeTestLocks(tc.locks).slice(0, maxLocks);
  return {
    tags: tags.length ? tags : null,
    locks: locks.length ? locks : null,
    testMeta: parseTestMetadata(tc.testAnnotations) ?? sanitizeTestMetadata(tc.testMeta),
  };
}

/** The stored row of a completed attempt: its ids, its attempt history and its verdict. */
interface PersistedAttempt {
  id: number;
  testCaseId: number;
  attempts: unknown;
  passedAfterFailure: boolean | null;
}

/**
 * The `test-completed` run event of a streamed `complete`: the attempt as stored (`input`, and its row once
 * `persisted`, whose ids let the run page link it), its error hidden as stored, and what the run page's search reads.
 */
export function testCompletedData(
  tc: StreamEventPayload,
  input: { title: string; filePath: string; externalId?: unknown; displayTitle?: unknown; testAnnotations?: unknown },
  persisted: PersistedAttempt | undefined,
  maxLocks: number = DEFAULT_INGEST_LIMITS.locks,
): Record<string, unknown> {
  return {
    title: tc.title,
    externalId: externalIdOf(input) ?? null,
    displayTitle: displayTitleOf(input, externalIdOf(input)),
    filePath: input.filePath,
    suitePath: tc.suitePath ?? null,
    status: tc.status,
    duration: tc.duration,
    location: tc.location,
    error: hiddenErrorText(tc.error),
    stepEvents: hiddenStepEventErrors(tc.stepEvents),
    wastedTimeMs: tc.wastedTimeMs ?? null,
    workerIndex: tc.workerIndex ?? null,
    shardIndex: tc.shardIndex ?? null,
    startedAt: tc.startedAt ?? null,
    browser: tc.browser ?? null,
    // The attempt number and the attempt history up to it, as stored, ride along so the live page can tell a flaky
    // pass (an earlier attempt failed) from another pass.
    retries: tc.retries ?? null,
    attempts: persisted ? persisted.attempts : (tc.attempts ?? null),
    repeatEachIndex: resolveRepeatEachIndex(tc.repeatEachIndex),
    executionId: persisted?.id ?? null,
    testCaseId: persisted?.testCaseId ?? null,
    // Its verdict as stored: it passed after an earlier attempt failed or timed out.
    passedAfterFailure: persisted?.passedAfterFailure ?? null,
    ...searchFields(tc, maxLocks),
  };
}
