import type { BugReport } from '@piwitests/core/bug-report';
import type { StoredBugScreenshot } from '../shared/bug-storage.js';
import { makeButton, styleButton } from '../shared/buttons.js';
import { icon, setLabel } from '../shared/icons.js';
import { stepView } from '../shared/step-view.js';
import { t, tn, uiLanguage } from '../shared/i18n.js';
import { attachPanelShadow } from './panel-root.js';
import { withoutStepShots } from './bug-report-files.js';
import { defaultSendChoices, reportToSend, screenshotsToSend, stepShotsToSend, type SendChoices } from './bug-send.js';

/** Where the background worker would send a report from this tab (`piwi-bug-send-target`). */
export interface SendTarget {
  connected: boolean;
  project: { id: number; label: string } | null;
  instance: string | null;
  firstSend: boolean;
  /** What the project does with its tracker, when it files anywhere. */
  intake?: { tracker: 'jira' | null; projectKey: string | null; canCreate: boolean; fileEvery: boolean } | null;
  /** How many step screenshots the instance takes with a report; 0, or absent, when it takes none. */
  stepShots?: number;
}

export const SEND_DIALOG_HOST_ID = '__piwi_bug_send_host';

/** Asks the worker where a report from this tab would go; not connected when it cannot tell. */
export async function sendTarget(): Promise<SendTarget> {
  try {
    const answer = (await chrome.runtime.sendMessage({ type: 'piwi-bug-send-target' })) as SendTarget | undefined;
    if (answer && typeof answer.connected === 'boolean') return answer;
  } catch {
    // An older worker, or none: not connected.
  }
  return { connected: false, project: null, instance: null, firstSend: false, intake: null, stepShots: 0 };
}

const SEND_CSS = `
  .check { display: flex; align-items: flex-start; gap: 8px; color: inherit; font-size: 12.5px; margin: 6px 0; cursor: pointer; }
  .check input { width: auto; margin: 2px 0 0; flex-shrink: 0; }
  .first { border: 1px solid rgba(124,58,237,.5); background: rgba(124,58,237,.12); border-radius: 8px; padding: 8px 10px; margin: 10px 0; font-size: 12px; }
  .always { font-size: 12.5px; margin: 10px 0 4px; }
  ol.sent-steps { margin: 4px 0 8px; padding: 6px 8px; list-style: none; font-size: 12px; max-height: 180px; overflow: auto;
    border: 1px solid rgba(128,128,128,.3); border-radius: 8px; display: flex; flex-direction: column; gap: 4px; }
  details { margin-top: 8px; font-size: 12px; }
  details pre { max-height: 220px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
    background: rgba(128,128,128,.1); border-radius: 6px; padding: 8px; white-space: pre-wrap; word-break: break-word; }
  .done { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; margin-top: 10px; }
  .done > .piwi-icon { color: #34d399; }
  @media (prefers-color-scheme: light) { .done > .piwi-icon { color: #047857; } }
`;

/**
 * The preview of Send to Piwi: exactly what leaves the browser, with a box per
 * kind of evidence and one to leave the typed values out. Nothing is sent
 * before the reporter clicks Send; the worker then sends the report as shown.
 */
export function openSendPreview(opts: {
  report: BugReport;
  screenshots: StoredBugScreenshot[];
  /** The step screenshots, as data URLs by archive file name. */
  stepImages: ReadonlyMap<string, string>;
  target: SendTarget & { project: { id: number; label: string } };
  css: string;
}): void {
  const { screenshots, stepImages, target } = opts;
  // An instance that takes no step screenshot gets the report without them.
  const takesStepShots = (target.stepShots ?? 0) > 0 && stepImages.size > 0;
  const report = takesStepShots ? opts.report : withoutStepShots(opts.report);
  document.getElementById(SEND_DIALOG_HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = SEND_DIALOG_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `${opts.css}${SEND_CSS}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.lang = uiLanguage();
  panel.tabIndex = -1;
  const title = t('bug_sendTitle', { project: target.project.label });
  panel.setAttribute('aria-label', title);

  const controller = new AbortController();
  const close = () => {
    controller.abort();
    host.remove();
  };

  const heading = document.createElement('div');
  heading.className = 'title';
  heading.textContent = title;
  const where = document.createElement('div');
  where.className = 'sub';
  where.textContent = t('bug_sendWhere', { project: target.project.label, instance: target.instance ?? '' });
  panel.append(heading, where);

  if (target.firstSend) {
    const first = document.createElement('div');
    first.className = 'first';
    first.textContent = t('bug_sendFirstTime');
    panel.appendChild(first);
  }

  const choices: SendChoices = defaultSendChoices();
  const always = document.createElement('div');
  always.className = 'always';
  always.textContent = tn('bug_sendSteps', report.steps.steps.length);
  const stepList = document.createElement('ol');
  stepList.className = 'sent-steps';
  panel.append(always, stepList);

  const box = (label: string, key: keyof SendChoices) => {
    const el = document.createElement('label');
    el.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = choices[key];
    input.addEventListener('change', () => {
      choices[key] = input.checked;
      refresh();
    });
    const text = document.createElement('span');
    text.textContent = label;
    el.append(input, text);
    panel.appendChild(el);
  };
  const { evidence } = report;
  if (evidence.screenshots.length > 0)
    box(t('bug_sendScreenshots', { count: evidence.screenshots.length }), 'screenshots');
  if (evidence.stepShots?.length) box(t('bug_sendStepShots', { count: evidence.stepShots.length }), 'stepShots');
  if (evidence.console.length > 0) box(t('bug_sendConsole', { count: evidence.console.length }), 'console');
  if (evidence.requests.length > 0) box(t('bug_sendRequests', { count: evidence.requests.length }), 'requests');
  if (evidence.outline) box(t('bug_sendOutline'), 'outline');
  if (report.steps.steps.some((step) => step.action === 'fill' && step.value != null))
    box(t('bug_sendEnvValues'), 'leaveOutValues');

  // The tracker: offered to a role that may create issues, and ticked (and fixed) when the project files every report.
  const intake = target.intake;
  let createIssue = false;
  if (intake?.tracker && intake.projectKey && (intake.canCreate || intake.fileEvery)) {
    const el = document.createElement('label');
    el.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = createIssue = intake.fileEvery;
    input.disabled = intake.fileEvery;
    input.addEventListener('change', () => {
      createIssue = input.checked;
    });
    const text = document.createElement('span');
    text.textContent = t('bug_sendCreateIssue', { project: intake.projectKey });
    el.append(input, text);
    panel.appendChild(el);
    if (intake.fileEvery) {
      const note = document.createElement('div');
      note.className = 'sub';
      note.textContent = t('bug_sendFilesEvery');
      panel.appendChild(note);
    }
  }

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = t('bug_sendShowData');
  const data = document.createElement('pre');
  details.append(summary, data);
  panel.appendChild(details);

  const refresh = () => {
    const shown = reportToSend(report, choices);
    stepList.replaceChildren(
      ...shown.steps.steps.map((step) => {
        const li = document.createElement('li');
        li.append(stepView(step));
        return li;
      }),
    );
    data.textContent = JSON.stringify(shown, null, 2);
  };
  refresh();

  const message = document.createElement('div');
  message.className = 'message';
  message.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'actions';
  const sendBtn = makeButton(t('bug_send'), () => send(), {
    icon: 'send',
    tone: 'primary',
    className: 'action primary',
  });
  const cancelBtn = makeButton(t('common_cancel'), () => close(), { icon: 'close', className: 'action' });
  actions.append(sendBtn, cancelBtn);
  panel.append(message, actions);

  const send = () => {
    sendBtn.disabled = true;
    setLabel(sendBtn, t('bug_sending'));
    message.textContent = '';
    void (async () => {
      let answer:
        | {
            ok: boolean;
            id?: number;
            url?: string;
            error?: string;
            issue?: { status: string; key: string | null } | null;
          }
        | undefined;
      try {
        answer = await chrome.runtime.sendMessage({
          type: 'piwi-send-bug-report',
          report: reportToSend(report, choices),
          language: uiLanguage(),
          createIssue,
          screenshots: screenshotsToSend(screenshots, choices),
          stepShots: stepShotsToSend(report, stepImages, choices),
        });
      } catch (e) {
        answer = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (answer?.ok && typeof answer.id === 'number') {
        const done = document.createElement('div');
        done.className = 'done';
        done.setAttribute('role', 'status');
        done.append(icon('check-circle'), t('bug_sent', { id: answer.id }));
        if (answer.url) {
          const link = document.createElement('a');
          link.href = answer.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = t('bug_openInPiwi');
          done.appendChild(styleButton(link, { icon: 'external', small: true }));
        }
        const issueLine = document.createElement('div');
        issueLine.className = 'sub';
        if (answer.issue?.key) issueLine.textContent = t('bug_issueCreated', { key: answer.issue.key });
        else if (answer.issue && answer.issue.status !== 'failed') issueLine.textContent = t('bug_issueQueued');
        const closeBtn = makeButton(t('common_close'), () => close(), { icon: 'close', className: 'action' });
        const row = document.createElement('div');
        row.className = 'actions';
        row.appendChild(closeBtn);
        panel.replaceChildren(heading, where, done, ...(issueLine.textContent ? [issueLine] : []), row);
        closeBtn.focus();
        return;
      }
      sendBtn.disabled = false;
      setLabel(sendBtn, t('bug_send'));
      message.textContent = t('bug_sendFailed', { error: answer?.error ?? t('common_workerNoAnswer') });
    })();
  };
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    },
    { capture: true, signal: controller.signal },
  );

  backdrop.appendChild(panel);
  root.append(style, backdrop);
  panel.focus();
}
