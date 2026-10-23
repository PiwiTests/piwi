/**
 * The entities a read tool's result names, which an answer may link to, show
 * as a card or offer as a choice. Read from the MCP field conventions: a
 * tool's top-level `id` (its rows' too) is the entity it is about, an object
 * under a key such as `project`, `latestRun` or `recentExecutions` carries its
 * own `id`, and a numeric `projectId`, `…RunId`, `executionId`,
 * `testRunsCaseId`, `testCaseId` or `…ClusterId` field anywhere names one.
 * Labels come from the result's own words: a project's label or name, a
 * test's title; a run is `Run #<id>`.
 */
import { assistantEntityKey, type AssistantEntityRef, type AssistantEntityType } from '#shared/assistant';

/** The most entities one tool call adds. */
export const MAX_ENTITIES_PER_CALL = 100;

/** The entity a read tool's top-level `id`, and each of its `items`' ids, stand for. */
const TOOL_ENTITY: Readonly<Record<string, AssistantEntityType>> = {
  list_projects: 'project',
  get_project: 'project',
  list_runs: 'run',
  get_run: 'run',
  list_recent_activity: 'run',
  list_clusters: 'cluster',
  list_open_clusters: 'cluster',
  get_cluster: 'cluster',
  get_test_case: 'test-case',
};

/** Keys whose object, or list of objects (or `{ items }`), is an entity with its own `id`. */
const CONTAINER_ENTITY: Readonly<Record<string, AssistantEntityType>> = {
  project: 'project',
  projects: 'project',
  run: 'run',
  runs: 'run',
  testRun: 'run',
  latestRun: 'run',
  lastRun: 'run',
  cluster: 'cluster',
  clusters: 'cluster',
  failureCluster: 'cluster',
  testCase: 'test-case',
  testCases: 'test-case',
  execution: 'execution',
  executions: 'execution',
  recentExecutions: 'execution',
};

/** The entity a numeric field names, by its key; null for any other key. */
function fieldEntity(key: string): AssistantEntityType | null {
  if (key === 'projectId') return 'project';
  if (key === 'runId' || key === 'testRunId' || key.endsWith('RunId')) return 'run';
  if (key === 'executionId' || key.endsWith('ExecutionId') || key.endsWith('RunsCaseId')) return 'execution';
  if (key === 'testCaseId' || key.endsWith('TestCaseId')) return 'test-case';
  if (key === 'clusterId' || key.endsWith('ClusterId')) return 'cluster';
  return null;
}

const FALLBACK_LABELS: Record<AssistantEntityType, string> = {
  project: 'Project',
  run: 'Run',
  execution: 'Execution',
  cluster: 'Cluster',
  'test-case': 'Test',
};

/** What an entity is called when the result gives it no name: `Run #12`. */
export function fallbackEntityLabel(type: AssistantEntityType, id: number): string {
  return `${FALLBACK_LABELS[type]} #${id}`;
}

/** An entity a result named, with its status when the result gave the entity's own. */
interface FoundEntity extends AssistantEntityRef {
  status?: string;
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ').slice(0, 120) : null;

/** An entity's own name in its object: a project's label or name, a test's or cluster's title. */
function ownLabel(type: AssistantEntityType, row: Row): string | null {
  if (type === 'project') return text(row.label) ?? text(row.name);
  if (type === 'cluster') return text(row.title) ?? text(row.name);
  if (type === 'test-case' || type === 'execution') return text(row.title);
  return null;
}

/** The entities one read tool's result names, each once, at most {@link MAX_ENTITIES_PER_CALL}. */
export function extractEntities(tool: string, data: unknown): FoundEntity[] {
  const found = new Map<string, FoundEntity>();
  const named = new Set<string>();

  const add = (type: AssistantEntityType, id: number, label: string | null, status?: unknown) => {
    const key = assistantEntityKey({ type, id });
    const known = found.get(key);
    if (known) {
      if (label && !named.has(key)) {
        known.label = label;
        named.add(key);
      }
      if (!known.status && typeof status === 'string') known.status = status;
      return;
    }
    if (found.size >= MAX_ENTITIES_PER_CALL) return;
    if (label) named.add(key);
    found.set(key, {
      type,
      id,
      label: label ?? fallbackEntityLabel(type, id),
      ...(typeof status === 'string' ? { status } : {}),
    });
  };

  const visit = (value: unknown, own: AssistantEntityType | null, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, own, depth + 1);
      return;
    }
    if (!isRow(value)) return;
    if (own && isId(value.id)) add(own, value.id, ownLabel(own, value), value.status);
    for (const [key, field] of Object.entries(value)) {
      const type = fieldEntity(key);
      if (type && isId(field)) {
        // A row carrying its own execution id is that execution, a test's row its test: the title names both.
        const ownRow = key === 'executionId' || key === 'testRunsCaseId' || key === 'testCaseId';
        const label =
          type === 'project'
            ? (text(value.projectLabel) ?? text(value.projectName))
            : ownRow
              ? ownLabel(type, value)
              : null;
        add(type, field, label, type === 'execution' && ownRow ? value.status : undefined);
        continue;
      }
      const container = CONTAINER_ENTITY[key];
      if (container) {
        visit(isRow(field) && Array.isArray(field.items) ? field.items : field, container, depth + 1);
      } else if (typeof field === 'object' && field !== null) {
        // `items` of a paginated list are the rows of the entity the list holds.
        visit(field, key === 'items' ? own : null, depth + 1);
      }
    }
  };

  visit(data, TOOL_ENTITY[tool] ?? null, 0);
  return [...found.values()];
}

/**
 * The entities a conversation's tool results named: the stored calls of its
 * earlier answers, then this answer's as it reads. A later name replaces a
 * `Run #12`-style fallback.
 */
export class AssistantEntitySet {
  private readonly byKey = new Map<string, FoundEntity>();

  constructor(earlier: Iterable<AssistantEntityRef> = []) {
    this.add(earlier);
  }

  add(entities: Iterable<FoundEntity>): void {
    for (const entity of entities) {
      const key = assistantEntityKey(entity);
      const known = this.byKey.get(key);
      if (!known) {
        this.byKey.set(key, { ...entity });
        continue;
      }
      if (known.label === fallbackEntityLabel(known.type, known.id)) known.label = entity.label;
      if (entity.status) known.status = entity.status;
    }
  }

  get(type: AssistantEntityType, id: number): FoundEntity | undefined {
    return this.byKey.get(assistantEntityKey({ type, id }));
  }
}
