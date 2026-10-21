import { sessionFromSteps, type PiwiSteps } from '@piwitests/core/steps';
import { formatNumber, t, tNodes, uiLanguage } from '../shared/i18n.js';
import { icon } from '../shared/icons.js';
import { richText, stepView, urlView } from '../shared/step-view.js';
import { DESKTOP_DIALOG_HOST_ID } from './record-ui.js';
import { VERDICT_ICONS, verdictText, wait, type ReplayVerdict } from './replay-core.js';
import { attachPanelShadow } from './panel-root.js';
import { shareable, shareResultRow } from './share-result.js';
import { askWorker, button, DIALOG_CSS, holdFocus } from './replay-ui.js';

/**
 * Run with Playwright: sends a report's steps to the paired desktop app, which
 * runs them in the developer's project once they confirm it in its window, and
 * shows the verdict here. The dialog first shows exactly what is sent (the
 * title and the steps, with their typed values) and sends nothing before
 * **Send**. The background worker makes the requests.
 */

type DesktopTarget = { paired: boolean; url: string | null };
type SendAnswer = { ok: true; id: string; windowOpen: boolean } | { ok: false; error: string };
type StatusAnswer = { ok: true; status?: unknown; verdict?: unknown } | { ok: false; error: string };

const REPRO_STATUSES = ['waiting', 'running', 'done', 'declined', 'expired'] as const;
type ReproStatus = (typeof REPRO_STATUSES)[number];

/** How often the dialog asks the desktop app how the request stands. */
const POLL_MS = 2000;

/** The desktop app's status of a request; null for one this version does not know. */
export function reproStatus(status: unknown): ReproStatus | null {
  return REPRO_STATUSES.find((s) => s === status) ?? null;
}

/** The desktop app's verdict as Replay words its own; null for one this version does not read. */
export function asReplayVerdict(verdict: unknown): ReplayVerdict | null {
  const v = verdict as { kind?: unknown; step?: unknown; found?: unknown; reason?: unknown } | null;
  const step = Number.isInteger(v?.step) && (v!.step as number) >= 0 ? (v!.step as number) : null;
  switch (v?.kind) {
    case 'reproduced':
      if (step === null || (v.found != null && typeof v.found !== 'string')) return null;
      return { kind: 'reproduced', step, found: (v.found as string | null) ?? '', sameAsReported: false };
    case 'diverged':
      return step === null || typeof v.reason !== 'string' ? null : { kind: 'diverged', step, reason: v.reason };
    case 'stopped':
      return { kind: 'stopped', step: null };
    case 'not-reproduced':
    case 'completed':
      return { kind: v.kind };
    default:
      return null;
  }
}

export function openDesktopRun(steps: PiwiSteps, bugReportId: number | null, style: string): void {
  document.getElementById(DESKTOP_DIALOG_HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = DESKTOP_DIALOG_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });
  const css = document.createElement('style');
  css.textContent = `${style}${DIALOG_CSS}
    pre { max-height: 180px; overflow: auto; font-size: 11px; white-space: pre-wrap; }
    .steps .step { align-items: flex-start; }`;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'box';
  panel.style.cssText = 'padding:16px;width:min(520px,92vw);';
  panel.setAttribute('role', 'dialog');
  panel.lang = uiLanguage();
  panel.setAttribute('aria-label', t('replay_desktopTitle'));
  let polling = true;
  let giveFocusBack: (() => void) | null = null;
  const close = () => {
    polling = false;
    host.remove();
    giveFocusBack?.();
  };

  const title = document.createElement('div');
  title.className = 'head';
  const titleText = document.createElement('div');
  titleText.className = 'title';
  titleText.textContent = t('replay_desktopTitle');
  title.append(icon('terminal'), titleText);
  const body = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '12px';
  const message = document.createElement('div');
  message.className = 'message';
  message.setAttribute('role', 'status');
  panel.append(title, body, row, message);

  const line = (text: string, className = 'sub') => {
    const d = document.createElement('div');
    d.className = className;
    d.textContent = text;
    return d;
  };

  const recorded = sessionFromSteps(steps, steps.origin ?? location.origin).steps;

  /** How the request ended: declined, expired, or run, with the verdict when it is one this version shows. */
  const showEnd = (status: ReproStatus | null, answer: unknown) => {
    body.replaceChildren();
    row.replaceChildren(button(t('common_close'), close, { icon: 'close' }));
    if (status === 'declined') return body.append(line(t('replay_desktopDeclined')));
    if (status === 'expired') return body.append(line(t('replay_desktopExpired')));
    const verdict = status === 'done' ? asReplayVerdict(answer) : null;
    if (!verdict) return body.append(line(t('replay_desktopNoVerdict')));
    const { title: verdictTitle, detail } = verdictText(verdict, recorded);
    const box = document.createElement('div');
    box.className = `verdict ${verdict.kind}`;
    const heading = line(verdictTitle, 'title');
    heading.prepend(icon(VERDICT_ICONS[verdict.kind]));
    const said = line('', '');
    said.append(...richText(detail));
    box.append(heading, said);
    body.append(line(t('replay_desktopRanIn')), box);
    if (bugReportId && shareable(verdict.kind)) {
      body.append(
        shareResultRow({
          bugReportId,
          source: 'desktop',
          verdict: verdict.kind,
          divergedAt: verdict.kind === 'diverged' ? verdict.step : null,
          origin: null,
        }),
      );
    }
  };

  const poll = async (id: string) => {
    while (polling && host.isConnected) {
      const answer = await askWorker<StatusAnswer>(
        { type: 'piwi-desktop-repro-status', id },
        {
          ok: false,
          error: t('common_workerNoAnswer'),
        },
      );
      if (!polling || !host.isConnected) return;
      if (!answer.ok) {
        message.textContent = answer.error;
      } else {
        message.textContent = '';
        const status = reproStatus(answer.status);
        if (status !== 'waiting' && status !== 'running') return showEnd(status, answer.verdict);
        body.replaceChildren(line(t(status === 'running' ? 'replay_desktopRunning' : 'replay_desktopWaiting')));
      }
      await wait(POLL_MS);
    }
  };

  const showPreview = (url: string) => {
    const preview = line('');
    preview.append(...tNodes('replay_desktopPreview', { url: urlView(url) }));
    body.append(preview);
    const list = document.createElement('div');
    list.className = 'steps';
    recorded.forEach((step, i) => {
      const item = document.createElement('div');
      item.className = 'step';
      item.append(line(formatNumber(i + 1), 'num'), stepView(step));
      list.append(item);
    });
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = t('replay_desktopShowPayload');
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify({ title: steps.title, steps }, null, 2);
    details.append(summary, pre);
    body.append(list, details);
    const send = button(
      t('replay_desktopSend'),
      () => {
        send.disabled = true;
        void askWorker<SendAnswer>(
          { type: 'piwi-desktop-repro', steps, bugReportId },
          {
            ok: false,
            error: t('common_workerNoAnswer'),
          },
        ).then((answer) => {
          if (!answer.ok) {
            send.disabled = false;
            message.textContent = answer.error;
            return;
          }
          body.replaceChildren(line(t(answer.windowOpen ? 'replay_desktopWaiting' : 'replay_desktopNoWindow')));
          row.replaceChildren(button(t('common_close'), close, { icon: 'close' }));
          void poll(answer.id);
        });
      },
      { icon: 'send', tone: 'primary' },
    );
    row.append(send, button(t('common_cancel'), close, { icon: 'close', className: 'end' }));
  };

  void askWorker<DesktopTarget>({ type: 'piwi-desktop-target' }, { paired: false, url: null }).then((target) => {
    if (target.paired && target.url) {
      showPreview(target.url);
      return;
    }
    body.append(line(t('replay_desktopNotPaired')));
    row.append(
      button(
        t('replay_desktopOpenOptions'),
        () => {
          void askWorker({ type: 'piwi-open-options' }, null);
          close();
        },
        { icon: 'settings', tone: 'primary' },
      ),
      button(t('common_cancel'), close, { icon: 'close', className: 'end' }),
    );
  });

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.appendChild(panel);
  root.append(css, backdrop);
  giveFocusBack = holdFocus(panel, close);
}
