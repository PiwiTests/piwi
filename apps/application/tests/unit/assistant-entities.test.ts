/**
 * The entities a read tool's result names, read from the MCP field
 * conventions: a tool's top-level `id`, the objects under keys such as
 * `project` or `recentExecutions`, and the `…Id` fields anywhere; and the set
 * a conversation keeps of them.
 */
import { describe, expect, test } from 'vitest';
import {
  AssistantEntitySet,
  MAX_ENTITIES_PER_CALL,
  extractEntities,
  fallbackEntityLabel,
} from '../../server/utils/assistant/entities';

describe('extractEntities', () => {
  test("a list's rows are the tool's entity, with the runs they nest", () => {
    const found = extractEntities('list_projects', {
      items: [
        { id: 5, name: 'web-dashboard', label: 'Web Dashboard', latestRun: { id: 62, status: 'failed' } },
        { id: 1, name: 'e2e-checkout', latestRun: { id: 1, status: 'passed' } },
      ],
      nextCursor: '1',
    });
    expect(found).toEqual([
      { type: 'project', id: 5, label: 'Web Dashboard' },
      { type: 'run', id: 62, label: 'Run #62', status: 'failed' },
      { type: 'project', id: 1, label: 'e2e-checkout' },
      { type: 'run', id: 1, label: 'Run #1', status: 'passed' },
    ]);
  });

  test("a run's cases name their execution and test by title, and the cluster they fall in", () => {
    const found = extractEntities('get_run', {
      id: 1,
      projectId: 1,
      projectName: 'e2e-checkout',
      status: 'failed',
      cases: [
        { executionId: 6, testCaseId: 6, title: 'should add item to cart', status: 'failed' },
        { executionId: 3, testCaseId: 3, title: 'should pay', status: 'failed', clusterId: 2 },
      ],
    });
    expect(found).toEqual([
      { type: 'run', id: 1, label: 'Run #1', status: 'failed' },
      { type: 'project', id: 1, label: 'e2e-checkout' },
      { type: 'execution', id: 6, label: 'should add item to cart', status: 'failed' },
      { type: 'test-case', id: 6, label: 'should add item to cart' },
      { type: 'execution', id: 3, label: 'should pay', status: 'failed' },
      { type: 'test-case', id: 3, label: 'should pay' },
      { type: 'cluster', id: 2, label: 'Cluster #2' },
    ]);
  });

  test('a cluster names its project, its runs and its affected tests', () => {
    const found = extractEntities('get_cluster', {
      id: 1,
      title: 'Pay button stays disabled',
      status: 'open',
      firstSeenRunId: 4,
      lastSeenRunId: 1,
      project: { id: 1, name: 'e2e-checkout' },
      affectedTestCases: [{ testCaseId: 2, title: 'should pay with PayPal', executionId: 38 }],
      diagnosis: { id: 77, status: 'completed' },
    });
    expect(found).toEqual([
      { type: 'cluster', id: 1, label: 'Pay button stays disabled', status: 'open' },
      { type: 'run', id: 4, label: 'Run #4' },
      { type: 'run', id: 1, label: 'Run #1' },
      { type: 'project', id: 1, label: 'e2e-checkout' },
      { type: 'test-case', id: 2, label: 'should pay with PayPal' },
      { type: 'execution', id: 38, label: 'should pay with PayPal' },
    ]);
  });

  test("a test's recent executions are executions; an unknown container's ids are not entities", () => {
    const found = extractEntities('get_test_case', {
      id: 9,
      title: 'should apply discount code',
      recentExecutions: { items: [{ id: 229, runId: 20, status: 'passed' }] },
      clues: [{ id: 'element-present-but-blocked' }],
      traces: [{ id: 12, filePath: 'trace.zip' }],
    });
    expect(found).toEqual([
      { type: 'test-case', id: 9, label: 'should apply discount code' },
      { type: 'execution', id: 229, label: 'Execution #229', status: 'passed' },
      { type: 'run', id: 20, label: 'Run #20' },
    ]);
  });

  test("search's groups each hold their entity", () => {
    const found = extractEntities('search', {
      projects: [{ id: 3, name: 'ui-components', label: 'UI Components' }],
      runs: [{ id: 39, projectId: 3, projectName: 'ui-components' }],
      cases: [{ testCaseId: 21, title: 'opens the modal', projectId: 3 }],
      clusters: [{ id: 5, name: 'Modal never opens', projectId: 3 }],
    });
    expect(found.map((e) => `${e.type}:${e.id}:${e.label}`)).toEqual([
      'project:3:UI Components',
      'run:39:Run #39',
      'test-case:21:opens the modal',
      'cluster:5:Modal never opens',
    ]);
  });

  test("a tool whose top-level id is not an entity contributes only its fields; a diagnosis's id is not taken", () => {
    expect(extractEntities('get_cluster_diagnosis', { id: 77, clusterId: 1, rootCause: 'x' })).toEqual([
      { type: 'cluster', id: 1, label: 'Cluster #1' },
    ]);
    expect(extractEntities('describe_piwi', { sections: [{ id: 'setup' }] })).toEqual([]);
    expect(extractEntities('get_run', null)).toEqual([]);
  });

  test(`keeps at most ${MAX_ENTITIES_PER_CALL} entities of one call`, () => {
    const items = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, status: 'passed' }));
    expect(extractEntities('list_runs', { items })).toHaveLength(MAX_ENTITIES_PER_CALL);
  });
});

describe('AssistantEntitySet', () => {
  test("holds the earlier answers' entities and this answer's, a name replacing a fallback", () => {
    const set = new AssistantEntitySet([{ type: 'cluster', id: 2, label: fallbackEntityLabel('cluster', 2) }]);
    expect(set.get('cluster', 2)?.label).toBe('Cluster #2');
    set.add([{ type: 'cluster', id: 2, label: 'Email field never shows', status: 'open' }]);
    expect(set.get('cluster', 2)).toEqual({ type: 'cluster', id: 2, label: 'Email field never shows', status: 'open' });
    set.add([{ type: 'cluster', id: 2, label: 'Cluster #2' }]);
    expect(set.get('cluster', 2)?.label).toBe('Email field never shows');
    expect(set.get('run', 2)).toBeUndefined();
  });
});
