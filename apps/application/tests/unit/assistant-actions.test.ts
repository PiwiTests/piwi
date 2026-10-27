/**
 * The actions a proposal card can apply: each calls an existing REST route
 * with the method its file answers, needs the permission that route declares
 * in `x-required-permission`, and builds a path that route matches and the
 * body it reads from the action's parameters alone.
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ASSISTANT_ACTIONS,
  ASSISTANT_ACTION_IDS,
  assistantActionRequest,
  isAssistantActionId,
  type AssistantActionId,
} from '#shared/assistant-actions';
import { isAssistantBlockTool } from '#shared/assistant-blocks';
import { CAPABILITIES } from '#shared/capabilities';
import { isRoutePermission } from '#shared/permissions';

const appDir = resolve(__dirname, '../..');

/** The route file answering `method` on `route` (`/api/test-runs/[id]` → `server/api/test-runs/[id].patch.ts`). */
function routeFile(route: string, method: string): string | null {
  const base = join(appDir, 'server', route);
  const verb = method.toLowerCase();
  return [`${base}.${verb}.ts`, join(base, `index.${verb}.ts`)].find((file) => existsSync(file)) ?? null;
}

/** The inline `x-required-permission` of a route file's meta. */
function declaredPermission(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const rest = source.slice(source.indexOf("'x-required-permission':") + "'x-required-permission':".length);
  const value = /^\s*(\[[^\]]*\]|'[^']*')/.exec(rest)?.[1] ?? '';
  return [...value.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** A path the route matches: each `[param]` is one segment of digits. */
function routePattern(route: string): RegExp {
  return new RegExp(`^${route.replace(/\[[^\]]+\]/g, '\\d+')}(\\?.*)?$`);
}

const SAMPLE_PARAMS: Record<AssistantActionId, Record<string, unknown>> = {
  'resolve-cluster': { note: 'Fixed in #42' },
  'ignore-cluster': {},
  'reopen-cluster': {},
  'quarantine-test': { reason: 'Flaky on CI' },
  'release-test': {},
  'diagnose-cluster': { force: true },
  'diagnose-execution': {},
  'keep-run': { reason: 'v2.3.1 release' },
  'decide-capability': { capability: 'coverage', decision: 'declined' },
  'decide-project-capability': { capability: 'quarantine', decision: 'enabled' },
};

describe('the action registry', () => {
  test.each(ASSISTANT_ACTION_IDS)('%s calls an existing route with the permission it declares', (id) => {
    const action = ASSISTANT_ACTIONS[id];
    expect(action.id).toBe(id);
    const file = routeFile(action.route, action.method);
    expect(file, `no route file answers ${action.method} ${action.route}`).not.toBeNull();
    expect(declaredPermission(file!), `${action.route} declares another permission`).toEqual([action.permission]);
    expect(isRoutePermission(action.permission)).toBe(true);
  });

  test.each(ASSISTANT_ACTION_IDS)('%s builds a path its route matches, from a target and a project', (id) => {
    const action = ASSISTANT_ACTIONS[id];
    const params = action.params.parse(SAMPLE_PARAMS[id]);
    const call = { targetId: action.target ? 7 : null, projectId: action.target ? 3 : null, params };
    expect(action.path(call)).toMatch(routePattern(action.route));
  });

  test('every action has a label and a description, and a target kind or none', () => {
    for (const id of ASSISTANT_ACTION_IDS) {
      const action = ASSISTANT_ACTIONS[id];
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.label.length).toBeLessThanOrEqual(60);
      expect(action.description.length).toBeGreaterThan(20);
      expect([null, 'project', 'run', 'execution', 'cluster', 'test-case']).toContain(action.target);
      if (action.capability) expect(CAPABILITIES.map((c) => c.id)).toContain(action.capability);
    }
    expect(isAssistantActionId('resolve-cluster')).toBe(true);
    expect(isAssistantActionId('delete-project')).toBe(false);
    expect(isAssistantBlockTool('propose_change')).toBe(true);
  });
});

describe('the requests the actions build', () => {
  const request = (action: AssistantActionId, params: Record<string, unknown>, target = 7, projectId = 3) =>
    assistantActionRequest({
      action,
      target: ASSISTANT_ACTIONS[action].target ? { id: target } : null,
      projectId: ASSISTANT_ACTIONS[action].target ? projectId : null,
      params: ASSISTANT_ACTIONS[action].params.parse(params),
    });

  test("a cluster's status, with its note only when one is given", () => {
    expect(request('resolve-cluster', { note: 'Fixed in #42' })).toEqual({
      method: 'PATCH',
      path: '/api/failure-clusters/7/status',
      body: { status: 'resolved', triageNote: 'Fixed in #42' },
    });
    expect(request('ignore-cluster', {}).body).toEqual({ status: 'ignored' });
    expect(request('reopen-cluster', {}).body).toEqual({ status: 'open' });
  });

  test("a quarantine names the test's project in the path and the test in the body", () => {
    expect(request('quarantine-test', { reason: 'Flaky on CI' })).toEqual({
      method: 'POST',
      path: '/api/projects/3/quarantine',
      body: { testCaseId: 7, reason: 'Flaky on CI' },
    });
    expect(request('release-test', {})).toEqual({
      method: 'DELETE',
      path: '/api/projects/3/quarantine/7',
      body: undefined,
    });
  });

  test('a diagnosis sends no body, and force as the query its route reads', () => {
    expect(request('diagnose-cluster', {})).toEqual({
      method: 'POST',
      path: '/api/failure-clusters/7/diagnose',
      body: undefined,
    });
    expect(request('diagnose-execution', { force: true }).path).toBe('/api/test-run-cases/7/diagnose?force=true');
  });

  test('keeping a run, and the capability decisions in the shape their routes read', () => {
    expect(request('keep-run', {})).toEqual({ method: 'PATCH', path: '/api/test-runs/7', body: { keep: true } });
    expect(request('decide-capability', { capability: 'coverage', decision: 'reconsider' })).toEqual({
      method: 'PATCH',
      path: '/api/capabilities',
      body: { decisions: { coverage: null } },
    });
    expect(request('decide-project-capability', { capability: 'quarantine', decision: 'default' })).toEqual({
      method: 'PATCH',
      path: '/api/projects/7/capabilities',
      body: { decisions: { quarantine: null } },
    });
    expect(request('decide-project-capability', { capability: 'quarantine', decision: 'declined' }).body).toEqual({
      decisions: { quarantine: 'declined' },
    });
  });

  test('a parameter schema refuses what its route would not take', () => {
    const decide = ASSISTANT_ACTIONS['decide-capability'].params;
    expect(decide.safeParse({ capability: 'assistant', decision: 'declined' }).success).toBe(false);
    expect(decide.safeParse({ capability: 'coverage', decision: 'enabled' }).success).toBe(false);
    expect(ASSISTANT_ACTIONS['keep-run'].params.safeParse({ reason: 'x'.repeat(201) }).success).toBe(false);
    expect(ASSISTANT_ACTIONS['decide-project-capability'].params.safeParse({ capability: 'mcp' }).success).toBe(false);
  });
});
