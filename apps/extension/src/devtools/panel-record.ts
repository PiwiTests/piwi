import { renderSpec } from '@piwitests/core/codegen';
import { buildSession, normalizeSteps, type RecordedStep } from '@piwitests/core/recording';
import { toStepsDocument } from '@piwitests/core/steps';
import { highlightLocator } from '@piwitests/picker-dom';
import { getActiveProjectOverride, resolveActiveProject } from '../shared/active-project.js';
import { getCachedCatalog } from '../shared/catalog-cache.js';
import { requestCatalogRefresh } from '../shared/catalog-refresh.js';
import { getConnectionSettings } from '../shared/connection-settings.js';
import { copyWithFeedback } from '../shared/clipboard.js';
import { downloadBlob } from '../shared/download.js';
import { icon, type IconName } from '../shared/icons.js';
import { stepView } from '../shared/step-view.js';
import { t, tn } from '../shared/i18n.js';
import {
  discardRecording,
  getRecordingState,
  recordingMode,
  stopRecording,
  type RecordingState,
} from '../shared/recording-storage.js';
import { patternOrigin } from '../shared/web-origin.js';
import { evalInPage } from './inspected.js';
import { button, el, emptyState, iconLine } from './ui.js';

/**
 * A step as the replay's panel says it, its kind on a badge and its names,
 * values and addresses set apart, and the locator it was recorded with.
 * `glyph` is the replay's mark for it; the list numbers the steps itself.
 */
export function stepRow(step: RecordedStep, glyph: IconName | null = null): HTMLLIElement {
  const item = el('li');
  const mark = el('span', 'glyph');
  if (glyph) mark.append(icon(glyph));
  mark.setAttribute('aria-hidden', 'true');
  const words = stepView(step);
  words.classList.add('step-words');
  item.append(mark, words);
  const locator = step.target?.alternatives[0]?.locator;
  if (locator) {
    const code = el('code', 'piwi-loc');
    code.innerHTML = highlightLocator(locator);
    item.appendChild(code);
  }
  return item;
}

/** The head of the Record and Replay views: a dot and the state, then the actions. */
export function viewHead(dot: string, text: string | Array<Node | string>, ...actions: HTMLElement[]): HTMLElement {
  const head = el('div', 'view-head');
  const status = el('p', 'status');
  status.setAttribute('role', 'status');
  const mark = el('span', `dot ${dot}`);
  mark.setAttribute('aria-hidden', 'true');
  const words = el('span');
  words.append(...(typeof text === 'string' ? [text] : text));
  status.append(mark, words);
  const controls = el('div', 'controls');
  controls.append(...actions);
  head.append(status, controls);
  return head;
}

/** The spec the review panel copies, with the active project's functions when the extension is connected. */
async function specFor(state: RecordingState): Promise<string> {
  const session = buildSession(normalizeSteps(state.events), state.events[0]?.timestamp ?? Date.now());
  const href = await evalInPage<string>('location.href');
  const pageUrl = href.ok && typeof href.value === 'string' ? href.value : (session.startUrl ?? '');
  const [connection, override] = await Promise.all([getConnectionSettings(), getActiveProjectOverride(pageUrl)]);
  const project = resolveActiveProject(connection, override, pageUrl);
  await requestCatalogRefresh(project?.projectId ?? null);
  const catalog = await getCachedCatalog(project?.projectId ?? null);
  return renderSpec(session, { catalog, urlChecks: true }).code;
}

function fileStamp(time: number): string {
  return new Date(time || Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

/**
 * The Record tab: the recording's steps as they are captured, with the review
 * panel's actions once it stops. It stops a recording the way the popup does;
 * a bug report is finished from its panel on the page, which collects the
 * evidence.
 */
export async function renderRecordTab(container: HTMLElement): Promise<void> {
  const state = await getRecordingState();
  const steps = normalizeSteps(state.events);
  const bug = recordingMode(state) === 'bug';
  if (!state.active && state.events.length === 0) {
    container.replaceChildren(emptyState('record', t('devtools_noRecording')));
    return;
  }

  const count = steps.length;
  const paused = state.active && !bug && state.paused === true;
  const text = state.active
    ? tn(bug ? 'devtools_bugRecordingOn' : paused ? 'devtools_recordingPaused' : 'devtools_recordingOn', count, {
        site: state.grantedOriginPattern ? patternOrigin(state.grantedOriginPattern) : '',
      })
    : tn('devtools_recordingStopped', count);

  const actions: HTMLElement[] = [];
  if (state.active && bug) {
    actions.push(iconLine('info', 'muted', t('devtools_finishBugOnPage')));
  } else if (state.active) {
    actions.push(
      button(
        t('devtools_stopRecording'),
        () => {
          void stopRecording().then(() =>
            chrome.runtime.sendMessage({ type: 'piwi-recording-stopped' }).catch(() => undefined),
          );
        },
        { icon: 'stop', tone: 'danger' },
      ),
    );
  } else if (!bug) {
    const copy = button(t('record_copyCode'), () => void specFor(state).then((spec) => copyWithFeedback(spec, copy)), {
      icon: 'copy',
      tone: 'primary',
    });
    const save = button(
      t('record_downloadSteps'),
      () => {
        const session = buildSession(steps, state.events[0]?.timestamp ?? Date.now());
        const doc = toStepsDocument(session);
        downloadBlob(
          new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
          `piwi-steps-${fileStamp(doc.recordedAt)}.json`,
        );
      },
      { icon: 'download', title: t('record_downloadStepsTitle') },
    );
    actions.push(
      copy,
      save,
      button(t('common_discard'), () => void discardRecording(), { icon: 'trash', tone: 'remove' }),
    );
  }

  const list = el('ol', 'steps');
  for (const step of steps) list.appendChild(stepRow(step));
  container.replaceChildren(viewHead(state.active && !paused ? 'live' : '', text, ...actions), list);
}
