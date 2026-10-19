import {
  DESKTOP_CHALLENGE_HEADER,
  DESKTOP_PROOF_HEADER,
  desktopTokenProof,
  newDesktopChallenge,
} from '@piwitests/core/desktop-proof';
import type { EditorPairing, EditorSendPayload } from '@piwitests/core/editor-send';
import type { TestFunctionEntry } from '@piwitests/core/function-match';
import type { LocatorIndex } from '@piwitests/core/locator-index';
import { getInstanceApiKey, type ConnectionSettings, type ServerPatternsAnswer } from './connection-settings.js';
import type { ClientInfo } from './client-info.js';
import type { ConnectPoll } from './connect-flow.js';
import type { DesktopSettings } from './desktop-settings.js';
import type { PiwiSteps } from '@piwitests/core/steps';
import { bugReportUrl, normalizeBaseUrl } from './instance-links.js';
import { t } from './i18n.js';

/**
 * Talks to a Piwi instance, and to the desktop app and the editor Piwi Picker
 * is paired with — the only place in this extension that makes a network call.
 * Called from the options page (connecting, saving, reading and adding URL
 * patterns, pairing the desktop app) and the background service worker
 * (`piwi-refresh-catalog`, `piwi-refresh-locator-index`, `piwi-send-to-editor`,
 * the bug-report messages: `piwi-bug-send-target`, `piwi-send-bug-report` once
 * the reporter has confirmed the preview, `piwi-list-bug-reports`,
 * `piwi-get-bug-report`, `piwi-replay-step-view` and `piwi-share-reproduction`,
 * and the desktop app's: `piwi-desktop-repro` once the developer confirmed its
 * preview, and `piwi-desktop-repro-status`) only,
 * never from a content script, so the API key is never reachable from a web
 * page's JS context (matches `extension/AGENTS.md`'s standalone stance:
 * connected mode is opt-in and clearly separated). The key is read here from
 * the secret area (`getInstanceApiKey`), and only for the origin it was given
 * for; no request follows a redirect, so neither it nor the desktop app's token
 * goes anywhere but the address asked.
 *
 * These requests need a host permission for the instance's origin: the
 * dashboard API sends no CORS headers, and `X-API-Key` makes them non-simple
 * so the browser preflights them. The options page requests that permission
 * inside its own click handler — the worker has no user gesture to do so.
 */

export interface ProjectOption {
  id: number;
  name: string;
  label: string | null;
}

/** The list a dashboard list endpoint answers: `{ items }`, or a bare array. */
function listItems<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const items = (body as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

/** The key header for the instance `settings` names: the key given for that origin, or `apiKey` when one is passed. */
async function authHeaders(settings: ConnectionSettings, apiKey?: string): Promise<Record<string, string>> {
  const key = (apiKey ?? (await getInstanceApiKey(settings.instanceUrl))).trim();
  return key ? { 'X-API-Key': key } : {};
}

/** `fetch` that refuses a redirect rather than following it with the request's headers. */
function request(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: 'error' });
}

/**
 * How long to wait on an instance before giving up.
 *
 * Every call here is either something the user is watching (the options page's
 * Connect, or Save and test) or a background revalidation whose caller has
 * already rendered from cache. Neither has anything to gain from waiting indefinitely,
 * and an unresponsive host — a stale URL, a VPN-only address, a hung server —
 * would leave the options page's status stuck on "Testing…" with no way
 * forward but a reload.
 */
const REQUEST_TIMEOUT_MS = 10_000;

function timeout(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

/**
 * The JSON an instance answered. Anything else (a sign-in page in front of the
 * instance, another site at that address) throws a message saying so.
 */
async function instanceJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    throw new Error(err instanceof SyntaxError ? t('common_instanceNotPiwi') : t('common_instanceUnreachable'));
  }
}

/**
 * Why a request to `url` got no answer: a redirect, which no request here
 * follows, told apart by asking again without the key and without following
 * it; else the instance is out of reach.
 */
async function unreachableReason(err: unknown, url: string): Promise<string> {
  if (err instanceof TypeError) {
    const probe = await fetch(url, { redirect: 'manual', signal: timeout() }).catch(() => null);
    if (probe?.type === 'opaqueredirect') return t('common_instanceRedirects');
  }
  return t('common_instanceUnreachable');
}

export type ConnectionCheckResult = { ok: true } | { ok: false; error: string };

/**
 * Hits `/api/projects/menu` — cheap, always available, and exercises auth the
 * same way the rest of the client does. `apiKey` is a key typed and not kept
 * yet; without it, the kept one is sent.
 */
export async function testConnection(settings: ConnectionSettings, apiKey?: string): Promise<ConnectionCheckResult> {
  if (!settings.instanceUrl.trim()) return { ok: false, error: t('common_enterInstanceUrl') };
  const url = `${normalizeBaseUrl(settings.instanceUrl)}/api/projects/menu`;
  let res: Response;
  try {
    res = await request(url, { headers: await authHeaders(settings, apiKey), signal: timeout() });
  } catch (err) {
    return { ok: false, error: await unreachableReason(err, url) };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: t('common_apiKeyRejected') };
  if (!res.ok) return { ok: false, error: t('common_instanceStatus', { status: res.status }) };
  try {
    await instanceJson(res);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function fetchProjects(settings: ConnectionSettings): Promise<ProjectOption[]> {
  if (!settings.instanceUrl.trim()) return [];
  const res = await request(`${normalizeBaseUrl(settings.instanceUrl)}/api/projects/menu`, {
    headers: await authHeaders(settings),
    signal: timeout(),
  });
  if (!res.ok) throw new Error(t('common_projectsFailed', { status: res.status }));
  return listItems<ProjectOption>(await instanceJson(res));
}

/**
 * One project's function catalog, ready to hand to
 * `rankFunctionMatches`/`matchFunctionAt`/`renderSpec`. A connection maps
 * many projects (`ConnectionSettings.projectMappings`), so the caller names
 * one: the options page once per mapped project, the background worker the
 * project a panel asks about.
 */
export async function fetchCatalog(settings: ConnectionSettings, projectId: number): Promise<TestFunctionEntry[]> {
  if (!settings.instanceUrl.trim()) return [];
  let res: Response;
  try {
    res = await request(`${normalizeBaseUrl(settings.instanceUrl)}/api/projects/${projectId}/test-functions`, {
      headers: await authHeaders(settings),
      signal: timeout(),
    });
  } catch {
    throw new Error(t('common_instanceUnreachable'));
  }
  if (!res.ok) throw new Error(t('common_catalogFailed', { status: res.status }));
  const body = (await instanceJson(res)) as { testFunctions?: unknown } | null;
  const rows = listItems<{ entry: TestFunctionEntry }>(Array.isArray(body?.testFunctions) ? body.testFunctions : body);
  return rows.map((row) => row?.entry).filter(Boolean);
}

/**
 * How long the locator index may take: it carries every chain a project's
 * tests used, so it is larger than the other responses. Still bounded — the
 * caller has already rendered whatever was cached.
 */
const LOCATOR_INDEX_TIMEOUT_MS = 30_000;

/**
 * One project's locator index: every chain its tests used, with the tests that
 * use it, as seen on `branch` (null for the default branch, `*` for every
 * branch). An instance older than branch support answers one index mixing
 * every branch, read as such.
 */
export async function fetchLocatorIndex(
  settings: ConnectionSettings,
  projectId: number,
  branch: string | null = null,
): Promise<LocatorIndex> {
  if (!settings.instanceUrl.trim()) throw new Error(t('common_notConnected'));
  const query = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  let res: Response;
  try {
    res = await request(`${normalizeBaseUrl(settings.instanceUrl)}/api/projects/${projectId}/locator-index${query}`, {
      headers: await authHeaders(settings),
      signal: AbortSignal.timeout(LOCATOR_INDEX_TIMEOUT_MS),
    });
  } catch {
    throw new Error(t('common_instanceUnreachable'));
  }
  if (res.status === 401 || res.status === 403) throw new Error(t('common_projectKeyRejected'));
  if (res.status === 404) throw new Error(t('common_noLocatorIndex'));
  if (!res.ok) throw new Error(t('common_locatorIndexStatus', { status: res.status }));
  const body = (await instanceJson(res)) as LocatorIndex | null;
  const wellFormed =
    !!body &&
    Array.isArray(body.locators) &&
    Array.isArray(body.tests) &&
    body.locators.every((entry) => !!entry && typeof entry === 'object' && Array.isArray(entry.uses));
  if (!wellFormed) throw new Error(t('common_locatorIndexInvalid'));
  const defaultBranch = typeof body.defaultBranch === 'string' ? body.defaultBranch : '';
  return {
    ...body,
    branch: typeof body.branch === 'string' ? body.branch : null,
    defaultBranch,
    branches: Array.isArray(body.branches) ? body.branches : [],
    locators: body.locators.map((entry) => ({
      ...entry,
      uses: entry.uses.map((use) => ({ ...use, branches: Array.isArray(use?.branches) ? use.branches : [] })),
    })),
  };
}

/** What `POST /api/extension/connect` answers: the codes of a new connect request. */
export interface ConnectStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeout(),
  });
}

/**
 * Starts connecting: the instance answers the code to show and the page where
 * the user allows it. Throws a message to show when it cannot.
 */
export async function startConnect(instanceUrl: string, client: ClientInfo): Promise<ConnectStart> {
  if (!instanceUrl.trim()) throw new Error(t('common_enterInstanceUrl'));
  const url = `${normalizeBaseUrl(instanceUrl)}/api/extension/connect`;
  let res: Response;
  try {
    res = await postJson(url, client);
  } catch (err) {
    throw new Error(await unreachableReason(err, url));
  }
  if (res.status === 404 || res.status === 405) throw new Error(t('options_connectUnsupported'));
  if (res.status === 429) throw new Error(t('options_connectTooMany'));
  if (!res.ok) throw new Error(t('common_instanceStatus', { status: res.status }));
  const body = ((await instanceJson(res)) ?? {}) as Partial<ConnectStart>;
  if (
    typeof body.deviceCode !== 'string' ||
    typeof body.userCode !== 'string' ||
    typeof body.verificationUrl !== 'string' ||
    !/^https?:\/\//i.test(body.verificationUrl)
  ) {
    throw new Error(t('options_connectUnsupported'));
  }
  return {
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    verificationUrl: body.verificationUrl,
    interval: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
    expiresIn: typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn : 600,
  };
}

/** One poll of a connect request. Throws on a network error or an unexpected answer, which the caller retries. */
export async function pollConnect(instanceUrl: string, deviceCode: string): Promise<ConnectPoll> {
  const res = await postJson(`${normalizeBaseUrl(instanceUrl)}/api/extension/connect/token`, { deviceCode });
  if (res.status === 429) return { status: 'slow_down', interval: 30 };
  if (!res.ok) throw new Error(t('common_instanceStatus', { status: res.status }));
  const body = ((await instanceJson(res)) ?? {}) as {
    status?: unknown;
    interval?: unknown;
    apiKey?: unknown;
    user?: unknown;
  };
  switch (body.status) {
    case 'pending':
    case 'denied':
    case 'expired':
      return { status: body.status };
    case 'slow_down':
      return { status: 'slow_down', interval: typeof body.interval === 'number' ? body.interval : 10 };
    case 'approved': {
      const name = (body.user as { name?: unknown } | null)?.name;
      return {
        status: 'approved',
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
        user: typeof name === 'string' ? { name } : null,
      };
    }
    default:
      throw new Error(t('options_connectUnsupported'));
  }
}

/** Every URL pattern of the projects the key's user can see, with those projects and the user's name. */
export async function fetchServerPatterns(settings: ConnectionSettings): Promise<ServerPatternsAnswer> {
  if (!settings.instanceUrl.trim()) throw new Error(t('common_enterInstanceUrl'));
  let res: Response;
  try {
    res = await request(`${normalizeBaseUrl(settings.instanceUrl)}/api/extension/url-patterns`, {
      headers: await authHeaders(settings),
      signal: timeout(),
    });
  } catch {
    throw new Error(t('common_instanceUnreachable'));
  }
  if (res.status === 401 || res.status === 403) throw new Error(t('common_apiKeyRejected'));
  if (res.status === 404) throw new Error(t('options_serverUnsupported'));
  if (!res.ok) throw new Error(t('common_instanceStatus', { status: res.status }));
  const body = ((await instanceJson(res)) ?? {}) as Partial<ServerPatternsAnswer>;
  return {
    user: body.user && typeof body.user.name === 'string' ? { name: body.user.name } : null,
    items: Array.isArray(body.items) ? body.items : [],
    projects: Array.isArray(body.projects) ? body.projects : [],
  };
}

/** Adds a URL pattern to a project on the instance. Throws a message to show when it cannot. */
export async function addServerPattern(
  settings: ConnectionSettings,
  projectId: number,
  input: {
    pattern: string;
    environment?: string | null;
    branch?: string | null;
    pathPrefix?: string | null;
    testPathPrefix?: string | null;
  },
): Promise<void> {
  let res: Response;
  try {
    res = await request(`${normalizeBaseUrl(settings.instanceUrl)}/api/projects/${projectId}/url-patterns`, {
      method: 'POST',
      headers: { ...(await authHeaders(settings)), 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: timeout(),
    });
  } catch {
    throw new Error(t('common_instanceUnreachable'));
  }
  if (res.ok) return;
  if (res.status === 401) throw new Error(t('common_apiKeyRejected'));
  if (res.status === 403) throw new Error(t('options_addForbidden'));
  if (res.status === 409) throw new Error(t('options_addDuplicate'));
  if (res.status === 400) throw new Error(t('options_addInvalid'));
  throw new Error(t('common_instanceStatus', { status: res.status }));
}

/**
 * Post a locator or a recording to the paired editor, on this computer's
 * loopback interface; the editor inserts it at its cursor. Needs the host
 * permission for the editor's origin, requested when pairing.
 */
export async function postToEditor(
  pairing: EditorPairing,
  payload: EditorSendPayload,
): Promise<{ ok: true; file: string | null } | { ok: false; error: string }> {
  try {
    const res = await request(pairing.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: timeout(),
    });
    const body = (await res.json().catch(() => null)) as { file?: string | null; error?: string } | null;
    if (!res.ok) return { ok: false, error: body?.error ?? String(res.status) };
    return { ok: true, file: body?.file ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** What Send to Piwi sends: the report as JSON, the language it is written in, and its PNG screenshots. */
export interface BugReportSend {
  report: unknown;
  language: string | null;
  /** Ask for an issue in the project's tracker. */
  createIssue: boolean;
  screenshots: Array<{ name: string; bytes: Uint8Array }>;
  /** The screenshot of each step, as JPEGs named as `evidence.stepShots` names them (`002.jpg`). */
  stepShots?: Array<{ name: string; bytes: Uint8Array }>;
}

/** The multipart parts of a bug report, as the instance reads them. */
const BUG_REPORT_PARTS = {
  report: 'report',
  language: 'language',
  createIssue: 'createIssue',
  screenshot: 'screenshot',
  stepShot: 'stepShot',
} as const;

/** Why the instance answered a request the way it did, as a sentence to show. */
async function refusal(res: Response): Promise<string> {
  if (res.status === 401) return t('common_apiKeyRejected');
  if (res.status === 403) return t('common_sendForbidden');
  if (res.status === 404) return t('common_bugReportsUnsupported');
  if (res.status === 413) return t('common_sendTooLarge');
  if (res.status === 400) {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === 'string' ? body.message.slice(0, 300) : String(res.status);
    return t('common_sendRefused', { error: message });
  }
  return t('common_instanceStatus', { status: res.status });
}

/**
 * Sends a bug report to a project (`POST /api/projects/:id/bug-reports`, multipart).
 * Only the background worker calls it, after the reporter confirmed the preview.
 */
export async function sendBugReport(
  settings: ConnectionSettings,
  projectId: number,
  send: BugReportSend,
): Promise<{ id: number; url: string; issue: SentIssue | null }> {
  const form = new FormData();
  form.append(BUG_REPORT_PARTS.report, JSON.stringify(send.report));
  if (send.language) form.append(BUG_REPORT_PARTS.language, send.language);
  if (send.createIssue) form.append(BUG_REPORT_PARTS.createIssue, String(true));
  for (const shot of send.screenshots) {
    form.append(BUG_REPORT_PARTS.screenshot, new Blob([shot.bytes as BlobPart], { type: 'image/png' }), shot.name);
  }
  for (const shot of send.stepShots ?? []) {
    form.append(BUG_REPORT_PARTS.stepShot, new Blob([shot.bytes as BlobPart], { type: 'image/jpeg' }), shot.name);
  }
  let res: Response;
  try {
    res = await request(`${normalizeBaseUrl(settings.instanceUrl)}/api/projects/${projectId}/bug-reports`, {
      method: 'POST',
      headers: await authHeaders(settings),
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error(t('common_instanceUnreachable'));
  }
  if (!res.ok) throw new Error(await refusal(res));
  const body = ((await instanceJson(res)) ?? {}) as {
    id?: unknown;
    issue?: { status?: unknown; key?: unknown } | null;
  };
  if (typeof body.id !== 'number') throw new Error(t('common_instanceStatus', { status: res.status }));
  const issue =
    body.issue && typeof body.issue.status === 'string'
      ? { status: body.issue.status, key: typeof body.issue.key === 'string' ? body.issue.key : null }
      : null;
  return { id: body.id, url: bugReportUrl(settings.instanceUrl, body.id), issue };
}

/** What became of the issue a send asked for: created (with its key), queued, or refused. */
export interface SentIssue {
  status: string;
  key: string | null;
}

/** What a send to a project will do with its tracker (`GET /api/projects/:id/bug-reports/intake`). */
export interface BugReportIntake {
  tracker: 'jira' | null;
  projectKey: string | null;
  canCreate: boolean;
  fileEvery: boolean;
  /** How many step screenshots a send may carry; 0 from an instance that takes none. */
  stepShots: number;
}

/** The intake, or no tracker when the instance cannot say (an older one, or unreachable). */
export async function fetchBugReportIntake(settings: ConnectionSettings, projectId: number): Promise<BugReportIntake> {
  const none: BugReportIntake = { tracker: null, projectKey: null, canCreate: false, fileEvery: false, stepShots: 0 };
  try {
    const res = await request(
      `${normalizeBaseUrl(settings.instanceUrl)}/api/projects/${projectId}/bug-reports/intake`,
      {
        headers: await authHeaders(settings),
        signal: timeout(),
      },
    );
    if (!res.ok) return none;
    const body = (await res.json()) as Partial<BugReportIntake>;
    return {
      tracker: body.tracker === 'jira' ? 'jira' : null,
      projectKey: typeof body.projectKey === 'string' ? body.projectKey : null,
      canCreate: body.canCreate === true,
      fileEvery: body.fileEvery === true,
      stepShots: Number.isInteger(body.stepShots) && (body.stepShots as number) > 0 ? (body.stepShots as number) : 0,
    };
  } catch {
    return none;
  }
}

/** One of a project's bug reports, as Replay lists them. */
export interface BugReportSummary {
  id: number;
  title: string;
  status: string;
  path: string | null;
}

/** A project's bug reports that are still to be fixed: open, test committed, or looking fixed. */
export async function fetchBugReports(settings: ConnectionSettings, projectId: number): Promise<BugReportSummary[]> {
  let res: Response;
  try {
    res = await request(`${normalizeBaseUrl(settings.instanceUrl)}/api/projects/${projectId}/bug-reports`, {
      headers: await authHeaders(settings),
      signal: timeout(),
    });
  } catch {
    throw new Error(t('common_instanceUnreachable'));
  }
  if (!res.ok) throw new Error(await refusal(res));
  return listItems<BugReportSummary>(await instanceJson(res)).filter(
    (r) => typeof r?.id === 'number' && r.status !== 'closed' && r.status !== 'dismissed',
  );
}

/** A bug report's steps document, with the report's title, for Replay, and the project the report belongs to. */
export async function fetchBugReportSteps(
  settings: ConnectionSettings,
  id: number,
): Promise<{ steps: unknown; projectId: number | null }> {
  let res: Response;
  try {
    res = await request(`${normalizeBaseUrl(settings.instanceUrl)}/api/bug-reports/${id}`, {
      headers: await authHeaders(settings),
      signal: timeout(),
    });
  } catch {
    throw new Error(t('common_instanceUnreachable'));
  }
  if (!res.ok) throw new Error(await refusal(res));
  const body = ((await instanceJson(res)) ?? {}) as { title?: unknown; steps?: unknown; projectId?: unknown };
  return {
    steps: { ...(body.steps as object), title: typeof body.title === 'string' ? body.title : null },
    projectId: typeof body.projectId === 'number' ? body.projectId : null,
  };
}

/**
 * The screenshot of one step of a report on the instance, with where its
 * element was and the viewport it shows: its entry in the report's
 * `evidence.stepShots`, and the JPEG. Null when the report has none for that
 * step, or the instance keeps no step screenshots.
 */
export async function fetchBugReportStepShot(
  settings: ConnectionSettings,
  id: number,
  step: number,
): Promise<{
  dataUrl: string;
  box: { x: number; y: number; width: number; height: number } | null;
  viewport: { width: number; height: number } | null;
} | null> {
  const base = normalizeBaseUrl(settings.instanceUrl);
  try {
    const detail = await request(`${base}/api/bug-reports/${id}`, {
      headers: await authHeaders(settings),
      signal: timeout(),
    });
    if (!detail.ok) return null;
    const body = (await detail.json()) as {
      evidence?: { stepShots?: Array<{ step?: unknown; box?: unknown; viewport?: unknown }> };
    };
    const shot = body.evidence?.stepShots?.find((s) => s.step === step);
    if (!shot) return null;
    const image = await request(`${base}/api/bug-reports/${id}/step-shots/${step}`, {
      headers: await authHeaders(settings),
      signal: timeout(),
    });
    if (!image.ok || image.headers.get('content-type') !== 'image/jpeg') return null;
    const bytes = new Uint8Array(await image.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return {
      dataUrl: `data:image/jpeg;base64,${btoa(binary)}`,
      box: (shot.box as { x: number; y: number; width: number; height: number } | null) ?? null,
      viewport: (shot.viewport as { width: number; height: number } | null) ?? null,
    };
  } catch {
    return null;
  }
}

/** A reproduction of a report, as Share result sends it. */
export interface ReproductionSend {
  source: 'replay' | 'desktop';
  verdict: 'reproduced' | 'not-reproduced' | 'diverged';
  divergedAt: number | null;
  origin: string | null;
  userAgent: string | null;
}

/** Records a reproduction on a report (`POST /api/bug-reports/:id/reproductions`), after the developer's click. */
export async function sendReproduction(
  settings: ConnectionSettings,
  id: number,
  send: ReproductionSend,
): Promise<void> {
  let res: Response;
  try {
    res = await request(`${normalizeBaseUrl(settings.instanceUrl)}/api/bug-reports/${id}/reproductions`, {
      method: 'POST',
      headers: { ...(await authHeaders(settings)), 'Content-Type': 'application/json' },
      body: JSON.stringify(send),
      signal: timeout(),
    });
  } catch {
    throw new Error(t('common_instanceUnreachable'));
  }
  if (!res.ok) throw new Error(await refusal(res));
}

// ---------------------------------------------------------------------------
// The paired desktop app

function desktopHeaders(desktop: DesktopSettings): Record<string, string> {
  return { 'x-piwi-token': desktop.token };
}

/** The JSON the desktop app answered; anything else is not the app. */
async function desktopJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new Error(t('common_desktopUnsupported'));
  }
}

function desktopRefusal(res: Response): string {
  if (res.status === 401) return t('common_desktopRejected');
  if (res.status === 404) return t('common_desktopUnsupported');
  return t('common_desktopStatus', { status: res.status });
}

/**
 * Throws a message to show unless the program at the paired address proves it
 * holds the paired token (`@piwitests/core/desktop-proof`): `/api/health`
 * answers a new random challenge with a proof bound to the address's port.
 * Called before every request that carries the token, so an app that moved to
 * another port, or another program that took this one, never receives it.
 */
async function proveDesktop(desktop: DesktopSettings): Promise<void> {
  const challenge = newDesktopChallenge();
  let res: Response;
  try {
    res = await request(`${desktop.url}/api/health`, {
      headers: { [DESKTOP_CHALLENGE_HEADER]: challenge },
      signal: timeout(),
    });
  } catch {
    throw new Error(t('common_desktopUnreachable'));
  }
  const proof = res.headers.get(DESKTOP_PROOF_HEADER);
  const port = Number(new URL(desktop.url).port || 80);
  if (!proof || proof !== (await desktopTokenProof(desktop.token, port, challenge))) {
    throw new Error(t('common_desktopNotProven'));
  }
}

/**
 * Checks the pairing: the app proves it holds the token, then
 * `GET /api/desktop/reporter-config` answers only with the app's token.
 */
export async function testDesktop(desktop: DesktopSettings): Promise<ConnectionCheckResult> {
  try {
    await proveDesktop(desktop);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    const res = await request(`${desktop.url}/api/desktop/reporter-config`, {
      headers: desktopHeaders(desktop),
      signal: timeout(),
    });
    return res.ok ? { ok: true } : { ok: false, error: desktopRefusal(res) };
  } catch {
    return { ok: false, error: t('common_desktopUnreachable') };
  }
}

/** A pairing the desktop app started: the code both sides show, and the secret only this extension polls with. */
export interface DesktopPairingStart {
  id: string;
  secret: string;
  code: string;
  interval: number;
  expiresIn: number;
  /** False when no window of the app is open to show the request. */
  windowOpen: boolean;
}

/**
 * Asks the desktop app at `url` to pair: its window shows the request with the
 * code this answers. Throws a message to show when it cannot.
 */
export async function startDesktopPairing(url: string, client: ClientInfo): Promise<DesktopPairingStart> {
  let res: Response;
  try {
    res = await postJson(`${url}/api/desktop/picker-pairings`, client);
  } catch {
    throw new Error(t('options_desktopPairUnreachable', { url }));
  }
  if (res.status === 429) throw new Error(t('options_desktopPairTooMany'));
  if (!res.ok) throw new Error(t('options_desktopPairUnsupported', { url }));
  const body = (await res.json().catch(() => ({}))) as Partial<DesktopPairingStart>;
  if (
    typeof body.id !== 'string' ||
    !/^[0-9a-f]{16}$/.test(body.id) ||
    typeof body.secret !== 'string' ||
    typeof body.code !== 'string'
  ) {
    throw new Error(t('options_desktopPairUnsupported', { url }));
  }
  return {
    id: body.id,
    secret: body.secret,
    code: body.code,
    interval: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 2,
    expiresIn: typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn : 300,
    windowOpen: body.windowOpen !== false,
  };
}

/**
 * One poll of a pairing, in the shape the connect flow waits on: `approved`
 * carries the app's token as `apiKey`. Throws on a network error or an
 * unexpected answer, which the caller retries.
 */
export async function pollDesktopPairing(url: string, pairing: DesktopPairingStart): Promise<ConnectPoll> {
  const res = await request(`${url}/api/desktop/picker-pairings/${pairing.id}`, {
    headers: { 'x-pairing-secret': pairing.secret },
    signal: timeout(),
  });
  // Gone: the app restarted and lost it, as good as expired.
  if (res.status === 404) return { status: 'expired' };
  if (!res.ok) throw new Error(t('common_desktopStatus', { status: res.status }));
  const body = ((await desktopJson(res)) ?? {}) as { status?: unknown; token?: unknown };
  switch (body.status) {
    case 'waiting':
      return { status: 'pending' };
    case 'denied':
      return { status: 'denied' };
    case 'expired':
    case 'claimed':
      return { status: 'expired' };
    case 'allowed':
      if (typeof body.token !== 'string' || !body.token) throw new Error(t('options_desktopPairUnsupported', { url }));
      return { status: 'approved', apiKey: body.token, user: null };
    default:
      throw new Error(t('options_desktopPairUnsupported', { url }));
  }
}

export interface ReproRequestSend {
  steps: PiwiSteps;
  title: string | null;
  options: { headed: boolean; trace: boolean };
  bugReportId: number | null;
  instanceUrl: string | null;
}

/** Asks the desktop app to run steps with Playwright; the developer confirms it in the app's window. */
export async function sendReproRequest(
  desktop: DesktopSettings,
  send: ReproRequestSend,
): Promise<{ id: string; windowOpen: boolean }> {
  await proveDesktop(desktop);
  let res: Response;
  try {
    res = await request(`${desktop.url}/api/desktop/repro-requests`, {
      method: 'POST',
      headers: { ...desktopHeaders(desktop), 'Content-Type': 'application/json' },
      body: JSON.stringify(send),
      signal: timeout(),
    });
  } catch {
    throw new Error(t('common_desktopUnreachable'));
  }
  if (!res.ok) throw new Error(desktopRefusal(res));
  const body = ((await desktopJson(res)) ?? {}) as { id?: unknown; windowOpen?: unknown };
  if (typeof body.id !== 'string') throw new Error(t('common_desktopStatus', { status: res.status }));
  return { id: body.id, windowOpen: body.windowOpen === true };
}

/** What the desktop app says about a request: its status and, once run, the verdict. */
export interface ReproRequestState {
  status: 'waiting' | 'running' | 'done' | 'declined' | 'expired';
  verdict:
    | { kind: 'reproduced'; step: number; found: string | null }
    | { kind: 'not-reproduced' }
    | { kind: 'diverged'; step: number; reason: string }
    | { kind: 'completed' }
    | { kind: 'stopped' }
    | null;
}

export async function fetchReproRequest(desktop: DesktopSettings, id: string): Promise<ReproRequestState> {
  await proveDesktop(desktop);
  let res: Response;
  try {
    res = await request(`${desktop.url}/api/desktop/repro-requests/${encodeURIComponent(id)}`, {
      headers: desktopHeaders(desktop),
      signal: timeout(),
    });
  } catch {
    throw new Error(t('common_desktopUnreachable'));
  }
  if (res.status === 404) return { status: 'expired', verdict: null };
  if (!res.ok) throw new Error(desktopRefusal(res));
  const body = ((await desktopJson(res)) ?? {}) as Partial<ReproRequestState>;
  return { status: body.status ?? 'expired', verdict: body.verdict ?? null };
}
