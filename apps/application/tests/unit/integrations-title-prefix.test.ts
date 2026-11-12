import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';
import {
  TICKET_TITLE_MAX_LENGTH,
  TITLE_PREFIX_MAX_LENGTH,
  cutLine,
  normalizeTitlePrefix,
  prefixedTitle,
  resolveTitlePrefix,
} from '../../shared/integrations/title-prefix';
import { buildIssue, buildBugIssue, type IssueFacts, type BugIssueFacts } from '../../shared/integrations/build-issue';
import { buildRunIssueDocument, type RunIssueFacts } from '../../shared/integrations/run-issue';
import { renderMarkdown } from '../../shared/integrations/render-markdown';
import { resolveProjectIntegration } from '../../shared/integrations/binding';
import { couponBugReport } from '../utils/bug-report-sample';
import { clusterKnownIssues } from '../../shared/handlers/known-issues';
import { ADMIN_ACCESS } from '../../shared/permissions';

/**
 * The title prefix and the filer's name on a ticket: the pure helpers and
 * builders, then a SQLite database and a stubbed Jira for what Piwi sends when
 * it files and when it rewrites a description.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration, readProjectIntegration, bindingTitlePrefix } =
  await import('../../server/utils/integrations/binding');
const { createIssue } = await import('../../server/utils/integrations/create');
const { buildIssueDraft } = await import('../../server/utils/integrations/draft');
const { MCP_TOOLS } = await import('../../server/utils/mcp/tools');
const { enqueueDescriptionUpdate } = await import('../../server/utils/integrations/policies');

describe('normalizeTitlePrefix', () => {
  test('keeps one trimmed line of at most the allowed length, and nothing else', () => {
    expect(normalizeTitlePrefix('  [Piwi]  ')).toBe('[Piwi]');
    expect(normalizeTitlePrefix('QA\n  team:')).toBe('QA team:');
    expect(normalizeTitlePrefix('x'.repeat(TITLE_PREFIX_MAX_LENGTH + 10))).toHaveLength(TITLE_PREFIX_MAX_LENGTH);
    expect(normalizeTitlePrefix('   ')).toBeNull();
    expect(normalizeTitlePrefix(null)).toBeNull();
    expect(normalizeTitlePrefix(42)).toBeNull();
  });
});

describe('resolveTitlePrefix', () => {
  test('the binding wins, else the connection default, else none', () => {
    expect(resolveTitlePrefix('[Piwi]', { titlePrefix: 'QA:' })).toBe('[Piwi]');
    expect(resolveTitlePrefix(null, { titlePrefix: 'QA:' })).toBe('QA:');
    expect(resolveTitlePrefix('  ', { titlePrefix: ' QA: ' })).toBe('QA:');
    expect(resolveTitlePrefix(null, { titlePrefix: 3 })).toBeNull();
    expect(resolveTitlePrefix(undefined, null)).toBeNull();
  });
});

describe('prefixedTitle', () => {
  test('puts the prefix first, and leaves a title alone when there is none', () => {
    expect(prefixedTitle('[Piwi]', 'Checkout fails')).toBe('[Piwi] Checkout fails');
    expect(prefixedTitle(null, 'Checkout fails')).toBe('Checkout fails');
    expect(prefixedTitle('   ', 'Checkout fails')).toBe('Checkout fails');
  });

  test('a title that already starts with the prefix is not prefixed twice', () => {
    expect(prefixedTitle('[Piwi]', '[Piwi] Checkout fails')).toBe('[Piwi] Checkout fails');
    expect(prefixedTitle('[Piwi]', prefixedTitle('[Piwi]', 'Checkout fails'))).toBe('[Piwi] Checkout fails');
  });

  test('the prefix counts toward the tracker limit: the title is cut, never the prefix', () => {
    const exact = 'a'.repeat(TICKET_TITLE_MAX_LENGTH - '[Piwi] '.length);
    expect(prefixedTitle('[Piwi]', exact)).toHaveLength(TICKET_TITLE_MAX_LENGTH);
    expect(prefixedTitle('[Piwi]', exact)).toBe(`[Piwi] ${exact}`);

    const over = prefixedTitle('[Piwi]', `${exact}b`);
    expect(over).toHaveLength(TICKET_TITLE_MAX_LENGTH);
    expect(over.startsWith('[Piwi] a')).toBe(true);
    expect(over.endsWith('…')).toBe(true);
  });

  test('a title that only begins with the same letters is still prefixed', () => {
    expect(prefixedTitle('QA', 'QAuth fails')).toBe('QA QAuth fails');
    expect(prefixedTitle('QA', 'QA fails')).toBe('QA fails');
    expect(prefixedTitle('QA', 'QA')).toBe('QA');
  });

  test('reads a title as one line before it looks for the prefix, in any letter case', () => {
    expect(prefixedTitle('[Piwi]', '  [Piwi] Login')).toBe('[Piwi] Login');
    expect(prefixedTitle('[Piwi]', '[Piwi]\nLogin')).toBe('[Piwi] Login');
    expect(prefixedTitle('[Piwi]', '[piwi] Login')).toBe('[piwi] Login');
    expect(prefixedTitle('[Piwi]', '\n [PIWI]  ')).toBe('[PIWI]');
    expect(prefixedTitle('QA', 'qauth fails')).toBe('QA qauth fails');
  });

  test('never cuts between the halves of an emoji', () => {
    const emoji = '😀';
    const title = `${'a'.repeat(TICKET_TITLE_MAX_LENGTH - 9)}${emoji}${emoji}${'b'.repeat(20)}`;
    const cut = prefixedTitle('[Piwi]', title);
    expect(cut.length).toBeLessThanOrEqual(TICKET_TITLE_MAX_LENGTH);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/[\ud800-\udbff]…$/);
    expect(cut).not.toMatch(/(^|[^\ud800-\udbff])[\udc00-\udfff]/);
  });

  test('collapses the whitespace of the title it prefixes', () => {
    expect(prefixedTitle('QA:', 'Checkout\n  fails')).toBe('QA: Checkout fails');
  });
});

describe('cutLine', () => {
  test('keeps a short line and ends a long one in an ellipsis within the limit', () => {
    expect(cutLine('short', 10)).toBe('short');
    expect(cutLine('abcdefghijkl', 6)).toBe('abcde…');
  });

  test('does not split a surrogate pair at the cut', () => {
    expect(cutLine('abc😀def', 5)).toBe('abc…');
    expect(cutLine('abc😀def', 6)).toBe('abc😀…');
  });
});

describe('a prefix of emoji', () => {
  test('is cut to the limit without half an emoji', () => {
    const prefix = normalizeTitlePrefix(`${'a'.repeat(TITLE_PREFIX_MAX_LENGTH - 1)}😀`)!;
    expect(prefix).toBe('a'.repeat(TITLE_PREFIX_MAX_LENGTH - 1));
  });
});

describe('the binding', () => {
  test('resolves a prefix as one trimmed line, and defaults to none', () => {
    expect(resolveProjectIntegration({}).titlePrefix).toBeNull();
    expect(resolveProjectIntegration({ titlePrefix: '  [Piwi] ' }).titlePrefix).toBe('[Piwi]');
    expect(resolveProjectIntegration({ titlePrefix: '' }).titlePrefix).toBeNull();
  });
});

function clusterFacts(overrides: Partial<IssueFacts> = {}): IssueFacts {
  return {
    clusterId: 42,
    fingerprint: 'abcdef1234567890',
    title: 'Timeout on checkout',
    headline: 'page.click timed out',
    errorType: 'timeout',
    firstSeen: '1 Jan 2026, 00:00 UTC',
    lastSeen: '2 Jan 2026, 00:00 UTC',
    occurrences: 5,
    affectedTests: [{ title: 'checks out', filePath: 'checkout.spec.ts', owner: null }],
    branch: 'main',
    environment: null,
    commit: null,
    diagnosisSummary: null,
    rootCause: null,
    clue: null,
    errorExcerpt: null,
    failingLocator: null,
    patch: null,
    locatorEdits: [],
    verifyCommand: null,
    reproduceScript: null,
    clusterUrl: null,
    executionUrl: null,
    runUrl: null,
    shareUrl: null,
    ...overrides,
  };
}

/** How many times `text` occurs in `haystack`. */
const occurrences = (haystack: string, text: string) => haystack.split(text).length - 1;

describe('the line that names the filer, on a cluster issue', () => {
  test('names the person once, with or without a comment', () => {
    const plain = renderMarkdown(buildIssue(clusterFacts(), { filedBy: 'Dana Lee' }).document);
    expect(occurrences(plain, 'Dana Lee')).toBe(1);
    expect(plain).toContain('Filed by Dana Lee from Piwi.');

    const withComment = renderMarkdown(
      buildIssue(clusterFacts(), { filedBy: 'Dana Lee', comment: { text: 'Blocks checkout.', author: 'Dana Lee' } })
        .document,
    );
    expect(occurrences(withComment, 'Dana Lee')).toBe(1);
    expect(withComment).toContain('## Comment\n');
    expect(withComment).toContain('Blocks checkout.');
    expect(withComment.indexOf('## Comment')).toBeLessThan(withComment.indexOf('## What happened'));
  });

  test('says "from Piwi" alone when nobody is known, and nothing extra for a rule', () => {
    expect(renderMarkdown(buildIssue(clusterFacts()).document)).toContain('Filed from Piwi.');
    const automatic = renderMarkdown(
      buildIssue(
        clusterFacts({
          automatic: {
            ruleIndex: 0,
            occurrences: 3,
            runs: 2,
            days: 1,
            firstFailureAt: null,
            branches: ['main'],
            environments: [],
          },
        }),
        {
          filedBy: 'Dana Lee',
        },
      ).document,
    );
    expect(automatic).not.toContain('Dana Lee');
    expect(automatic).not.toContain('Filed from Piwi.');
  });

  test('speaks the ticket language', () => {
    const fr = renderMarkdown(buildIssue(clusterFacts(), { filedBy: 'Dana Lee', locale: 'fr' }).document);
    expect(fr).toContain('Créé par Dana Lee depuis Piwi.');
  });

  test('puts the prefix on the title it builds, and only there', () => {
    const built = buildIssue(clusterFacts(), { titlePrefix: '[Piwi]' });
    expect(built.title).toBe('[Piwi] Timeout on checkout');
    expect(renderMarkdown(built.document)).not.toContain('[Piwi]');
    expect(buildIssue(clusterFacts()).title).toBe('Timeout on checkout');
  });
});

describe('the other issue builders', () => {
  const report = couponBugReport('Pay button does nothing');
  const bug: BugIssueFacts = {
    id: 9,
    title: 'Pay button does nothing',
    steps: report.steps,
    evidence: report.evidence,
    context: report.context,
    reportLanguage: null,
    reportedBy: null,
    reportedAt: null,
    spec: null,
    reproductions: [],
    reportUrl: null,
  };

  test('a bug report is prefixed and names its filer once', () => {
    const built = buildBugIssue(bug, {
      titlePrefix: 'QA:',
      filedBy: 'Dana Lee',
      comment: { text: 'Seen twice.', author: 'Dana Lee' },
    });
    expect(built.title).toBe('QA: Pay button does nothing');
    const md = renderMarkdown(built.document);
    expect(occurrences(md, 'Dana Lee')).toBe(1);
    expect(md).toContain('## Comment\n');
  });

  test('a run issue names its filer once, whether or not it has a comment', () => {
    const facts: RunIssueFacts = {
      runId: 7,
      projectName: 'shop',
      branch: 'main',
      commit: null,
      environment: null,
      startedAt: null,
      counts: { total: 3, passed: 2, failed: 1, flaky: 0, skipped: 0 },
      tests: [],
      moreTests: 0,
      clusters: [],
      runUrl: null,
      filedBy: 'Dana Lee',
    };
    const withComment = renderMarkdown(
      buildRunIssueDocument(facts, { comment: { text: 'Slow.', author: 'Dana Lee' }, filedBy: 'Dana Lee' }),
    );
    expect(occurrences(withComment, 'Dana Lee')).toBe(1);
    const without = renderMarkdown(buildRunIssueDocument(facts, { filedBy: 'Dana Lee' }));
    expect(occurrences(without, 'Dana Lee')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Against a database and a stubbed Jira

const SITE = 'https://prefix.atlassian.net';
let issueSeq = 0;
/** The issues the stub Jira holds, by key. */
const issues = new Map<string, { summary: string; description: unknown }>();
/** Every body Piwi sent to create or update an issue, in order. */
let sent: Array<{ method: string; body: string }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function jira(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (/\/rest\/api\/3\/issue\/createmeta\//.test(url.pathname)) return json({ total: 0, fields: [] });
  if (url.pathname === '/rest/api/3/search/jql') return json({ issues: [] });
  if (url.pathname === '/rest/api/3/issue' && init?.method === 'POST') {
    issueSeq += 1;
    const body = String(init.body);
    sent.push({ method: 'POST', body });
    const { fields } = JSON.parse(body);
    issues.set(`PROJ-${issueSeq}`, { summary: fields.summary, description: fields.description });
    return json({ id: String(10000 + issueSeq), key: `PROJ-${issueSeq}` }, 201);
  }
  const read = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(url.pathname);
  const issue = read ? issues.get(read[1]!) : undefined;
  if (read && issue && init?.method === 'PUT') {
    const body = String(init.body);
    sent.push({ method: 'PUT', body });
    const { fields } = JSON.parse(body);
    if (fields.summary) issue.summary = fields.summary;
    if (fields.description) issue.description = fields.description;
    return new Response(null, { status: 204 });
  }
  if (read && issue) {
    return json({
      id: read[1]!.replace('PROJ-', '1000'),
      key: read[1],
      fields: {
        summary: issue.summary,
        description: issue.description,
        status: { name: 'To Do', statusCategory: { key: 'new' } },
      },
    });
  }
  return json({ errorMessages: ['Not found'] }, 404);
}

/** The summary the first create sent to Jira after `from` sends. */
const createdSummary = (from: number): string =>
  JSON.parse(sent.slice(from).find((s) => s.method === 'POST')!.body).fields.summary;

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let client: ReturnType<typeof createClient>;
let tmpDir: string;
let connectionId = 0;
const AUTOMATIC = {
  ruleIndex: 0,
  occurrences: 3,
  runs: 2,
  days: 1,
  firstFailureAt: null,
  branches: ['main'],
  environments: [],
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-title-prefix-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;

  await db.insert(schema.users).values({ id: 7, username: 'robin', password: '', role: 'member', name: 'Robin Shaw' });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    await db.insert(schema.testCases).values({ id, projectId: 1, title: `test ${id}`, filePath: 'tests/a.spec.ts' });
    await db.insert(schema.failureClusters).values({
      id,
      projectId: 1,
      fingerprint: `fp-${id}`,
      title: `Checkout fails ${id}`,
      signature: `Error: broken ${id}`,
      errorType: 'unknown',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
    });
    await db.insert(schema.testRunsCases).values({
      id: 100 + id,
      testRunId: 1,
      testCaseId: id,
      status: 'failed',
      error: `Error: broken ${id}`,
      failureClusterId: id,
    });
  }
  vi.stubGlobal('fetch', vi.fn(jira));
  const connection = await createConnection(dbc, {
    provider: 'jira',
    name: 'Prefix Jira',
    baseUrl: SITE,
    credentials: { email: 'ci@example.com', apiToken: 'token' },
    config: { titlePrefix: 'QA:' },
  });
  connectionId = connection.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const bind = (titlePrefix: string | null) =>
  writeProjectIntegration(dbc, 1, {
    connectionId,
    projectKey: 'PROJ',
    issueType: 'Bug',
    titlePrefix,
    policies: { updateDescription: true } as never,
  });

const file = (clusterId: number, extra: Record<string, unknown> = {}) =>
  createIssue(dbc, {
    entityType: 'failure_cluster',
    entityId: clusterId,
    connectionId,
    projectKey: 'PROJ',
    issueType: 'Bug',
    requestedBy: 7,
    ...extra,
  });

describe('the stored binding', () => {
  test('keeps its own prefix, and falls back to the connection default when it has none', async () => {
    await bind('  [Piwi] ');
    const own = await readProjectIntegration(dbc, 1);
    expect(own.titlePrefix).toBe('[Piwi]');

    await bind(null);
    const inherited = await readProjectIntegration(dbc, 1);
    expect(inherited.titlePrefix).toBeNull();
    const [row] = await db
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, connectionId));
    expect(bindingTitlePrefix(inherited, row!.config)).toBe('QA:');
  });
});

describe('filing with a prefix', () => {
  test('the draft shows the prefixed title and the filer, and the ticket sent carries both', async () => {
    await bind('[Piwi]');
    const draft = await buildIssueDraft(dbc, 'failure_cluster', 1, { filedBy: 'Robin Shaw' });
    expect(draft?.title).toBe('[Piwi] Checkout fails 1');
    expect(occurrences(draft!.markdown, 'Robin Shaw')).toBe(1);

    const from = sent.length;
    const filed = await file(1, { filedBy: 'Robin Shaw' });
    expect(filed?.status).toBe('done');
    expect(createdSummary(from)).toBe('[Piwi] Checkout fails 1');
    const body = sent[from]!.body;
    expect(occurrences(body, 'Robin Shaw')).toBe(1);

    const [link] = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, 1));
    expect(link).toMatchObject({ origin: 'created', createdBy: 7 });
    expect(link?.metadata).toMatchObject({ filedBy: 'Robin Shaw' });
  });

  test('a title the person typed is filed as typed', async () => {
    await bind('[Piwi]');
    const from = sent.length;
    await file(2, { title: 'Checkout is down', filedBy: 'Robin Shaw' });
    expect(createdSummary(from)).toBe('Checkout is down');
  });

  test('a title an agent gives through MCP gets the prefix, once', async () => {
    await bind('[Piwi]');
    const createIssueTool = MCP_TOOLS.find((t) => t.name === 'create_issue')!.handler;
    const asAgent = { user: null, access: ADMIN_ACCESS, scope: 'all' as const };

    const from = sent.length;
    await createIssueTool(
      dbc as never,
      { entityType: 'failure_cluster', entityId: 10, title: 'Checkout is down' },
      asAgent,
    );
    expect(createdSummary(from)).toBe('[Piwi] Checkout is down');

    const next = sent.length;
    await createIssueTool(
      dbc as never,
      { entityType: 'failure_cluster', entityId: 11, title: '[piwi] Checkout is down' },
      asAgent,
    );
    expect(createdSummary(next)).toBe('[piwi] Checkout is down');

    const last = sent.length;
    await createIssueTool(dbc as never, { entityType: 'failure_cluster', entityId: 12 }, asAgent);
    expect(createdSummary(last)).toBe('[Piwi] Checkout fails 12');
  });

  test('a rule files with the prefix and names no person', async () => {
    await bind('[Piwi]');
    const from = sent.length;
    const filed = await file(3, { automatic: AUTOMATIC, requestedBy: null });
    expect(filed?.status).toBe('done');
    expect(createdSummary(from)).toBe('[Piwi] Checkout fails 3');
  });

  test('the connection default applies when the binding has none', async () => {
    await bind(null);
    const from = sent.length;
    await file(4, { filedBy: 'Robin Shaw' });
    expect(createdSummary(from)).toBe('QA: Checkout fails 4');
  });

  test('a known issue names who filed it, and that a rule filed it', async () => {
    const known = await clusterKnownIssues(dbc as never, [1, 3]);
    expect(known.get(1)).toMatchObject({ origin: 'created', filedBy: 'Robin Shaw', automatic: false });
    expect(known.get(1)?.linkedAt).toBeTruthy();
    expect(known.get(3)).toMatchObject({ origin: 'created', filedBy: null, automatic: true });
  });
});

describe('a description update of an issue a rule filed', () => {
  /** A cluster's issue filed by a rule, then a new occurrence of it, so its description reads differently. */
  async function fileThenRecur(clusterId: number, occurrencesNow: number): Promise<string> {
    expect((await file(clusterId, { automatic: AUTOMATIC, requestedBy: null }))?.status).toBe('done');
    await db
      .update(schema.failureClusters)
      .set({ occurrences: occurrencesNow })
      .where(eq(schema.failureClusters.id, clusterId));
    return `PROJ-${issueSeq}`;
  }

  /** The bodies Piwi sent to update an issue after `from` sends. */
  const updates = (from: number) =>
    sent
      .slice(from)
      .filter((s) => s.method === 'PUT')
      .map((s) => JSON.parse(s.body).fields);

  test('a summary edited in Jira does not get the prefix back', async () => {
    await bind('[Piwi]');
    const key = await fileThenRecur(5, 9);
    issues.get(key)!.summary = 'Renamed by hand';
    const from = sent.length;

    await enqueueDescriptionUpdate(dbc, { clusterId: 5, projectId: 1, reason: 'day:2026-11-03' });

    const [update] = updates(from);
    expect(update?.description).toBeTruthy();
    expect(update?.summary).toBeUndefined();
    expect(issues.get(key)!.summary).toBe('Renamed by hand');
  });

  test('a prefix changed on the binding rewrites an untouched summary once', async () => {
    await bind('[Piwi]');
    const key = await fileThenRecur(6, 9);
    expect(issues.get(key)!.summary).toBe('[Piwi] Checkout fails 6');

    await bind('[QA]');
    const from = sent.length;
    await enqueueDescriptionUpdate(dbc, { clusterId: 6, projectId: 1, reason: 'day:2026-11-04' });
    expect(updates(from).map((f) => f.summary)).toEqual(['[QA] Checkout fails 6']);
    expect(issues.get(key)!.summary).toBe('[QA] Checkout fails 6');

    // The same title is not sent again.
    const after = sent.length;
    await enqueueDescriptionUpdate(dbc, { clusterId: 6, projectId: 1, reason: 'day:2026-11-05' });
    expect(updates(after).filter((f) => f.summary !== undefined)).toEqual([]);
  });
});

describe('a description update of an issue filed before the filer was stored', () => {
  /** Files a cluster's issue by a person, then makes its link read as an earlier version wrote it. */
  async function fileAsBefore(clusterId: number, extra: Record<string, unknown>, keep: (meta: object) => object) {
    await bind('[Piwi]');
    expect((await file(clusterId, { filedBy: 'Robin Shaw', ...extra }))?.status).toBe('done');
    const [link] = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, clusterId));
    const { filedBy: _filedBy, ...rest } = link!.metadata as Record<string, unknown>;
    await db
      .update(schema.entityLinks)
      .set({ metadata: keep(rest) as never })
      .where(eq(schema.entityLinks.id, link!.id));
    await db.update(schema.failureClusters).set({ occurrences: 9 }).where(eq(schema.failureClusters.id, clusterId));
  }

  const updatedBody = async (clusterId: number, reason: string): Promise<string> => {
    const from = sent.length;
    await enqueueDescriptionUpdate(dbc, { clusterId, projectId: 1, reason });
    const put = sent.slice(from).find((s) => s.method === 'PUT');
    expect(put).toBeTruthy();
    return put!.body;
  };

  test('keeps the name of the author of the comment', async () => {
    await fileAsBefore(7, { comment: 'It broke after the deploy' }, (meta) => meta);
    const [link] = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, 7));
    expect(link?.metadata).toMatchObject({ comment: { author: 'Robin Shaw' } });
    expect(link?.metadata).not.toHaveProperty('filedBy');

    const body = await updatedBody(7, 'day:2026-11-06');
    expect(occurrences(body, 'Filed by Robin Shaw from Piwi.')).toBe(1);
    expect(body).not.toContain('Filed from Piwi.');
    expect(body).toContain('It broke after the deploy');
  });

  test('names the user the link was created by when there is no comment', async () => {
    await fileAsBefore(8, {}, (meta) => meta);
    const body = await updatedBody(8, 'day:2026-11-06');
    expect(occurrences(body, 'Filed by Robin Shaw from Piwi.')).toBe(1);
  });

  test('names nobody when the filer cannot be found', async () => {
    await fileAsBefore(9, {}, (meta) => meta);
    await db.update(schema.entityLinks).set({ createdBy: null }).where(eq(schema.entityLinks.failureClusterId, 9));
    const body = await updatedBody(9, 'day:2026-11-06');
    expect(body).toContain('Filed from Piwi.');
    expect(body).not.toContain('Robin Shaw');
  });
});
