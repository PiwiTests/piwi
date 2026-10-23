/**
 * The assistant's live question set (`tests/live/assistant-questions.ts`),
 * checked with no model: every tool a question expects is one the assistant
 * can be offered, every anchor is in the registry and can render on a
 * server, every page is a page of the dashboard showing a seeded entity,
 * every fact matches the story, example, project, seed table, docs page or
 * variable it names, and the topics have the spread the header lists.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DESKTOP_MCP_TOOL_DEFS, MCP_TOOL_DEFS, toolPermissions } from '#shared/mcp-tools';
import { isAssistantBlockTool } from '#shared/assistant-blocks';
import { ASSISTANT_MAX_QUESTION_CHARS, assistantPageContextSchema } from '#shared/assistant';
import { findGuideAnchor } from '#shared/guide-anchors/index.mjs';
import { buildDocsCorpus, findDocsPage } from '#shared/docs-corpus';
import { DEMO_EXAMPLES } from '#shared/demo/demo-examples.mjs';
import { DEMO_PROJECTS, FAILURE_STORIES } from '#shared/demo/failure-stories.mjs';
import { PIWI_ENV_VARS } from '#shared/piwi-env-vars';
import {
  EXPECTED_BLOCK_KINDS,
  LIVE_QUESTIONS,
  QUESTION_SPREAD,
  QUESTION_TOPICS,
  questionContext,
  type FactSource,
  type LiveQuestion,
} from '../live/assistant-questions';
import { factIn, normalizeFactText } from '../live/assistant-scoring';

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_DESKTOP_TOKEN;
vi.stubGlobal('useRuntimeConfig', () => ({ ai: {}, authEnabled: false, public: { appVersion: '0.59.0' } }));

const { CORE_ASSISTANT_TOOLS, PAGE_TOOLS, createAssistantToolbox } = await import('../../server/utils/assistant/tools');

const appDir = resolve(__dirname, '../..');
const docsRoot = resolve(appDir, '../docs');
const questionsFile = join(appDir, 'tests/live/assistant-questions.ts');

const desktopOnly = new Set<string>(DESKTOP_MCP_TOOL_DEFS.map((t) => t.name));
const READ_TOOLS = new Set<string>(
  MCP_TOOL_DEFS.filter((t) => toolPermissions(t).length === 0 && !desktopOnly.has(t.name)).map((t) => t.name),
);
/** The assistant's own tools: what a toolbox offers besides the read tools and the block tools. */
const OWN_TOOLS = new Set(
  createAssistantToolbox({ db: null as never, ctx: null as never, readTools: [], page: null, extraTools: [] })
    .definitions()
    .map((d) => d.name)
    .filter((name) => !isAssistantBlockTool(name)),
);

/** The table of the seeded entity a page with an `[id]` opens. */
const PAGE_TABLES: Record<string, string> = {
  '/projects/[id]': 'projects',
  '/projects/[id]/coverage': 'projects',
  '/test-runs/[id]': 'test_runs',
  '/test-run-cases/[id]': 'test_runs_cases',
  '/failure-clusters/[id]': 'failure_clusters',
  '/test-cases/[id]': 'test_cases',
};

/** Every string and number in a value, one per line. */
function deepText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(deepText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(deepText).join('\n');
  return '';
}

/** The docs tree as the server bundles it: every file, keyed by its path relative to apps/docs. */
function docsFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'public') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(docsRoot, path)] = readFileSync(path, 'utf8');
    }
  })(docsRoot);
  return files;
}

const corpus = buildDocsCorpus(docsFiles());

let seed: import('sql.js').Database;
let seedDir = '';

/** Every value of every row of a table of the generated seed, or null when the seed has no such table. */
function seedTableText(table: string): string | null {
  const exists = seed.exec('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?', ['table', table]);
  if (!exists.length) return null;
  const result = seed.exec(`SELECT * FROM "${table}"`);
  return result.length ? result[0]!.values.map((row) => row.map((v) => String(v ?? '')).join('\n')).join('\n') : '';
}

/** The text a fact source names, or null when it names nothing. */
function sourceText(from: FactSource): string | null {
  const at = from.indexOf(':');
  const kind = from.slice(0, at);
  const name = from.slice(at + 1);
  switch (kind) {
    case 'story': {
      const story = FAILURE_STORIES.find((s) => s.key === name);
      return story ? deepText(story) : null;
    }
    case 'example': {
      const example = DEMO_EXAMPLES.find((e) => e.id === name);
      return example ? deepText(example) : null;
    }
    case 'project': {
      const project = DEMO_PROJECTS.find((p) => p.id === Number(name));
      return project ? deepText(project) : null;
    }
    case 'seed':
      return seedTableText(name);
    case 'docs': {
      const page = findDocsPage(corpus, name);
      return page ? page.lines.join('\n') : null;
    }
    case 'env': {
      const variable = (PIWI_ENV_VARS as Record<string, { description: string } | undefined>)[name];
      return variable ? `${name}\n${variable.description}` : null;
    }
    default:
      return null;
  }
}

function isPage(pattern: string): boolean {
  const base = join(appDir, 'app/pages', pattern === '/' ? 'index' : pattern);
  return existsSync(`${base}.vue`) || existsSync(join(base, 'index.vue'));
}

beforeAll(async () => {
  // A throwaway directory of this file's own, never the tracked public/demo/seed.sql.
  seedDir = mkdtempSync(join(tmpdir(), 'piwi-assistant-questions-'));
  execFileSync('node', ['scripts/generate-demo-seed.mjs'], {
    cwd: appDir,
    stdio: 'ignore',
    env: { ...process.env, PIWI_DEMO_SEED_OUTPUT_DIR: seedDir },
  });
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  seed = new SQL.Database();
  seed.exec(readFileSync(join(seedDir, 'seed.sql'), 'utf8'));
}, 120_000);

afterAll(() => {
  seed?.close();
  if (seedDir) rmSync(seedDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const each = (check: (q: LiveQuestion) => string[]) => LIVE_QUESTIONS.flatMap(check);

describe('the question set', () => {
  test('has unique kebab-case ids and unique questions within the length a question may have', () => {
    const ids = LIVE_QUESTIONS.map((q) => q.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(ids.filter((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))).toEqual([]);
    const texts = LIVE_QUESTIONS.map((q) => q.question);
    expect(texts.filter((t, i) => texts.indexOf(t) !== i)).toEqual([]);
    expect(each((q) => (q.question.length <= ASSISTANT_MAX_QUESTION_CHARS ? [] : [q.id]))).toEqual([]);
  });

  test('spreads over the topics as its header says', () => {
    const counts = Object.fromEntries(
      QUESTION_TOPICS.map((topic) => [topic, LIVE_QUESTIONS.filter((q) => q.topic === topic).length]),
    );
    expect(counts).toEqual(QUESTION_SPREAD);
    const header = readFileSync(questionsFile, 'utf8').split('*/')[0]!;
    const listed = Object.fromEntries(
      [...header.matchAll(/^ \* {3}([a-z-]+) +(\d+) /gm)].map((m) => [m[1], Number(m[2])]),
    );
    expect(listed).toEqual(QUESTION_SPREAD);
    const total = Object.values(QUESTION_SPREAD).reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThanOrEqual(140);
  });
});

describe('tools', () => {
  test('every expected tool is a read tool of the catalog or one of the assistant’s own', () => {
    expect(OWN_TOOLS).toEqual(new Set(['find_tools', 'get_instance_config', 'find_anchors']));
    expect(
      each((q) => q.tools.filter((name) => !READ_TOOLS.has(name) && !OWN_TOOLS.has(name)).map((n) => `${q.id}: ${n}`)),
    ).toEqual([]);
  });

  test('every question expects a tool, one of them offered on its page without find_tools', () => {
    expect(
      each((q) => {
        const page = questionContext(q)?.page ?? null;
        const direct = new Set<string>([...CORE_ASSISTANT_TOOLS, ...((page && PAGE_TOOLS[page]) || []), ...OWN_TOOLS]);
        return q.tools.some((name) => direct.has(name)) ? [] : [`${q.id}: ${q.tools.join(', ') || 'no tool'}`];
      }),
    ).toEqual([]);
  });
});

describe('pages', () => {
  test('every page context is one the panel can send, on a page of app/pages', () => {
    expect(
      each((q) => {
        const context = questionContext(q);
        if (!context) return [];
        const problems: string[] = [];
        if (!assistantPageContextSchema.safeParse(context).success) problems.push(`${q.id}: not a valid page context`);
        if (!context.page || !isPage(context.page)) problems.push(`${q.id}: ${context.page} is not a page`);
        return problems;
      }),
    ).toEqual([]);
  });

  test('every page with an id opens an entity of the seed', () => {
    expect(
      each((q) => {
        const context = questionContext(q);
        if (!context?.page?.includes('[id]')) return [];
        const table = PAGE_TABLES[context.page];
        if (!table) return [`${q.id}: no seed table for ${context.page}`];
        const found = seed.exec(`SELECT 1 FROM "${table}" WHERE id = ?`, [Number(context.params?.id)]);
        return found.length ? [] : [`${q.id}: no ${table} row ${context.params?.id}`];
      }),
    ).toEqual([]);
  });
});

describe('blocks and anchors', () => {
  test('every block kind is one an answer can have, and every guide question names its anchors', () => {
    expect(
      each((q) => {
        const problems = (q.blocks ?? [])
          .filter((kind) => !(EXPECTED_BLOCK_KINDS as readonly string[]).includes(kind))
          .map((kind) => `${q.id}: ${kind} is not a block kind`);
        const guide = q.blocks?.includes('guide') ?? false;
        if (guide !== Boolean(q.anchors?.length)) problems.push(`${q.id}: a guide and its anchors go together`);
        if (q.topic === 'show-me' && !guide) problems.push(`${q.id}: a show-me question expects a guide`);
        return problems;
      }),
    ).toEqual([]);
  });

  test('every anchor is in the registry and renders on a server', () => {
    expect(
      each((q) =>
        (q.anchors ?? []).flatMap((id) => {
          const anchor = findGuideAnchor(id);
          if (!anchor) return [`${q.id}: ${id} is not in the registry`];
          if (anchor.requires?.demo) return [`${q.id}: ${id} renders in the demo only`];
          if (anchor.requires?.desktop) return [`${q.id}: ${id} renders in the desktop app only`];
          return [];
        }),
      ),
    ).toEqual([]);
  });
});

describe('facts', () => {
  test('every question but a show-me one expects a fact, each with an alternative', () => {
    expect(each((q) => (q.topic === 'show-me' || q.facts.length ? [] : [q.id]))).toEqual([]);
    expect(each((q) => q.facts.filter((f) => f.any.length === 0).map(() => q.id))).toEqual([]);
  });

  test('every alternative of every fact is in the source it names', () => {
    const texts = new Map<FactSource, string | null>();
    const problems = each((q) =>
      q.facts.flatMap((fact) => {
        if (!texts.has(fact.from)) {
          const text = sourceText(fact.from);
          texts.set(fact.from, text === null ? null : normalizeFactText(text));
        }
        const text = texts.get(fact.from);
        if (text === null || text === undefined) return [`${q.id}: ${fact.from} names nothing`];
        return fact.any
          .filter((alternative) => !factIn({ from: fact.from, any: [alternative] }, text))
          .map((alternative) => `${q.id}: ${String(alternative)} is not in ${fact.from}`);
      }),
    );
    expect(problems).toEqual([]);
  });
});
