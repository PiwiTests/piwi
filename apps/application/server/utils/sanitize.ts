import { filterAndCapNetworkRequests } from '#shared/utils/filter-network-requests';
import { parseRunOrigin, RUN_ORIGIN_METADATA_KEY } from '@piwitests/core/wire';
import { maskTokenLike, maskUrlFragment } from '@piwitests/core/mask';
import { capStepValue } from '@piwitests/core/step-analysis';
import type { IngestLimits } from '#shared/ingest-limits';
import { withoutIncidentMetadata } from '#shared/run-incident';
import { reporterIngestHealth } from '#shared/ingest-health';
import { sanitizePageInteraction } from '#shared/page-interaction';

/**
 * URL and network data sanitization helpers.
 *
 * These are used by both submit.post.ts and upload.post.ts to strip sensitive
 * information (query parameters, fragments) from network request URLs and web
 * vitals navigation URLs before they are persisted in the database and returned
 * by the read endpoints.
 */

/**
 * Strip query string and fragment from a URL, keeping only scheme + host + path.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Not a valid absolute URL — return as-is (relative paths, data URIs, etc.)
    return url;
  }
}

/**
 * Sanitize an array of network request objects by stripping query params,
 * filtering to API/document types, and capping to failures + top 50.
 */
export function sanitizeNetworkRequests(requests: unknown[] | null | undefined): Record<string, unknown>[] | null {
  if (!requests || !Array.isArray(requests)) return null;
  const entries = filterAndCapNetworkRequests(requests as any);
  if (entries.length === 0) return null;
  return entries.map((r) => ({
    ...r,
    url: typeof r.url === 'string' ? sanitizeUrl(r.url) : r.url,
  }));
}

/**
 * Sanitize webVitals by stripping the query string from the navigation URL.
 */
export function sanitizeWebVitals(vitals: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!vitals || typeof vitals !== 'object') return null;
  const nav = vitals.navigation as Record<string, unknown> | null | undefined;
  if (!nav) return vitals;
  return {
    ...vitals,
    navigation: {
      ...nav,
      url: typeof nav.url === 'string' ? sanitizeUrl(nav.url) : nav.url,
    },
  };
}

/** The URL schemes a git remote may have. */
const GIT_REMOTE_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:']);

/**
 * Strip userinfo (username:password) from a Git remote URL.
 * Handles `https://token@host/repo` and `https://user:pass@host/repo` patterns.
 * An SSH remote (`git@host:owner/repo`) and a local path come back unchanged.
 * Null for a URL of any scheme a git remote does not use (`javascript:`, `data:`…).
 */
export function sanitizeGitRemoteUrl(url: string): string | null {
  if (/^[^\s/:@]+@[^\s/:]+:/.test(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!GIT_REMOTE_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.username) {
    parsed.username = '';
    parsed.password = '';
  }
  return parsed.toString();
}

/**
 * Sanitize run-level metadata by stripping credentials from SCM remote URLs,
 * so the read endpoints never return a token embedded in the remote URL. The
 * run's origin is kept only when it names a known kind, rebuilt as
 * `{ kind, ref? }`.
 */
export function sanitizeMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') return null;

  // A run's incident flag and a person's decision about it are the server's own. The
  // reporter may name its submit fallback; the ingest counts are the server's own.
  const meta = reporterIngestHealth(withoutIncidentMetadata(metadata));

  // Sanitize scm.remoteUrl
  const scm = meta.scm as Record<string, unknown> | null | undefined;
  if (scm && typeof scm.remoteUrl === 'string') {
    const { remoteUrl: _remoteUrl, ...rest } = scm;
    const remoteUrl = sanitizeGitRemoteUrl(scm.remoteUrl);
    meta.scm = remoteUrl === null ? rest : { ...rest, remoteUrl };
  }

  if (RUN_ORIGIN_METADATA_KEY in meta) {
    const origin = parseRunOrigin(meta[RUN_ORIGIN_METADATA_KEY]);
    if (origin) meta[RUN_ORIGIN_METADATA_KEY] = origin;
    else delete meta[RUN_ORIGIN_METADATA_KEY];
  }

  return meta;
}

/**
 * Defensive shape-validation of the reporter's page-state payload before it is
 * persisted. The reporter already never captures storage/cookie values — this
 * server-side pass enforces the same contract against arbitrary submitters:
 * only whitelisted fields survive, counts and string lengths are capped, and
 * focus, hover and selection keep only well-formed element paths.
 */
export function sanitizePageState(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const s = state as Record<string, unknown>;

  const str = (v: unknown, cap: number): string | null => (typeof v === 'string' ? v.slice(0, cap) : null);
  const storage = (v: unknown): Array<{ key: string; length: number }> =>
    Array.isArray(v)
      ? v
          .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
          .slice(0, 50)
          .map((e) => ({
            key: typeof e.key === 'string' ? e.key.slice(0, 200) : '',
            length: typeof e.length === 'number' ? e.length : 0,
          }))
      : [];
  const cookies = Array.isArray(s.cookies)
    ? s.cookies
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .slice(0, 30)
        .map((c) => ({
          name: typeof c.name === 'string' ? c.name.slice(0, 200) : '',
          domain: typeof c.domain === 'string' ? c.domain.slice(0, 200) : '',
          path: typeof c.path === 'string' ? c.path.slice(0, 200) : '',
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure),
          ...(typeof c.sameSite === 'string' ? { sameSite: c.sameSite.slice(0, 20) } : {}),
          ...(typeof c.expires === 'number' ? { expires: c.expires } : {}),
        }))
    : [];

  const url = str(s.url, 2000);
  if (!url) return null;

  return {
    url: sanitizeUrl(url),
    hash: str(typeof s.hash === 'string' ? maskUrlFragment(s.hash) : null, 500),
    historyState: str(s.historyState, 2100),
    localStorage: storage(s.localStorage),
    sessionStorage: storage(s.sessionStorage),
    cookies,
    ...sanitizePageInteraction(s),
  };
}

/** One AI-step intent mapping: the prompt a replayed locator was compiled from. */
export interface AiUsageIntent {
  template: string;
  locator: string;
  kind: 'locator' | 'run';
}

/**
 * Sanitize the AI-step usage manifest — `{ entries: string[], intents?: [...] }`,
 * the committed artifact paths a test replayed plus the natural-language intent
 * behind each compiled locator. Keeps only well-shaped values, bounded in count
 * and length against a verbose or hostile submitter. Returns null when empty.
 */
export function sanitizeAiUsage(usage: unknown): { entries: string[]; intents?: AiUsageIntent[] } | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const raw = (usage as Record<string, unknown>).entries;
  if (!Array.isArray(raw)) return null;
  const entries = raw
    .filter((e): e is string => typeof e === 'string')
    .slice(0, 500)
    .map((e) => e.slice(0, 400));
  if (entries.length === 0) return null;

  const rawIntents = (usage as Record<string, unknown>).intents;
  const intents = Array.isArray(rawIntents)
    ? rawIntents
        .filter(
          (i): i is Record<string, unknown> =>
            !!i &&
            typeof i === 'object' &&
            typeof (i as Record<string, unknown>).template === 'string' &&
            typeof (i as Record<string, unknown>).locator === 'string' &&
            ((i as Record<string, unknown>).kind === 'locator' || (i as Record<string, unknown>).kind === 'run'),
        )
        .slice(0, 100)
        .map(
          (i): AiUsageIntent => ({
            template: (i.template as string).slice(0, 300),
            locator: (i.locator as string).slice(0, 400),
            kind: i.kind as AiUsageIntent['kind'],
          }),
        )
    : [];

  return intents.length > 0 ? { entries, intents } : { entries };
}

/**
 * Sanitize console log entries by stripping the query string from the URL part
 * of each entry's `location` (formatted as `url:line:column`).
 */
export function sanitizeConsoleLogs(
  logs: Array<Record<string, unknown>> | null | undefined,
): Array<Record<string, unknown>> | null {
  if (!logs || !Array.isArray(logs)) return null;
  return logs.map((log) => {
    if (typeof log.location !== 'string') return log;
    // location is `url:line:column`; the URL itself contains colons (https://…)
    const match = log.location.match(/^(.*):(\d+):(\d+)$/);
    if (!match) return log;
    return { ...log, location: `${sanitizeUrl(match[1]!)}:${match[2]}:${match[3]}` };
  });
}

/** Max characters kept per stored dialog message / default value. */
const DIALOG_TEXT_CAP = 2000;

/**
 * Keep only the recognized fields of each recorded dialog, mask token-shaped
 * strings in the free text, and bound each string. Anything that is not an
 * array of objects becomes null.
 */
export function sanitizeDialogs(dialogs: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(dialogs)) return null;
  const out = dialogs
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => {
      const entry: Record<string, unknown> = {};
      if (typeof d.type === 'string') entry.type = d.type.slice(0, 40);
      if (typeof d.message === 'string') entry.message = maskTokenLike(d.message).slice(0, DIALOG_TEXT_CAP);
      if (typeof d.defaultValue === 'string' && d.defaultValue)
        entry.defaultValue = maskTokenLike(d.defaultValue).slice(0, DIALOG_TEXT_CAP);
      if (typeof d.closedAt === 'number') entry.closedAt = d.closedAt;
      return entry;
    });
  return out.length > 0 ? out : null;
}

/*
 * Ingest storage caps (see `shared/ingest-limits.ts`): bound the size of the
 * per-execution payloads before they are persisted. Applied by
 * `persistRunCases` and the demo reporter mirror.
 */

/** Truncate a string to `maxChars`, appending a truncation marker when cut. */
export function capText(text: string | null | undefined, maxChars: number): string | null {
  if (typeof text !== 'string') return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

/**
 * Truncate error text keeping both ends — the message/assertion detail lives
 * at the head, the innermost stack frames at the tail.
 */
export function capErrorText(error: string | null | undefined, maxChars: number): string | null {
  if (typeof error !== 'string') return null;
  if (error.length <= maxChars) return error;
  const headChars = Math.floor(maxChars * 0.75);
  const tailChars = maxChars - headChars;
  const dropped = error.length - headChars - tailChars;
  return `${error.slice(0, headChars)}\n… [truncated ${dropped} chars] …\n${error.slice(error.length - tailChars)}`;
}

/** Cap an unknown-typed JSON array payload (steps, step events) to `max` entries. */
export function capArray(value: unknown, max: number): unknown {
  if (!Array.isArray(value) || value.length <= max) return value ?? null;
  return value.slice(0, max);
}

/**
 * Re-cap and re-mask a step's curated `params`: keep primitives, JSON-stringify
 * anything else, mask token-shaped strings, and bound both the key count and
 * each value's length — the server never trusts the reporter's own caps.
 */
function capStepParams(
  raw: Record<string, unknown>,
  limits: IngestLimits,
): Record<string, string | number | boolean> | null {
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= limits.stepParamKeys) break;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      count++;
    } else if (typeof value === 'string') {
      out[key] = capStepValue(maskTokenLike(value), limits.stepParamValueChars);
      count++;
    } else if (value != null) {
      try {
        out[key] = capStepValue(maskTokenLike(JSON.stringify(value)), limits.stepParamValueChars);
        count++;
      } catch {
        // Non-serializable (circular) values are dropped.
      }
    }
  }
  return count > 0 ? out : null;
}

/** The `category` of the marker step that stands where {@link capSteps} dropped steps. */
export const DROPPED_STEPS_CATEGORY = 'piwi:dropped';

function stepFailed(step: unknown): boolean {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
  const s = step as Record<string, unknown>;
  return s.failed === true || (s.error != null && s.error !== '');
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** How many of `steps` the step cap leaves out: all but `limit - 1` once the marker step takes a slot. */
function droppedStepCount(length: number, limit: number): number {
  return length <= limit ? 0 : length - Math.max(0, limit - 1);
}

/** How many steps {@link capSteps} leaves out of a stored steps array. */
export function countDroppedSteps(value: unknown, limits: IngestLimits): number {
  return Array.isArray(value) ? droppedStepCount(value.length, limits.steps) : 0;
}

/**
 * The steps kept under the count cap, in their original order: every step that
 * failed or carries an error first (the failing step and the chain around it),
 * then the earliest steps in the room left. A marker step stands at the first
 * gap and names how many steps were dropped; it takes the depth and start time
 * of the next kept step (of the first dropped one when none follows), so the
 * stored list still rebuilds into a tree.
 */
function keepSteps(steps: unknown[], limit: number): unknown[] {
  if (steps.length <= limit) return steps;
  const room = Math.max(0, limit - 1);
  const kept = new Set<number>();
  steps.forEach((step, i) => {
    if (kept.size < room && stepFailed(step)) kept.add(i);
  });
  for (let i = 0; i < steps.length && kept.size < room; i++) kept.add(i);

  const dropped = droppedStepCount(steps.length, limit);
  const out: unknown[] = [];
  let marked = false;
  steps.forEach((step, i) => {
    if (kept.has(i)) {
      out.push(step);
      return;
    }
    if (marked) return;
    marked = true;
    const nextKept = steps.findIndex((_, j) => j > i && kept.has(j));
    const anchor = (nextKept === -1 ? step : steps[nextKept]) as Record<string, unknown> | null;
    const depth = finiteNumber(anchor?.depth);
    const startTime = finiteNumber(anchor?.startTime);
    out.push({
      title: `${dropped} steps not stored`,
      category: DROPPED_STEPS_CATEGORY,
      duration: 0,
      ...(depth !== null ? { depth } : {}),
      ...(startTime !== null ? { startTime } : {}),
    });
  });
  return out;
}

/**
 * Cap the stored steps array (count), keeping the steps that failed, and
 * re-normalize each step's `subtitle` and `params` against the ingest limits,
 * masking token-shaped strings. Applied on ingest so a payload that skipped
 * the reporter is bounded all the same.
 */
export function capSteps(value: unknown, limits: IngestLimits): unknown {
  if (!Array.isArray(value)) return value ?? null;
  return keepSteps(value, limits.steps).map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
    const s = step as Record<string, unknown>;
    const out: Record<string, unknown> = { ...s };
    if (typeof s.subtitle === 'string') {
      out.subtitle = capStepValue(maskTokenLike(s.subtitle), limits.stepParamValueChars);
    }
    if (s.params && typeof s.params === 'object' && !Array.isArray(s.params)) {
      const params = capStepParams(s.params as Record<string, unknown>, limits);
      if (params) out.params = params;
      else delete out.params;
    } else if ('params' in out) {
      delete out.params;
    }
    return out;
  });
}

/** How many entries {@link capConsoleLogs} leaves out of a console log. */
export function countDroppedConsoleEntries(logs: unknown, limits: IngestLimits): number {
  return Array.isArray(logs) ? Math.max(0, logs.length - limits.consoleEntries) : 0;
}

/**
 * Cap console entries to `limits.consoleEntries`, keeping the first 20 (page
 * setup context) and the newest remainder, with a synthetic marker entry in
 * between. Every entry's text is capped to `limits.consoleEntryChars`.
 */
export function capConsoleLogs(
  logs: Array<Record<string, unknown>> | null | undefined,
  limits: IngestLimits,
): Array<Record<string, unknown>> | null {
  if (!logs || !Array.isArray(logs)) return null;
  const capEntry = (log: Record<string, unknown>): Record<string, unknown> =>
    typeof log.text === 'string' && log.text.length > limits.consoleEntryChars
      ? { ...log, text: `${log.text.slice(0, limits.consoleEntryChars)} [truncated]` }
      : log;

  if (logs.length <= limits.consoleEntries) return logs.map(capEntry);

  const headCount = Math.min(20, limits.consoleEntries - 1);
  const tailCount = limits.consoleEntries - headCount;
  const dropped = logs.length - headCount - tailCount;
  return [
    ...logs.slice(0, headCount).map(capEntry),
    { type: 'info', text: `[${dropped} console entries dropped]` },
    ...logs.slice(logs.length - tailCount).map(capEntry),
  ];
}

/**
 * Cap the source stack frames (count, per-frame snippet chars, path length).
 * Shape-validates against arbitrary submitters: non-object frames are dropped.
 */
export function capSourceFrames(frames: unknown, limits: IngestLimits): unknown {
  if (!Array.isArray(frames)) return frames ?? null;
  const capped = frames
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && !Array.isArray(f))
    .slice(0, limits.sourceFrames)
    .map((f) => ({
      ...f,
      file: typeof f.file === 'string' ? f.file.slice(0, 500) : f.file,
      snippet: typeof f.snippet === 'string' ? (capText(f.snippet, limits.sourceFrameChars) ?? '') : f.snippet,
    }));
  return capped.length > 0 ? capped : null;
}
