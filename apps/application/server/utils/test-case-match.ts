import { and, eq } from 'drizzle-orm';
import { testCases, testRunsCases } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { splitSuitePath } from '#shared/utils/suites';
import { updateRunMetadata } from './run-metadata';
import {
  mergeExternalIdDuplicates,
  normalizeExternalId,
  parseExternalId,
  type ExternalIdDuplicate,
  type ExternalIdDuplicateTest,
} from '@piwitests/core/test-meta';

/**
 * Matching a reported test to its test case. A test is matched on its external ID first (`piwi:id`, or read from its
 * title by the reporter), then on its natural key: file path, describe path and title. A test whose external ID is
 * known under another natural key was renamed or moved, and its test case follows it, so the history stays.
 *
 * No database or runtime dependency beyond Drizzle, so the demo's ingest uses it too.
 */

/** The natural key of a test: file path, describe path (`\x1f`-joined) and title, NUL-separated. */
export function naturalKey(filePath: string, suitePath: string, title: string): string {
  return `${filePath}\x00${suitePath}\x00${title}`;
}

function splitNaturalKey(key: string): ExternalIdDuplicateTest {
  const [filePath = '', suitePath = '', title = ''] = key.split('\x00');
  const parts = splitSuitePath(suitePath);
  return parts.length ? { filePath, suitePath: parts, title } : { filePath, title };
}

interface ExternalIdEntry {
  id: number;
  /** The natural key the test case has now. */
  key: string;
  /** The last run that matched a test on this ID, while this index has been in memory. */
  runId?: number;
}

/** A project's test cases, by natural key and by external ID. */
export interface TestCaseIndex {
  byKey: Map<string, number>;
  byExternalId: Map<string, ExternalIdEntry>;
  /** The external ID each test case holds, for the ones that hold one. */
  externalIdOf: Map<number, string>;
}

/** The rows `loadTestCaseIndex` reads. */
export interface TestCaseIndexRow {
  id: number;
  filePath: string;
  suitePath: string | null;
  title: string;
  externalId?: string | null;
}

/**
 * Build the index of a project's test cases. When two rows share a natural key (rows created before inserts were
 * serialized, or a test case left behind when a renamed test took its name), the one holding an external ID wins,
 * then the newest.
 */
export function buildTestCaseIndex(rows: TestCaseIndexRow[]): TestCaseIndex {
  const index: TestCaseIndex = { byKey: new Map(), byExternalId: new Map(), externalIdOf: new Map() };
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    const key = naturalKey(row.filePath, row.suitePath ?? '', row.title);
    const current = index.byKey.get(key);
    if (current === undefined || row.externalId || !index.externalIdOf.has(current)) index.byKey.set(key, row.id);
    if (row.externalId) {
      index.byExternalId.set(row.externalId, { id: row.id, key });
      index.externalIdOf.set(row.id, row.externalId);
    }
  }
  return index;
}

/** Read a project's test cases into a {@link TestCaseIndex}. */
export async function loadTestCaseIndex(db: DrizzleDB, projectId: number): Promise<TestCaseIndex> {
  const rows = await db
    .select({
      id: testCases.id,
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
      title: testCases.title,
      externalId: testCases.externalId,
    })
    .from(testCases)
    .where(eq(testCases.projectId, projectId));
  return buildTestCaseIndex(rows);
}

/**
 * The external ID of a reported test. The reporter's `externalId` field is final, `null` included (none, or set
 * aside as a duplicate); without the field (an older reporter, a payload built by hand) the `piwi:id` annotation is
 * read instead.
 */
export function externalIdOf(input: { externalId?: unknown; testAnnotations?: unknown }): string | undefined {
  return input.externalId !== undefined
    ? normalizeExternalId(input.externalId)
    : parseExternalId(input.testAnnotations);
}

/** The longest display title kept. */
const MAX_DISPLAY_TITLE_CHARS = 1000;

/** The display title of a reported test: only with an external ID, and only when it differs from the title. */
export function displayTitleOf(input: { displayTitle?: unknown; title: string }, externalId: string | undefined) {
  if (!externalId || typeof input.displayTitle !== 'string') return null;
  const value = input.displayTitle.trim().slice(0, MAX_DISPLAY_TITLE_CHARS);
  return value && value !== input.title ? value : null;
}

/** A reported test to match to its test case. */
export interface TestCaseClaim {
  filePath: string;
  /** Describe path, `\x1f`-joined. */
  suitePath: string;
  /** The describe block the test sits in, for a new or moved test case. */
  suiteId: number | null;
  title: string;
  externalId?: string;
  displayTitle?: string | null;
  line?: number | null;
}

export interface ResolvedTestCases {
  /** The test case of each claim, by position; `undefined` when it could not be stored. */
  caseIds: Array<number | undefined>;
  /** The display title each claim's test case should show: `null` for a claim matched without an external ID. */
  displayTitles: Array<string | null>;
  /** External IDs two tests of this run declared; the later one was matched without its ID. */
  duplicates: ExternalIdDuplicate[];
}

function claimTest(claim: TestCaseClaim): ExternalIdDuplicateTest {
  const suitePath = splitSuitePath(claim.suitePath);
  return {
    filePath: claim.filePath,
    ...(suitePath.length ? { suitePath } : {}),
    title: claim.title,
    ...(claim.line != null ? { line: claim.line } : {}),
  };
}

async function hasExecutionInRun(db: DrizzleDB, runId: number, testCaseId: number): Promise<boolean> {
  const rows = await db
    .select({ id: testRunsCases.id })
    .from(testRunsCases)
    .where(and(eq(testRunsCases.testRunId, runId), eq(testRunsCases.testCaseId, testCaseId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Match each claim to its test case, creating, renaming or moving test cases as needed, and keep `index` in step
 * with what was written. The caller serializes calls for one project: two calls at once could both create the same
 * test case.
 *
 * For a claim with an external ID:
 * 1. the ID is known: its test case, renamed or moved to the claim's natural key when that differs, unless the test
 *    case already ran under another natural key in this run, which makes the claim a duplicate matched as in 4;
 * 2. the ID is unknown and the natural key known: that test case, which takes the ID (its first run with an ID, or
 *    an ID changed in the test management tool);
 * 3. neither is known: a new test case holding the ID.
 * 4. Without an external ID: the test case of the natural key, or a new one.
 *
 * An ID is never taken off a test case: one that stops declaring it keeps it, and a test declaring it later takes the
 * test case over.
 */
export async function resolveTestCases(
  db: DrizzleDB,
  projectId: number,
  runId: number,
  index: TestCaseIndex,
  claims: TestCaseClaim[],
): Promise<ResolvedTestCases> {
  const caseIds: Array<number | undefined> = [];
  const displayTitles: Array<string | null> = [];
  const duplicates: ExternalIdDuplicate[] = [];

  for (const claim of claims) {
    const key = naturalKey(claim.filePath, claim.suitePath, claim.title);
    let externalId = claim.externalId;
    let displayTitle = externalId ? (claim.displayTitle ?? null) : null;

    const entry = externalId ? index.byExternalId.get(externalId) : undefined;
    if (externalId && entry) {
      if (entry.key === key) {
        entry.runId = runId;
        caseIds.push(entry.id);
        displayTitles.push(displayTitle);
        continue;
      }
      if (entry.runId === runId || (await hasExecutionInRun(db, runId, entry.id))) {
        duplicates.push({ externalId, tests: [splitNaturalKey(entry.key), claimTest(claim)] });
        externalId = undefined;
        displayTitle = null;
      } else {
        await db
          .update(testCases)
          .set({
            filePath: claim.filePath,
            suitePath: claim.suitePath,
            suiteId: claim.suiteId,
            title: claim.title,
            displayTitle,
            updatedAt: new Date(),
          })
          .where(eq(testCases.id, entry.id));
        if (index.byKey.get(entry.key) === entry.id) index.byKey.delete(entry.key);
        index.byKey.set(key, entry.id);
        entry.key = key;
        entry.runId = runId;
        caseIds.push(entry.id);
        displayTitles.push(displayTitle);
        continue;
      }
    }

    const known = index.byKey.get(key);
    if (known !== undefined) {
      if (externalId) {
        if (await takeExternalId(db, index, known, key, externalId, displayTitle))
          index.byExternalId.get(externalId)!.runId = runId;
        else displayTitle = null;
      }
      caseIds.push(known);
      displayTitles.push(displayTitle);
      continue;
    }

    const id = await insertTestCase(db, projectId, index, claim, key, externalId, displayTitle);
    if (id !== undefined && externalId) {
      const inserted = index.byExternalId.get(externalId);
      if (inserted) inserted.runId = runId;
    }
    caseIds.push(id);
    displayTitles.push(displayTitle);
  }

  return { caseIds, displayTitles, duplicates: mergeExternalIdDuplicates(duplicates) };
}

/** Give an existing test case an external ID, dropping the one it held. False when the write was refused. */
async function takeExternalId(
  db: DrizzleDB,
  index: TestCaseIndex,
  id: number,
  key: string,
  externalId: string,
  displayTitle: string | null,
): Promise<boolean> {
  try {
    await db.update(testCases).set({ externalId, displayTitle, updatedAt: new Date() }).where(eq(testCases.id, id));
  } catch {
    // Another server process gave the ID to another test case first: this one stays matched by natural key.
    return false;
  }
  const previous = index.externalIdOf.get(id);
  if (previous !== undefined) index.byExternalId.delete(previous);
  index.byExternalId.set(externalId, { id, key });
  index.externalIdOf.set(id, externalId);
  return true;
}

async function insertTestCase(
  db: DrizzleDB,
  projectId: number,
  index: TestCaseIndex,
  claim: TestCaseClaim,
  key: string,
  externalId: string | undefined,
  displayTitle: string | null,
): Promise<number | undefined> {
  const [row] = await db
    .insert(testCases)
    .values({
      projectId,
      filePath: claim.filePath,
      suitePath: claim.suitePath,
      suiteId: claim.suiteId,
      title: claim.title,
      externalId: externalId ?? null,
      displayTitle,
    })
    .onConflictDoNothing()
    .returning({ id: testCases.id });

  if (row) {
    index.byKey.set(key, row.id);
    if (externalId) {
      index.byExternalId.set(externalId, { id: row.id, key });
      index.externalIdOf.set(row.id, externalId);
    }
    return row.id;
  }

  // Only the external ID index can refuse the row: another server process stored the ID first. Use its test case.
  if (!externalId) return undefined;
  const [existing] = await db
    .select({ id: testCases.id })
    .from(testCases)
    .where(and(eq(testCases.projectId, projectId), eq(testCases.externalId, externalId)));
  return existing?.id;
}

/**
 * Add duplicate external IDs to the run's `metadata.externalIdDuplicates`, merged with the ones already there (the
 * reporter's, other batches'), so the run page can list them.
 */
export async function recordExternalIdDuplicates(
  db: DrizzleDB,
  runId: number,
  duplicates: ExternalIdDuplicate[],
): Promise<void> {
  if (duplicates.length === 0) return;
  await updateRunMetadata(db, runId, (metadata) => ({
    ...metadata,
    externalIdDuplicates: mergeExternalIdDuplicates(metadata.externalIdDuplicates, duplicates),
  }));
}
