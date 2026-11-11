/**
 * Zephyr Scale Cloud client (REST v2, `Authorization: Bearer <token>`). It reads the connection's projects, a
 * project's test cases and the result statuses, uploads a run's results as a new test cycle and links the cycle back
 * to Piwi; the host comes from the connection's region in the registry, never from a typed address.
 */
import { strToU8, zipSync } from 'fflate';
import { INTEGRATION_PROVIDERS } from '#shared/integrations/registry';
import { IntegrationHttpError, parseRetryAfter } from '../http-error';
import type {
  PageCursor,
  TestManagementCredentials,
  TestManagementProvider,
  TmCase,
  TmFolder,
  RunMarker,
  TmPage,
  TmProject,
  TmRun,
  TmStatus,
  UploadRunInput,
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
  /**
   * Awaited before each request is sent, outside its time budget: the hook a per-connection limiter spaces requests
   * with. Left out, requests go at once (the pre-save check has no connection to limit).
   */
  beforeRequest?: () => Promise<void>;
}

/** The largest results file Zephyr accepts. */
export const ZEPHYR_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The most cycles `findRun` reads the name of: one call each. */
const FIND_RUN_MAX_CYCLES = 10;

/** How long before an attempt began an execution may end and still be taken for the attempt's, for clock drift. */
const FIND_RUN_SLACK_MS = 60_000;

/** The most results Zephyr returns in one call. */
const PAGE_SIZE = 1000;

/** The most pages a read of a whole list follows, so a server that never says "last" cannot loop forever. */
export const ZEPHYR_MAX_PAGES = 50;

/** The largest `startAt` the API accepts. */
const MAX_START_AT = 1_000_000;

/** A Jira project key as Zephyr's `projectKey` parameter takes it. */
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

/** A test cycle key as Zephyr issues it. */
const CYCLE_KEY = /^[A-Z][A-Z_0-9]+-R[0-9]+$/;

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

interface ZephyrFolder {
  id: number;
  name: string;
  parentId: number | null;
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

/** A folder or version ID as Zephyr's integer; anything else is refused before the call. */
function numericId(value: string, what: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new ZephyrScaleError(422, `The ${what} ID must be a number`);
  return Number(value);
}

/**
 * Zephyr documents no web address for a test case: it opens inside a Jira site this connection does not know. Kept
 * apart from the client so a read of the stored catalog can ask without a token.
 */
export function zephyrCaseUrl(): null {
  return null;
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
    private readonly beforeRequest: (() => Promise<void>) | undefined,
  ) {}

  /** The case statuses of a project, read once per client: a catalog read asks for them with each page. */
  private readonly caseStatusCache = new Map<string, Promise<Map<number, string>>>();

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
      options.beforeRequest,
    );
  }

  /** The signal of one request: its own budget, and the caller's signal when there is one. */
  private requestSignal(timeoutMs: number): AbortSignal {
    const own = AbortSignal.timeout(timeoutMs);
    return this.signal ? AbortSignal.any([own, this.signal]) : own;
  }

  private timedOut(timeoutMs: number): ZephyrScaleError {
    return new ZephyrScaleError(
      ZEPHYR_TIMEOUT_STATUS,
      `Zephyr Scale did not answer within ${timeoutMs / 1000} seconds`,
    );
  }

  /**
   * One request, after the limiter's wait: the response when it is a success, else the error it maps to. `timeoutMs`
   * is the budget of the request and of reading its body.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number>,
    init: { body?: BodyInit; contentType?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    await this.beforeRequest?.();
    // A wait that used up the budget leaves nothing to send a request with.
    if (this.signal?.aborted) throw this.timedOut(timeoutMs);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiToken}`, Accept: 'application/json' };
    if (init.contentType) headers['Content-Type'] = init.contentType;
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}${query.size ? `?${query}` : ''}`, {
        method,
        headers,
        body: init.body,
        signal: this.requestSignal(timeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) throw this.timedOut(timeoutMs);
      throw err;
    }
    if (!response.ok) throw await toZephyrError(response, this.apiToken);
    return response;
  }

  /** The JSON of a successful response; a stall while the body is read is a timeout. */
  private async readJson<T>(response: Response, timeoutMs: number): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (err) {
      // The same budget covers the body: a stall while it is read is a timeout, not a body that is not JSON.
      if (isTimeout(err)) throw this.timedOut(timeoutMs);
      throw new ZephyrScaleError(502, 'Zephyr Scale answered with something that is not JSON');
    }
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number>,
    timeoutMs: number = this.timeoutMs,
  ): Promise<T> {
    return this.readJson<T>(await this.request('GET', path, params, { timeoutMs }), timeoutMs);
  }

  /** One page of a paged list; an answer without its `values` is an error, not an empty page. */
  private async getPage<T>(
    path: string,
    params: Record<string, string | number>,
    timeoutMs?: number,
  ): Promise<PagedBody<T>> {
    const body = await this.get<PagedBody<T>>(path, params, timeoutMs);
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
  private caseStatusNames(projectKey: string): Promise<Map<number, string>> {
    const cached = this.caseStatusCache.get(projectKey);
    if (cached) return cached;
    const read = this.getAll<ZephyrStatus>('/statuses', { projectKey, statusType: 'TEST_CASE' }).then(
      (statuses) => new Map(statuses.map((s) => [s.id, s.name])),
    );
    this.caseStatusCache.set(projectKey, read);
    // A failed read is not remembered: the next page asks again.
    read.catch(() => this.caseStatusCache.delete(projectKey));
    return read;
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

  /** The test cycle folders of a project: the ones a run is filed under. */
  async listFolders(projectKey: string): Promise<TmFolder[]> {
    const folders = await this.getAll<ZephyrFolder>('/folders', {
      projectKey: checkedProjectKey(projectKey),
      folderType: 'TEST_CYCLE',
    });
    return folders.map((f) => ({
      id: String(f.id),
      name: f.name,
      parentId: f.parentId === null || f.parentId === undefined ? null : String(f.parentId),
    }));
  }

  /**
   * Create a test cycle with every result in one call: the results as Zephyr's custom format in a zip, and the cycle's
   * name and description beside it. Test cases are never created (`autoCreateTestCases=false`): Zephyr cannot delete
   * one. Not idempotent, so a caller that gets no answer must not call again before it knows nothing was created.
   */
  async uploadRun(input: UploadRunInput): Promise<TmRun> {
    const projectKey = checkedProjectKey(input.projectKey);
    const results = JSON.stringify({
      version: 1,
      executions: input.results.map((r) => ({ result: r.status, testCase: { key: r.key } })),
    });
    const zip = zipSync({ 'results.json': strToU8(results) });
    if (zip.byteLength > ZEPHYR_MAX_UPLOAD_BYTES) {
      throw new ZephyrScaleError(
        413,
        `The results are larger than Zephyr Scale accepts (${ZEPHYR_MAX_UPLOAD_BYTES / 1024 / 1024} MB)`,
      );
    }
    const form = new FormData();
    form.append('file', new Blob([zip], { type: 'application/zip' }), 'results.zip');
    form.append(
      'testCycle',
      new Blob(
        [
          JSON.stringify({
            name: input.name,
            description: input.description,
            ...(input.folderId ? { folderId: numericId(input.folderId, 'folder') } : {}),
            ...(input.version ? { jiraProjectVersion: numericId(input.version, 'version') } : {}),
          }),
        ],
        { type: 'application/json' },
      ),
    );
    // The encoded body, not the form, goes to fetch: the request then carries a Content-Length, which the API requires.
    const encoded = new Response(form);
    const response = await this.request(
      'POST',
      '/automations/executions/custom',
      { projectKey, autoCreateTestCases: 'false' },
      {
        body: new Uint8Array(await encoded.arrayBuffer()),
        contentType: encoded.headers.get('content-type') ?? undefined,
      },
    );
    const body = await this.readJson<{ testCycle?: { id?: unknown; key?: unknown; url?: unknown } } | null>(
      response,
      this.timeoutMs,
    );
    const cycle = body?.testCycle;
    if (!cycle || typeof cycle.key !== 'string' || !CYCLE_KEY.test(cycle.key) || cycle.id == null) {
      throw new ZephyrScaleError(502, 'Zephyr Scale answered the upload with an unexpected shape');
    }
    return { key: cycle.key, id: String(cycle.id), url: typeof cycle.url === 'string' ? cycle.url : '' };
  }

  /** Add a web link to a test cycle. */
  async linkRun(run: Pick<TmRun, 'key'>, link: { url: string; title: string }): Promise<void> {
    if (!CYCLE_KEY.test(run.key)) throw new RangeError('Invalid test cycle key');
    await this.request(
      'POST',
      `/testcycles/${run.key}/links/weblinks`,
      {},
      {
        body: JSON.stringify({ url: link.url, description: link.title }),
        contentType: 'application/json',
        timeoutMs: ZEPHYR_INTERACTIVE_TIMEOUT_MS,
      },
    );
  }

  /**
   * The test cycle an earlier upload created, or null when none is found. Zephyr cannot list cycles by name, so this
   * reads the last executions of one test case the run reports on since the attempt began, and the name of each
   * cycle they belong to: the cycle whose name holds `Piwi #<runId>` (or is the name the run was given) is the one.
   */
  async findRun(projectKey: string, marker: RunMarker): Promise<TmRun | null> {
    const since = new Date(Date.parse(marker.startedAt) - FIND_RUN_SLACK_MS);
    if (Number.isNaN(since.getTime())) throw new RangeError('Invalid run marker');
    const executions = await this.getPage<{ testCycle?: { id?: unknown } | null }>(
      '/testexecutions',
      {
        projectKey: checkedProjectKey(projectKey),
        testCase: marker.testCaseKey,
        actualEndDateAfter: `${since.toISOString().slice(0, 19)}Z`,
        onlyLastExecutions: 'true',
        maxResults: PAGE_SIZE,
      },
      ZEPHYR_INTERACTIVE_TIMEOUT_MS,
    );
    const ids = [
      ...new Set(
        executions.values
          .map((execution) => execution.testCycle?.id)
          .filter((id): id is number | string => typeof id === 'number' || typeof id === 'string'),
      ),
    ].slice(0, FIND_RUN_MAX_CYCLES);
    const named = new RegExp(`(?<![\\w#])Piwi #${marker.runId}(?!\\d)`);
    for (const id of ids) {
      const cycle = await this.get<{ id?: unknown; key?: unknown; name?: unknown; links?: { self?: unknown } }>(
        `/testcycles/${encodeURIComponent(String(id))}`,
        {},
        ZEPHYR_INTERACTIVE_TIMEOUT_MS,
      );
      if (typeof cycle.key !== 'string' || !CYCLE_KEY.test(cycle.key) || typeof cycle.name !== 'string') continue;
      if (cycle.name !== marker.name && !named.test(cycle.name)) continue;
      return {
        key: cycle.key,
        id: String(cycle.id ?? id),
        url: typeof cycle.links?.self === 'string' ? cycle.links.self : '',
      };
    }
    return null;
  }

  caseUrl(): null {
    return zephyrCaseUrl();
  }
}
