import { parseBugReport } from '@piwitests/core/bug-report';
import { parseSteps, type PiwiSteps } from '@piwitests/core/steps';
import { withConnectionHealth } from '../shared/connection-health.js';
import { getConnectionSettings, type ConnectionSettings } from '../shared/connection-settings.js';
import { getActiveProjectOverride, resolveActiveProject, type ActiveProject } from '../shared/active-project.js';
import {
  fetchBugReportIntake,
  fetchBugReports,
  fetchBugReportSteps,
  sendBugReport,
  sendReproduction,
  type BugReportIntake,
  type BugReportSummary,
  type SentIssue,
} from '../shared/piwi-client.js';
import { getReplayState } from '../shared/replay-storage.js';
import { dataUrlBytes } from '../shared/zip.js';
import { t } from '../shared/i18n.js';
import { desktopRunReports } from './desktop-repro.js';

/**
 * The bug-report requests to the connected instance, made here for the tab's
 * content scripts: they never hold the API key and never reach the network.
 * The project is always resolved again from the sending tab's URL, with the
 * Active project chosen for that tab's site. Each request's outcome is
 * recorded for the popup and the settings (`connection-health.ts`).
 */

/** Set once a report has been sent from this browser profile, so the preview explains sending only the first time. */
const SEND_EXPLAINED_KEY = 'piwiBugSendExplained';

interface Target {
  settings: ConnectionSettings;
  project: ActiveProject | null;
}

async function targetFor(tab: chrome.tabs.Tab | undefined): Promise<Target | null> {
  const settings = await getConnectionSettings();
  if (!settings.instanceUrl.trim()) return null;
  const url = tab?.url ?? '';
  return { settings, project: resolveActiveProject(settings, await getActiveProjectOverride(url), url) };
}

function instanceHost(settings: ConnectionSettings): string {
  try {
    return new URL(settings.instanceUrl).host;
  } catch {
    return settings.instanceUrl;
  }
}

export interface SendTargetAnswer {
  connected: boolean;
  project: { id: number; label: string } | null;
  instance: string | null;
  /** True until a report has been sent from this browser profile. */
  firstSend: boolean;
  /** What the project does with its tracker; null when it files nowhere or the tab maps to no project. */
  intake: BugReportIntake | null;
  /** How many step screenshots the instance takes with a report; 0 when it takes none. */
  stepShots: number;
}

/** Where Send to Piwi would send a report from this tab, for the finish panel and its preview. */
export async function handleBugSendTarget(tab: chrome.tabs.Tab | undefined): Promise<SendTargetAnswer> {
  const target = await targetFor(tab);
  if (!target) return { connected: false, project: null, instance: null, firstSend: false, intake: null, stepShots: 0 };
  const stored = await chrome.storage.local.get(SEND_EXPLAINED_KEY);
  const intake = target.project ? await fetchBugReportIntake(target.settings, target.project.projectId) : null;
  return {
    connected: true,
    project: target.project ? { id: target.project.projectId, label: target.project.projectLabel } : null,
    instance: instanceHost(target.settings),
    firstSend: stored[SEND_EXPLAINED_KEY] !== true,
    intake: intake?.tracker ? intake : null,
    stepShots: intake?.stepShots ?? 0,
  };
}

export type SendBugReportAnswer =
  | { ok: true; id: number; url: string; issue: SentIssue | null }
  | { ok: false; error: string };

/** Sends the report the reporter confirmed in the preview, as it was shown. */
export async function handleSendBugReport(
  message: { report?: unknown; language?: unknown; screenshots?: unknown; stepShots?: unknown; createIssue?: unknown },
  tab: chrome.tabs.Tab | undefined,
): Promise<SendBugReportAnswer> {
  const target = await targetFor(tab);
  if (!target) return { ok: false, error: t('common_notConnected') };
  const project = target.project;
  if (!project) return { ok: false, error: t('bug_sendNoProject') };
  const parsed = parseBugReport(message.report);
  if (!parsed.ok) return { ok: false, error: parsed.errors[0] ?? '' };
  const screenshots = (Array.isArray(message.screenshots) ? message.screenshots : []).flatMap((shot: unknown) => {
    const s = shot as { name?: unknown; dataUrl?: unknown };
    return typeof s.name === 'string' && typeof s.dataUrl === 'string' && s.dataUrl.startsWith('data:image/png;base64,')
      ? [{ name: s.name, bytes: dataUrlBytes(s.dataUrl) }]
      : [];
  });
  const stepShots = (Array.isArray(message.stepShots) ? message.stepShots : []).flatMap((shot: unknown) => {
    const s = shot as { name?: unknown; dataUrl?: unknown };
    return typeof s.name === 'string' &&
      /^\d{3}\.jpg$/.test(s.name) &&
      typeof s.dataUrl === 'string' &&
      s.dataUrl.startsWith('data:image/jpeg;base64,')
      ? [{ name: s.name, bytes: dataUrlBytes(s.dataUrl) }]
      : [];
  });
  try {
    const sent = await withConnectionHealth(target.settings.instanceUrl, () =>
      sendBugReport(target.settings, project.projectId, {
        report: parsed.report,
        language: typeof message.language === 'string' ? message.language : null,
        createIssue: message.createIssue === true,
        screenshots,
        stepShots,
      }),
    );
    await chrome.storage.local.set({ [SEND_EXPLAINED_KEY]: true });
    return { ok: true, ...sent };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type ListBugReportsAnswer =
  | { ok: true; project: { id: number; label: string } | null; items: BugReportSummary[] }
  | { ok: false; error: string };

/** The bug reports of the project this tab maps to, for Replay's chooser. */
export async function handleListBugReports(tab: chrome.tabs.Tab | undefined): Promise<ListBugReportsAnswer> {
  const target = await targetFor(tab);
  if (!target || !target.project) return { ok: true, project: null, items: [] };
  try {
    const project = target.project;
    const items = await withConnectionHealth(target.settings.instanceUrl, () =>
      fetchBugReports(target.settings, project.projectId),
    );
    return { ok: true, project: { id: target.project.projectId, label: target.project.projectLabel }, items };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type GetBugReportAnswer = { ok: true; steps: PiwiSteps } | { ok: false; error: string };

/** One report of the project this tab maps to, its steps checked like a steps file from anywhere else. */
export async function handleGetBugReport(id: unknown, tab: chrome.tabs.Tab | undefined): Promise<GetBugReportAnswer> {
  const target = await targetFor(tab);
  if (!target) return { ok: false, error: t('common_notConnected') };
  if (typeof id !== 'number' || !Number.isInteger(id) || !target.project) {
    return { ok: false, error: t('common_noProject') };
  }
  try {
    const report = await withConnectionHealth(target.settings.instanceUrl, () =>
      fetchBugReportSteps(target.settings, id),
    );
    if (report.projectId !== target.project.projectId) return { ok: false, error: t('common_noProject') };
    const parsed = parseSteps(report.steps);
    if (!parsed.ok) return { ok: false, error: t('common_replayNotSteps', { error: parsed.errors[0] ?? '' }) };
    return { ok: true, steps: parsed.steps };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Where Share result would send a verdict: the connected instance's host, or null. */
export async function handleShareTarget(): Promise<{ instance: string | null }> {
  const settings = await getConnectionSettings();
  return { instance: settings.instanceUrl.trim() ? instanceHost(settings) : null };
}

export type ShareReproductionAnswer = { ok: true } | { ok: false; error: string };

const SHARED_VERDICTS = ['reproduced', 'not-reproduced', 'diverged'] as const;

/**
 * The report a verdict is shared on, when this worker played it: the stored
 * replay's report, or one it sent to the desktop app; null for any other.
 */
async function sharedReportId(message: { bugReportId?: unknown; source?: unknown }): Promise<number | null> {
  const id = message.bugReportId;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const played =
    message.source === 'desktop'
      ? (await desktopRunReports()).includes(id)
      : (await getReplayState())?.bugReportId === id;
  return played ? id : null;
}

/** Records the verdict the developer chose to share on the report it came from. */
export async function handleShareReproduction(message: {
  bugReportId?: unknown;
  source?: unknown;
  verdict?: unknown;
  divergedAt?: unknown;
  origin?: unknown;
}): Promise<ShareReproductionAnswer> {
  const settings = await getConnectionSettings();
  if (!settings.instanceUrl.trim()) return { ok: false, error: t('common_notConnected') };
  const id = await sharedReportId(message);
  const verdict = SHARED_VERDICTS.find((v) => v === message.verdict);
  if (id == null || !verdict) return { ok: false, error: t('common_noProject') };
  const origin =
    typeof message.origin === 'string' && /^https?:\/\/[^/\s]+$/.test(message.origin) ? message.origin : null;
  try {
    await withConnectionHealth(settings.instanceUrl, () =>
      sendReproduction(settings, id, {
        source: message.source === 'desktop' ? 'desktop' : 'replay',
        verdict,
        divergedAt: verdict === 'diverged' && typeof message.divergedAt === 'number' ? message.divergedAt : null,
        origin,
        userAgent: navigator.userAgent,
      }),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
