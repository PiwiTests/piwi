/**
 * Pure validation for selection definitions and keys.
 *
 * An unknown predicate key is an error, not a silent no-op: an old client
 * writing a definition a newer server would misread, or a typo'd predicate,
 * must fail loudly rather than resolve to a wider set than intended.
 */
import type { SelectionDefinition, SelectionPredicateGroup, SelectionRankBy } from './types';

/** Slug rule for a selection key — lowercase, digits and hyphens, 1–64 chars. */
export const SELECTION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Names no selection key may take: the literal routes beside
 * `/api/projects/:id/selections/:key`, which the server and the demo dispatch to
 * before `:key`, so a selection named so could not be read by its key.
 */
export const RESERVED_SELECTION_KEYS: ReadonlySet<string> = new Set([
  'analytics',
  'impact',
  'overview',
  'preview',
  'reuse-forecast',
  'suggestions',
]);

/** The largest window `failedInLastRuns` may look back over. */
export const MAX_FAILED_IN_LAST_RUNS = 25;

/** The most globs one `files` list holds, and the longest glob. */
export const MAX_FILE_GLOBS = 100;
export const MAX_FILE_GLOB_LENGTH = 500;

const VALID_PRIORITIES = new Set(['critical', 'high', 'medium', 'low']);
const VALID_RANK_BY = new Set(['failureLikelihood', 'recentFailure', 'priority', 'slowest', 'fastest']);

/** Predicate keys and their runtime kind, so an unknown key is caught. */
const PREDICATE_KINDS: Record<
  keyof SelectionPredicateGroup,
  'stringArray' | 'globArray' | 'idArray' | 'priorityArray' | 'string' | 'boolean' | 'rate' | 'nonNegative' | 'window'
> = {
  ids: 'idArray',
  tags: 'stringArray',
  anyTags: 'stringArray',
  owner: 'stringArray',
  priority: 'priorityArray',
  feature: 'stringArray',
  files: 'globArray',
  suitePath: 'string',
  text: 'string',
  quarantined: 'boolean',
  flaky: 'boolean',
  minPassRate: 'rate',
  maxPassRate: 'rate',
  minAvgDurationMs: 'nonNegative',
  maxAvgDurationMs: 'nonNegative',
  lastStatus: 'stringArray',
  failedInLastRuns: 'window',
  neverRun: 'boolean',
};

const TOP_LEVEL_KEYS = new Set(['include', 'exclude', 'pins', 'budget', 'limit']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateGroup(group: unknown, where: string, errors: string[]): void {
  if (!isPlainObject(group)) {
    errors.push(`${where} must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(group)) {
    const kind = PREDICATE_KINDS[key as keyof SelectionPredicateGroup];
    if (!kind) {
      errors.push(`${where}: unknown predicate "${key}"`);
      continue;
    }
    switch (kind) {
      case 'stringArray':
      case 'globArray':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          errors.push(`${where}.${key} must be an array of strings`);
        } else if (value.length === 0) {
          errors.push(`${where}.${key} must not be empty`);
        } else if (kind === 'globArray') {
          errors.push(...fileGlobsErrors(value, `${where}.${key}`));
        }
        break;
      case 'idArray':
        validateIdArray(value, `${where}.${key}`, errors);
        break;
      case 'priorityArray':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !VALID_PRIORITIES.has(v))) {
          errors.push(`${where}.${key} must be an array of ${[...VALID_PRIORITIES].join(' / ')}`);
        }
        break;
      case 'string':
        if (typeof value !== 'string' || value.trim() === '') errors.push(`${where}.${key} must be a non-empty string`);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') errors.push(`${where}.${key} must be a boolean`);
        break;
      case 'rate':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
          errors.push(`${where}.${key} must be a number between 0 and 1`);
        }
        break;
      case 'nonNegative':
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          errors.push(`${where}.${key} must be a non-negative number`);
        }
        break;
      case 'window':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_FAILED_IN_LAST_RUNS) {
          errors.push(`${where}.${key} must be an integer between 1 and ${MAX_FAILED_IN_LAST_RUNS}`);
        }
        break;
    }
  }
}

/** What a `files` list past its limits answers, one message per limit broken; empty within them. */
export function fileGlobsErrors(globs: readonly string[], where: string): string[] {
  const errors: string[] = [];
  if (globs.length > MAX_FILE_GLOBS) errors.push(`${where} must hold at most ${MAX_FILE_GLOBS} globs`);
  if (globs.some((glob) => glob.length > MAX_FILE_GLOB_LENGTH)) {
    errors.push(`${where}: a glob must be at most ${MAX_FILE_GLOB_LENGTH} characters`);
  }
  return errors;
}

/** A `files` list read within its limits: its first 100 globs of at most 500 characters. */
export function withinFileGlobLimits(globs: readonly string[]): string[] {
  return globs.filter((glob) => glob.length <= MAX_FILE_GLOB_LENGTH).slice(0, MAX_FILE_GLOBS);
}

function validateIdArray(value: unknown, where: string, errors: string[]): void {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
    errors.push(`${where} must be an array of positive integer ids`);
  }
}

/**
 * Validate a definition's shape. Returns every problem found (not just the
 * first) so a caller can report them all at once.
 */
export function validateSelectionDefinition(definition: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(definition)) {
    return { valid: false, errors: ['definition must be an object'] };
  }

  for (const key of Object.keys(definition)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown key "${key}"`);
  }

  const def = definition as Partial<SelectionDefinition>;

  for (const field of ['include', 'exclude'] as const) {
    const groups = def[field];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) {
      errors.push(`${field} must be an array of predicate groups`);
      continue;
    }
    groups.forEach((group, i) => validateGroup(group, `${field}[${i}]`, errors));
  }

  if (def.pins !== undefined) {
    if (!isPlainObject(def.pins)) {
      errors.push('pins must be an object');
    } else {
      for (const key of Object.keys(def.pins)) {
        if (key !== 'add' && key !== 'remove') errors.push(`pins: unknown key "${key}"`);
      }
      if (def.pins.add !== undefined) validateIdArray(def.pins.add, 'pins.add', errors);
      if (def.pins.remove !== undefined) validateIdArray(def.pins.remove, 'pins.remove', errors);
    }
  }

  if (def.budget !== undefined) {
    if (!isPlainObject(def.budget)) {
      errors.push('budget must be an object');
    } else {
      for (const key of Object.keys(def.budget)) {
        if (key !== 'maxTotalDurationMs' && key !== 'rankBy') errors.push(`budget: unknown key "${key}"`);
      }
      const cap: unknown = def.budget.maxTotalDurationMs;
      if (cap !== undefined && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0)) {
        errors.push('budget.maxTotalDurationMs must be a positive number');
      }
      const rankBy: unknown = def.budget.rankBy;
      if (rankBy !== undefined && (typeof rankBy !== 'string' || !VALID_RANK_BY.has(rankBy))) {
        errors.push(`budget.rankBy must be one of ${[...VALID_RANK_BY].join(' / ')}`);
      }
    }
  }

  if (def.limit !== undefined && (typeof def.limit !== 'number' || !Number.isInteger(def.limit) || def.limit < 1)) {
    errors.push('limit must be a positive integer');
  }

  return { valid: errors.length === 0, errors };
}

/** Parse a rank-by name (the order tests are emitted in), or null if unknown. */
export function parseRankBy(raw: unknown): SelectionRankBy | null {
  return typeof raw === 'string' && VALID_RANK_BY.has(raw) ? (raw as SelectionRankBy) : null;
}

/** Most shards a selection splits into: the split allocates and scans one bucket per shard. */
export const MAX_SHARDS = 1000;

/** Parse a `i/n` shard spec (e.g. `2/4`) into 1-based index and total, or null (also past {@link MAX_SHARDS}). */
export function parseShard(raw: unknown): { index: number; total: number } | null {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return null;
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total)) return null;
  if (total < 1 || total > MAX_SHARDS || index < 1 || index > total) return null;
  return { index, total };
}

/** Validate a selection key slug. */
export function validateSelectionKey(key: unknown): { valid: boolean; error?: string } {
  if (typeof key !== 'string' || !SELECTION_KEY_PATTERN.test(key)) {
    return {
      valid: false,
      error: 'key must be 1–64 characters of lowercase letters, digits and hyphens, starting with a letter or digit',
    };
  }
  if (RESERVED_SELECTION_KEYS.has(key)) {
    return { valid: false, error: `"${key}" names a selections route, so it cannot be a selection's key` };
  }
  return { valid: true };
}
