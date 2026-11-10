/**
 * Zephyr Scale Cloud client (REST v2, `Authorization: Bearer <token>`). It reads the connection's projects, a
 * project's test cases and the result statuses; the host comes from the connection's region in the registry, never
 * from a typed address.
 */
import { INTEGRATION_PROVIDERS } from '#shared/integrations/registry';
import { IntegrationHttpError, parseRetryAfter } from '../http-error';
import type {
  PageCursor,
  TestManagementCredentials,
  TestManagementProvider,
  TmCase,
  TmPage,
  TmProject,
  TmStatus,
} from './types';

/** The budget of one request: well under the outbox's lease, so a stuck call ends before the lease does. */
export const ZEPHYR_REQUEST_TIMEOUT_MS = 2 * 60_000;

/** The budget of what an administrator waits on (the Check and Test buttons), the same as Jira's. */
export const ZEPHYR_INTERACTIVE_TIMEOUT_MS = 10_000;

/** How a client spends its time. */
export interface ZephyrClientOptions {
  /** The budget of each request; {@link ZEPHYR_REQUEST_TIMEOUT_MS} when left out. */
  timeoutMs?: number;
  /** Ends every request still running when it aborts: the budget of a whole check, across its pages. */
  signal?: AbortSignal;
}

/** The most results Zephyr returns in one call. */
const PAGE_SIZE = 1000;

/** The most pages a read of a whole list follows, so a server that never says "last" cannot loop forever. */
export const ZEPHYR_MAX_PAGES = 50;

/** The largest `startAt` the API accepts. */
const MAX_START_AT = 1_000_000;

/** A Jira project key as Zephyr's `projectKey` parameter takes it. */
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

/** A token is sent as a header value: visible ASCII only, no whitespace. */
const TOKEN_CHARACTERS = /^[\x21-\x7E]+$/;

/** The longest explanation of Zephyr's carried into an error message. */
const DETAIL_MAX = 500;

const REGIONS = INTEGRATION_PROVIDERS['zephyr-scale'].endpoint.regions;

/** What a token that cannot be sent as a header value is reported as, by the check and by a connection test. */
export const ZEPHYR_TOKEN_UNUSABLE = 'The token holds characters a header cannot carry.';

/** The status a call that got no answer in time is reported with. */
export const ZEPHYR_TIMEOUT_STATUS = 504;

/** Whether a failed call ran out of its time budget: the abort signal's `TimeoutError`, or an `AbortError`. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** A Zephyr Scale refusal or failure. Its message never holds the token. */
export class ZephyrScaleError extends IntegrationHttpError {
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(status, message, retryAfterMs);
    this.name = 'ZephyrScaleError';
  }
}

interface PagedBody<T> {
  values: T[];
  startAt?: number;
  total?: number;
  isLast?: boolean;
  next?: string | null;
}

interface ZephyrProject {
  id: number;
  key: string;
  enabled: boolean;
}

interface ZephyrStatus {
  id: number;
  name: string;
  archived?: boolean;
  default?: boolean;
}

interface ZephyrTestCase {
  id: number;
  key: string;
  name: string;
  status?: { id: number } | null;
  folder?: { id: number } | null;
}

/** Zephyr's explanation of an error from its body: `message` (`{ errorCode, message }`) or `error` (the gateway). */
async function errorDetail(response: Response, token: string): Promise<string | null> {
  let body: { message?: unknown; error?: unknown };
  try {
    body = JSON.parse(await response.text());
  } catch {
    return null;
  }
  const text = [body?.message, body?.error].find((value) => typeof value === 'string' && value !== '');
  if (typeof text !== 'string') return null;
  const detail = text.replaceAll(token, '[token]');
  return detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail;
}

/** The error for a failed response: its status line plus Zephyr's explanation. */
async function toZephyrError(response: Response, token: string): Promise<ZephyrScaleError> {
  if (response.status === 429) {
    return new ZephyrScaleError(
      429,
      'Zephyr Scale rate limited the request (429)',
      parseRetryAfter(response.headers.get('retry-after')),
    );
  }
  const detail = await errorDetail(response, token);
  const statusLine =
    response.status === 401 || response.status === 403
      ? `Zephyr Scale refused the API token (${response.status})`
      : `Zephyr Scale request failed (${[response.status, response.statusText].filter(Boolean).join(' ')})`;
  return new ZephyrScaleError(
    response.status,
    detail ? `${statusLine}: ${detail}` : statusLine,
    parseRetryAfter(response.headers.get('retry-after')),
  );
}

/** Whether `body` is the last page of a read that asked for `startAt`. */
function isLastPage(body: PagedBody<unknown>, startAt: number): boolean {
  if (body.values.length === 0 || body.isLast === true || body.next === null) return true;
  return typeof body.total === 'number' && startAt + body.values.length >= body.total;
}

/** A cursor as the `startAt` it names; a cursor this client did not issue reads as an error. */
function startAtOf(cursor: PageCursor): number {
  if (cursor === null) return 0;
  const startAt = /^\d+$/.test(cursor) ? Number(cursor) : NaN;
  if (!Number.isSafeInteger(startAt) || startAt > MAX_START_AT) throw new RangeError('Invalid page cursor');
  return startAt;
}

function checkedProjectKey(projectKey: string): string {
  if (!PROJECT_KEY.test(projectKey)) throw new RangeError('Invalid project key');
  return projectKey;
}

export class ZephyrScaleClient implements TestManagementProvider {
  readonly provider = 'zephyr-scale' as const;

  private constructor(
    private readonly baseUrl: string,
    private readonly regionId: string,
    private readonly regionLabel: string,
    private readonly apiToken: string,
    private readonly timeoutMs: number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /**
   * A client on a region's host, or null for a region the registry does not list or a token that cannot be sent as
   * a header value.
   */
  static forRegion(
    regionId: string,
    credentials: TestManagementCredentials,
    options: ZephyrClientOptions = {},
  ): ZephyrScaleClient | null {
    const region = REGIONS.find((r) => r.id === regionId);
    const token = credentials.apiToken.trim();
    if (!region || !TOKEN_CHARACTERS.test(token)) return null;
    return new ZephyrScaleClient(
      region.baseUrl,
      region.id,
      region.label,
      token,
      options.timeoutMs ?? ZEPHYR_REQUEST_TIMEOUT_MS,
      options.signal,
    );
  }

  /** The signal of one request: its own budget, and the caller's signal when there is one. */
  private requestSignal(): AbortSignal {
    const own = AbortSignal.timeout(this.timeoutMs);
    return this.signal ? AbortSignal.any([own, this.signal]) : own;
  }

  private async get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    const timedOut = () =>
      new ZephyrScaleError(
        ZEPHYR_TIMEOUT_STATUS,
        `Zephyr Scale did not answer within ${this.timeoutMs / 1000} seconds`,
      );
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}?${query}`, {
        headers: { Authorization: `Bearer ${this.apiToken}`, Accept: 'application/json' },
        signal: this.requestSignal(),
      });
    } catch (err) {
      if (isTimeout(err)) throw timedOut();
      throw err;
    }
    if (!response.ok) throw await toZephyrError(response, this.apiToken);
    try {
      return (await response.json()) as T;
    } catch (err) {
      // The same budget covers the body: a stall while it is read is a timeout, not a body that is not JSON.
      if (isTimeout(err)) throw timedOut();
      throw new ZephyrScaleError(502, 'Zephyr Scale answered with something that is not JSON');
    }
  }

  /** One page of a paged list; an answer without its `values` is an error, not an empty page. */
  private async getPage<T>(path: string, params: Record<string, string | number>): Promise<PagedBody<T>> {
    const body = await this.get<PagedBody<T>>(path, params);
    if (!body || !Array.isArray(body.values)) {
      throw new ZephyrScaleError(502, `Zephyr Scale answered ${path} with an unexpected shape`);
    }
    return body;
  }

  /** Every item of a list, page by page, up to {@link ZEPHYR_MAX_PAGES} pages. */
  private async getAll<T>(path: string, params: Record<string, string | number>): Promise<T[]> {
    const items: T[] = [];
    let startAt = 0;
    for (let page = 0; page < ZEPHYR_MAX_PAGES; page++) {
      const body = await this.getPage<T>(path, { ...params, maxResults: PAGE_SIZE, startAt });
      items.push(...body.values);
      if (isLastPage(body, startAt)) return items;
      startAt += body.values.length;
    }
    throw new ZephyrScaleError(502, `Zephyr Scale listed more than ${ZEPHYR_MAX_PAGES} pages of ${path}`);
  }

  /** Zephyr has no "who am I": one project read proves the token and region work. */
  async whoAmI(): Promise<{ id: string; displayName: string }> {
    await this.getPage<ZephyrProject>('/projects', { maxResults: 1 });
    return { id: `zephyr-scale:${this.regionId}`, displayName: `Zephyr Scale Cloud (${this.regionLabel})` };
  }

  async listProjects(): Promise<TmProject[]> {
    const projects = await this.getAll<ZephyrProject>('/projects', {});
    return projects.map((p) => ({ id: String(p.id), key: p.key, enabled: p.enabled }));
  }

  /** The names of a project's test case statuses by ID: one call, however many cases a page holds. */
  private async caseStatusNames(projectKey: string): Promise<Map<number, string>> {
    const statuses = await this.getAll<ZephyrStatus>('/statuses', { projectKey, statusType: 'TEST_CASE' });
    return new Map(statuses.map((s) => [s.id, s.name]));
  }

  async listCases(projectKey: string, page: PageCursor): Promise<TmPage<TmCase>> {
    const key = checkedProjectKey(projectKey);
    const startAt = startAtOf(page);
    const body = await this.getPage<ZephyrTestCase>('/testcases', { projectKey: key, maxResults: PAGE_SIZE, startAt });
    const statusNames = await this.caseStatusNames(key);
    return {
      items: body.values.map((c) => ({
        id: String(c.id),
        key: c.key,
        name: c.name,
        status: (c.status && statusNames.get(c.status.id)) ?? null,
        folderId: c.folder ? String(c.folder.id) : null,
      })),
      next: isLastPage(body, startAt) ? null : String(startAt + body.values.length),
    };
  }

  async listStatuses(projectKey: string): Promise<TmStatus[]> {
    const statuses = await this.getAll<ZephyrStatus>('/statuses', {
      projectKey: checkedProjectKey(projectKey),
      statusType: 'TEST_EXECUTION',
    });
    return statuses
      .filter((s) => s.archived !== true)
      .map((s) => ({ id: String(s.id), name: s.name, isDefault: s.default === true }));
  }

  /** Zephyr documents no web address for a test case: it opens inside a Jira site this connection does not know. */
  caseUrl(): null {
    return null;
  }
}
