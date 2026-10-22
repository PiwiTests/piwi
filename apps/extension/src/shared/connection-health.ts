import { t, tNodes, uiLanguage } from './i18n.js';

/**
 * Whether the connected Piwi instance still answers, as the last request to it
 * went: the background worker's catalog, locator index and bug-report requests
 * and the settings page's read of the URL patterns record their outcome here,
 * and the popup and the settings page show it. Kept in `chrome.storage.local`
 * (no secret: an address, an outcome and two times), for the instance it was
 * read from only, so a record of another instance never shows.
 */

export const CONNECTION_HEALTH_KEY = 'piwiConnectionHealth';

/**
 * How a request to the instance went: `ok` when it answered as Piwi with the
 * key accepted, `unauthorized` when it refused the key, `unreachable` when
 * nothing answered, `error` for any other answer.
 */
export type HealthOutcome = 'ok' | 'unauthorized' | 'unreachable' | 'error';

const OUTCOMES: readonly HealthOutcome[] = ['ok', 'unauthorized', 'unreachable', 'error'];

export interface ConnectionHealth {
  /** The instance address the request went to, as `ConnectionSettings.instanceUrl` names it. */
  instanceUrl: string;
  outcome: HealthOutcome;
  /** Epoch ms of the last request. */
  checkedAt: number;
  /** Epoch ms of the first request of the run of `outcome` that ends at `checkedAt`. */
  since: number;
}

export function coerceConnectionHealth(value: unknown): ConnectionHealth | null {
  const v = value as Partial<ConnectionHealth> | null | undefined;
  if (!v || typeof v.instanceUrl !== 'string' || !v.instanceUrl) return null;
  if (!OUTCOMES.includes(v.outcome as HealthOutcome)) return null;
  if (typeof v.checkedAt !== 'number' || !Number.isFinite(v.checkedAt)) return null;
  const since = typeof v.since === 'number' && v.since <= v.checkedAt ? v.since : v.checkedAt;
  return { instanceUrl: v.instanceUrl, outcome: v.outcome as HealthOutcome, checkedAt: v.checkedAt, since };
}

/** The record after a request to `instanceUrl` went as `outcome` at `now`: the run goes on while the outcome repeats. */
export function nextHealth(
  previous: ConnectionHealth | null,
  instanceUrl: string,
  outcome: HealthOutcome,
  now: number,
): ConnectionHealth {
  const sameRun = previous?.instanceUrl === instanceUrl && previous.outcome === outcome;
  return { instanceUrl, outcome, checkedAt: now, since: sameRun ? Math.min(previous.since, now) : now };
}

/** Stands for a placeholder's value in a message, to tell a sentence made from it. */
const HOLE = '\uE000';

/** Whether `message` is `template` with something in place of its {@link HOLE}. */
function fillsIn(message: string, template: string): boolean {
  const [head = '', tail = ''] = template.split(HOLE);
  return message.length >= head.length + tail.length && message.startsWith(head) && message.endsWith(tail);
}

/**
 * The outcome a request's error stands for. `piwi-client.ts` throws a sentence
 * to show, so the outcome is read from which sentence it is. An answer that
 * says the instance works and the key is accepted (no locator index for the
 * project, a role that cannot send there, an instance older than the URL
 * patterns) counts as `ok`.
 */
export function healthOutcome(error: unknown): HealthOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const unreachable = [t('common_instanceUnreachable'), t('common_instanceRedirects'), t('common_desktopUnreachable')];
  if (unreachable.includes(message)) return 'unreachable';
  // The desktop app kept as the instance: the program at its address did not prove it holds the token.
  if (message === t('common_desktopNotProven')) return 'unauthorized';
  const refused = [401, 403].flatMap((status) => [
    t('common_catalogFailed', { status }),
    t('common_instanceStatus', { status }),
    t('common_projectsFailed', { status }),
    t('common_locatorIndexStatus', { status }),
  ]);
  if ([t('common_apiKeyRejected'), t('common_projectKeyRejected'), ...refused].includes(message)) return 'unauthorized';
  const answered = [
    t('common_noLocatorIndex'),
    t('common_sendForbidden'),
    t('common_sendTooLarge'),
    t('options_serverUnsupported'),
  ];
  if (answered.includes(message) || fillsIn(message, t('common_sendRefused', { error: HOLE }))) return 'ok';
  return 'error';
}

export async function getStoredConnectionHealth(): Promise<ConnectionHealth | null> {
  const stored = await chrome.storage.local.get(CONNECTION_HEALTH_KEY);
  return coerceConnectionHealth(stored[CONNECTION_HEALTH_KEY]);
}

/** The last outcome of a request to `instanceUrl`; null before the first, or when the last went to another instance. */
export async function getConnectionHealth(instanceUrl: string): Promise<ConnectionHealth | null> {
  const health = await getStoredConnectionHealth();
  return health && instanceUrl.trim() && health.instanceUrl === instanceUrl ? health : null;
}

/** Records how a request to `instanceUrl` went. Never throws: a request's own answer matters more than its record. */
export async function recordConnectionHealth(
  instanceUrl: string,
  outcome: HealthOutcome,
  now: number = Date.now(),
): Promise<void> {
  if (!instanceUrl.trim()) return;
  try {
    const previous = await getStoredConnectionHealth();
    await chrome.storage.local.set({ [CONNECTION_HEALTH_KEY]: nextHealth(previous, instanceUrl, outcome, now) });
  } catch {
    // Storage unavailable: the request's caller still gets its answer.
  }
}

/**
 * Runs `request` to the instance at `instanceUrl` and records its outcome:
 * `ok` when it resolves, the outcome its error stands for when it throws. The
 * answer or the error is passed on unchanged.
 */
export async function withConnectionHealth<T>(instanceUrl: string, request: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await request();
  } catch (error) {
    await recordConnectionHealth(instanceUrl, healthOutcome(error));
    throw error;
  }
  await recordConnectionHealth(instanceUrl, 'ok');
  return result;
}

export async function clearConnectionHealth(): Promise<void> {
  await chrome.storage.local.remove(CONNECTION_HEALTH_KEY);
}

/** The host of an instance address, `piwi.example.com`; the address itself when it is not one. */
export function instanceHost(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host || instanceUrl;
  } catch {
    return instanceUrl;
  }
}

function locale(): string {
  try {
    return Intl.getCanonicalLocales(uiLanguage())[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/** How long ago `at` was, in the interface language: "just now", "5 minutes ago", "yesterday". */
export function timeAgo(at: number, now: number = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (Math.abs(seconds) < 45) return format.format(0, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, 'hour');
  return format.format(Math.round(hours / 24), 'day');
}

/** A moment as a clock time when it is today, else as a date and a time, in the interface language. */
export function clockTime(at: number, now: number = Date.now()): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
  return new Intl.DateTimeFormat(locale(), options).format(at);
}

/**
 * The line the popup shows under the connection: whether the instance answered, and when. A line about a failure ends
 * with what to do in the settings, drawn by `settings` (a link that opens them), plain text by default.
 */
export function healthSentence(
  health: ConnectionHealth,
  now: number = Date.now(),
  settings: (text: string) => Node | string = (text) => text,
): Array<Node | string> {
  const host = instanceHost(health.instanceUrl);
  const since = clockTime(health.since, now);
  switch (health.outcome) {
    case 'ok':
      return [t('common_healthOk', { host, time: timeAgo(health.checkedAt, now) })];
    case 'unauthorized':
      return tNodes('common_healthUnauthorized', {
        host,
        time: since,
        settings: settings(t('common_healthReconnect')),
      });
    case 'unreachable':
      return tNodes('common_healthUnreachable', { host, time: since, settings: settings(t('common_healthCheck')) });
    default:
      return tNodes('common_healthError', { host, time: since, settings: settings(t('common_healthCheck')) });
  }
}

/** The settings page's pill: a few words, after the instance's address. */
export function healthPill(health: ConnectionHealth, now: number = Date.now()): string {
  switch (health.outcome) {
    case 'ok':
      return t('options_healthOk', { time: timeAgo(health.checkedAt, now) });
    case 'unauthorized':
      return t('options_healthUnauthorized', { time: clockTime(health.since, now) });
    case 'unreachable':
      return t('options_healthUnreachable', { time: clockTime(health.since, now) });
    default:
      return t('options_healthError', { time: clockTime(health.since, now) });
  }
}
