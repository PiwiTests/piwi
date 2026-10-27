/**
 * How a resource finding reads, wherever Piwi shows one: the Resources tab,
 * the pull-request comment and the MCP tools. One finding is a label, a place
 * and its facts, in the words the reporter's end-of-run summary uses. Pure, so
 * the server, the demo and the browser share it.
 */
import type { ResourceVerdict, WireResourceFinding } from '#shared/types';

/** `5.6 s`, `2 min 3 s`, `850 ms`. */
export function formatCpuTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** `845 kB`, `120 MB`, `1.4 GB`. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} kB`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const VERDICT_LABEL: Record<ResourceVerdict, string> = {
  leaked: 'Leaked',
  idle: 'Never used',
  piling: 'Piling up',
  handle: 'Left running',
  probable: 'Probable leak',
};

const KIND_LABEL: Record<WireResourceFinding['kind'], string> = {
  browser: 'browser',
  context: 'context',
  page: 'page',
  request: 'API context',
  handle: 'handle',
  worker: 'worker',
};

/** Node's handle type names, as a reader knows them. */
const HANDLE_LABEL: Record<string, string> = {
  TCPServerWrap: 'server',
  FSEventWrap: 'file watcher',
  StatWatcher: 'file watcher',
  ChildProcess: 'process',
};

const GROWTH_NOUN = {
  pages: 'open pages',
  listeners: 'listeners',
  routes: 'route handlers',
  elements: 'DOM elements',
  heapMb: 'worker heap',
  descriptors: 'file descriptors',
} as const;

/** What follows a growth's numbers, for those that are not a plain count. */
const GROWTH_UNIT: Partial<Record<keyof typeof GROWTH_NOUN, string>> = {
  heapMb: ' MB after garbage collection',
};

export interface FindingView {
  /** `Leaked context`, `Never used page`, `Piling up listeners`. */
  label: string;
  /** Where it was opened, as the reporter named it; null for a Node handle. */
  where: string | null;
  /** The `file:line` that opened it, for the open-in-IDE link. */
  site: string | null;
  /** The facts, in the order the summary prints them. */
  facts: string[];
}

/** One finding as a row reads it. */
export function findingView(finding: WireResourceFinding): FindingView {
  const what =
    finding.verdict === 'handle'
      ? (HANDLE_LABEL[finding.where] ?? finding.where)
      : finding.growth
        ? GROWTH_NOUN[finding.growth.what]
        : KIND_LABEL[finding.kind];
  const facts: string[] = [];
  switch (finding.verdict) {
    case 'leaked': {
      if (finding.count > 1) facts.push(`${finding.count} ${KIND_LABEL[finding.kind]}s`);
      if (finding.detail) facts.push(finding.detail);
      if (finding.pages) facts.push(`with ${plural(finding.pages, 'page')}`);
      if (finding.tests) facts.push(plural(finding.tests, 'test'));
      const past = finding.scope === 'describe' ? 'its describe block' : 'its test';
      if (finding.closedByPiwi) facts.push('closed by Piwi at the end of its test');
      else if (finding.untilWorkerEnd)
        facts.push(`open until the worker shut down (${formatCpuTime(finding.heldMs ?? 0)} past ${past})`);
      else facts.push(`open ${formatCpuTime(finding.heldMs ?? 0)} past ${past}`);
      if ((finding.afterTestCpuMs ?? 0) >= 500)
        facts.push(`${formatCpuTime(finding.afterTestCpuMs!)} of page CPU after its test`);
      break;
    }
    case 'idle':
      facts.push(plural(finding.count, 'page'));
      if (finding.tests) facts.push(plural(finding.tests, 'test'));
      if (finding.detail) facts.push(finding.detail);
      break;
    case 'piling': {
      const growth = finding.growth;
      if (growth)
        facts.push(`${growth.from} → ${growth.to}${GROWTH_UNIT[growth.what] ?? ''} over ${growth.tests} tests`);
      if (finding.detail) facts.push(finding.detail);
      break;
    }
    case 'handle':
      facts.push(`left running in the worker by ${finding.detail ?? 'a test'}`);
      break;
    case 'probable':
      if (finding.detail) facts.push(finding.detail);
      break;
  }
  return {
    label: `${VERDICT_LABEL[finding.verdict]} ${what}`,
    where: finding.verdict === 'handle' ? null : finding.where,
    site: finding.site ?? null,
    facts,
  };
}
