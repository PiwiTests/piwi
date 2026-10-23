/**
 * `propose_change`: a proposal card is shown only for an action of the
 * registry, with parameters its schema takes, on an entity a tool result of
 * the conversation named, of the kind the action changes, and only when the
 * user holds the action's permission on that entity's project (on the
 * instance for an instance-wide action) and the instance has not declined its
 * capability. A shown card carries its target's project for the route.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';
import type { User } from '../../server/database/schema';
import type { AssistantEntityRef } from '#shared/assistant';
import { ADMIN_ACCESS, InstanceRole, ProjectRole, buildAccessSummary, type AccessSummary } from '#shared/permissions';

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_DESKTOP_TOKEN;
vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, authEnabled: false, public: { appVersion: '0.59.0' } }));

const tools = await import('../../server/utils/assistant/tools');
const { setInstanceDecisions } = await import('#shared/handlers/capabilities');
type McpContext = import('../../server/utils/mcp/tools').McpContext;

const context = (access: AccessSummary, scope: McpContext['scope']): McpContext => ({
  user: { id: 2, role: access.instanceRole, name: 'Robin', username: 'robin' } as User,
  access,
  scope,
});
const maintainer = context(
  buildAccessSummary(InstanceRole.MEMBER, [
    { projectId: 1, role: ProjectRole.MAINTAINER },
    { projectId: 3, role: ProjectRole.VIEWER },
  ]),
  new Set([1, 3]),
);
const administrator = context(ADMIN_ACCESS, 'all');

/** What the conversation's tool results named. */
const READ: AssistantEntityRef[] = [
  { type: 'cluster', id: 1, label: 'Cart total is stale' },
  { type: 'cluster', id: 2, label: 'Login times out' },
  { type: 'cluster', id: 3, label: 'Docs search is empty' },
  { type: 'test-case', id: 1, label: 'cart › removes an item' },
  { type: 'run', id: 3, label: 'Run #3' },
  { type: 'project', id: 1, label: 'shop' },
];

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'admin-console' },
    { id: 3, name: 'docs' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 1, projectId: 1, status: 'failed', startTime: new Date() },
    { id: 2, projectId: 2, status: 'failed', startTime: new Date() },
    { id: 3, projectId: 3, status: 'failed', startTime: new Date() },
  ]);
  await db.insert(schema.failureClusters).values(
    [1, 2, 3].map((id) => ({
      id,
      projectId: id,
      fingerprint: `f${id}`,
      signature: `Error ${id}`,
      firstSeenRunId: id,
      lastSeenRunId: id,
    })),
  );
  await db.insert(schema.testCases).values({ id: 1, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'removes' });
});
afterEach(async () => {
  await close();
});
afterAll(() => vi.unstubAllGlobals());

async function propose(ctx: McpContext, args: Record<string, unknown>) {
  const readTools = await tools.assistantReadTools(db as never, ctx);
  const toolbox = tools.createAssistantToolbox({
    db: db as never,
    ctx,
    readTools,
    page: null,
    extraTools: [],
    entities: READ,
  });
  return toolbox.run({
    id: 'p',
    name: 'propose_change',
    arguments: { id: 'change', title: 'A change', change: 'It changes.', ...args },
  });
}

describe('propose_change', () => {
  test('shows a card on an entity the conversation read, with its project for the route', async () => {
    const shown = await propose(maintainer, {
      action: 'resolve-cluster',
      title: 'Resolve the cart cluster',
      change: 'The cluster leaves the inbox; a failure after the fix reopens it.',
      target: { type: 'cluster', id: 1 },
      params: { note: 'Fixed by the wait in #42' },
    });
    expect(shown).toEqual({
      content: 'Shown to the user.',
      isError: false,
      block: {
        kind: 'proposal',
        id: 'change',
        action: 'resolve-cluster',
        title: 'Resolve the cart cluster',
        change: 'The cluster leaves the inbox; a failure after the fix reopens it.',
        target: { type: 'cluster', id: 1, label: 'Cart total is stale' },
        projectId: 1,
        params: { note: 'Fixed by the wait in #42' },
      },
    });
    expect(shown.record).toBeUndefined();

    const quarantine = await propose(maintainer, { action: 'quarantine-test', target: { type: 'test-case', id: 1 } });
    expect(quarantine.block).toMatchObject({ target: { type: 'test-case', id: 1 }, projectId: 1, params: {} });
  });

  test('refuses an action outside the registry, and parameters its schema does not take', async () => {
    const unknown = await propose(maintainer, { action: 'delete-project', target: { type: 'project', id: 1 } });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.content).toMatch(/^Error: Not shown: action: /);

    const bad = await propose(administrator, {
      action: 'decide-capability',
      params: { capability: 'coverage', decision: 'maybe' },
    });
    expect(bad.content).toContain('params.decision: ');
    const missing = await propose(administrator, { action: 'decide-capability', params: {} });
    expect(missing.content).toContain('params.capability: ');
  });

  test('refuses an entity no tool result named, and a target of another kind than the action changes', async () => {
    const unread = await propose(maintainer, { action: 'resolve-cluster', target: { type: 'cluster', id: 9 } });
    expect(unread.content).toContain('target: no tool result of this conversation named cluster 9');
    const wrong = await propose(maintainer, { action: 'resolve-cluster', target: { type: 'run', id: 3 } });
    expect(wrong.content).toContain('target: resolve-cluster changes a cluster, not a run');
    const none = await propose(maintainer, { action: 'keep-run' });
    expect(none.content).toContain('target: keep-run needs the run it changes');
    const instance = await propose(administrator, {
      action: 'decide-capability',
      target: { type: 'project', id: 1 },
      params: { capability: 'coverage', decision: 'declined' },
    });
    expect(instance.content).toContain('target: decide-capability changes the whole instance and takes no target');
  });

  test("refuses an action whose permission the user lacks on the target's project", async () => {
    // A Viewer of project 3 reads its cluster but cannot triage it.
    const viewer = await propose(maintainer, { action: 'resolve-cluster', target: { type: 'cluster', id: 3 } });
    expect(viewer).toMatchObject({ isError: true });
    expect(viewer.content).toContain(
      'action: resolve-cluster needs the triage:write permission on project 3, which the user does not hold',
    );
    // Keeping a run needs only to read it.
    expect((await propose(maintainer, { action: 'keep-run', target: { type: 'run', id: 3 } })).block).toMatchObject({
      projectId: 3,
    });
    // A Maintainer does not manage the project's capabilities.
    const manage = await propose(maintainer, {
      action: 'decide-project-capability',
      target: { type: 'project', id: 1 },
      params: { capability: 'quarantine', decision: 'declined' },
    });
    expect(manage.content).toContain('needs the project:manage permission on project 1');
    // An instance-wide action needs the permission on the instance.
    const instance = await propose(maintainer, {
      action: 'decide-capability',
      params: { capability: 'coverage', decision: 'declined' },
    });
    expect(instance.content).toContain('action: decide-capability needs the settings:manage permission, which');
    expect(
      (
        await propose(administrator, {
          action: 'decide-capability',
          params: { capability: 'coverage', decision: 'declined' },
        })
      ).block,
    ).toMatchObject({ target: null, projectId: null, params: { capability: 'coverage', decision: 'declined' } });
  });

  test('refuses a target the user cannot read, even one a tool result named', async () => {
    const hidden = await propose(maintainer, { action: 'resolve-cluster', target: { type: 'cluster', id: 2 } });
    expect(hidden.content).toContain('target: cluster 2 is missing or not readable by the user');
  });

  test('refuses an action of a capability the instance declined', async () => {
    await setInstanceDecisions(db as never, { quarantine: 'declined' });
    const declined = await propose(administrator, { action: 'quarantine-test', target: { type: 'test-case', id: 1 } });
    expect(declined.content).toContain('quarantine-test needs the quarantine capability, declined on this instance');
  });

  test('is a block tool: it does not count toward the read limit', async () => {
    const readTools = await tools.assistantReadTools(db as never, maintainer);
    const toolbox = tools.createAssistantToolbox({
      db: db as never,
      ctx: maintainer,
      readTools,
      page: null,
      extraTools: [],
    });
    expect(toolbox.isBlockTool('propose_change')).toBe(true);
    const definition = toolbox.definitions().find((d) => d.name === 'propose_change')!;
    expect(definition.description).toContain('- resolve-cluster (target: cluster; params: { note?: string })');
    expect(definition.description).toContain('- decide-capability (no target; params: { capability: ');
    expect(definition.inputSchema).toMatchObject({
      required: expect.arrayContaining(['id', 'action', 'title', 'change']),
      properties: { action: { enum: expect.arrayContaining(['quarantine-test', 'keep-run']) } },
    });
  });
});
