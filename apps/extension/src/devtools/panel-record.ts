import { normalizeSteps, sessionFromEvents, type RecordedStep } from '@piwitests/core/recording';
import { toStepsDocument } from '@piwitests/core/steps';
import {
  BUG_REPORT_VERSION,
  bugContextFrom,
  emptyBugEvidence,
  isWrongStep,
  type BugReport,
} from '@piwitests/core/bug-report';
import { highlightLocator } from '@piwitests/picker-dom';
import { getActiveProjectOverride, resolveActiveProject } from '../shared/active-project.js';
import { getCachedCatalog } from '../shared/catalog-cache.js';
import { requestCatalogRefresh } from '../shared/catalog-refresh.js';
import { getConnectionSettings } from '../shared/connection-settings.js';
import { copyWithFeedback } from '../shared/clipboard.js';
import { icon, type IconName } from '../shared/icons.js';
import { stepView } from '../shared/step-view.js';
import { t, tn } from '../shared/i18n.js';
import { discardRecording, getRecordingState, type RecordingState } from '../shared/recording-storage.js';
import { recordingSpec } from '../shared/recording-spec.js';
import { patternOrigin } from '../shared/web-origin.js';
import { recordingTitle } from '../shared/recording-title.js';
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

/**
 * The test the finish panel copies, with the active project's functions when
 * the extension is connected: the failing test when a step says the page was
 * wrong (`recordingSpec`).
 */
async function specFor(state: RecordingState): Promise<string> {
  const steps = normalizeSteps(state.events);
  const session = sessionFromEvents(state.events, state.startedAt ?? steps[0]?.timestamp ?? Date.now());
  const href = await evalInPage<string>('location.href');
  const pageUrl = href.ok && typeof href.value === 'string' ? href.value : (session.startUrl ?? '');
  const [connection, override] = await Promise.all([getConnectionSettings(), getActiveProjectOverride(pageUrl)]);
  const project = resolveActiveProject(connection, override, pageUrl);
  await requestCatalogRefresh(project?.projectId ?? null);
  const catalog = await getCachedCatalog(project?.projectId ?? null);
  const report: BugReport = {
    v: BUG_REPORT_VERSION,
    steps: toStepsDocument(session, { title: recordingTitle(state, steps) }),
    evidence: emptyBugEvidence(),
    context: bugContextFrom({
      url: pageUrl,
      userAgent: null,
      viewport: null,
      time: Date.now(),
      extensionVersion: null,
    }),
  };
  return recordingSpec(report, catalog).code;
}

/**
 * The Record tab: the recording's steps as they are captured, then Copy test
 * and Discard once it stops. A recording is finished from its bar on the page
 * or from the popup, which collect the last evidence.
 */
export async function renderRecordTab(container: HTMLElement): Promise<void> {
  const state = await getRecordingState();
  const steps = normalizeSteps(state.events);
  if (!state.active && state.events.length === 0) {
    container.replaceChildren(emptyState('record', t('devtools_noRecording')));
    return;
  }

  const count = steps.length;
  const paused = state.active && state.paused === true;
  const text = state.active
    ? tn(paused ? 'devtools_recordingPaused' : 'devtools_recordingOn', count, {
        site: state.grantedOriginPattern ? patternOrigin(state.grantedOriginPattern) : '',
      })
    : tn('devtools_recordingStopped', count);

  const actions: HTMLElement[] = [];
  if (state.active) {
    actions.push(iconLine('info', 'muted', t('devtools_finishOnPage')));
  } else {
    // A step marked wrong makes the copied test the failing one, named as the finish panel names it.
    const label = steps.some(isWrongStep) ? t('bug_copyTest') : t('record_copyTest');
    const copy = button(label, () => void specFor(state).then((spec) => copyWithFeedback(spec, copy)), {
      icon: 'copy',
      tone: 'primary',
    });
    actions.push(
      copy,
      button(t('common_discard'), () => void discardRecording(), { icon: 'trash', tone: 'remove' }),
    );
  }

  const list = el('ol', 'steps');
  for (const step of steps) list.appendChild(stepRow(step));
  container.replaceChildren(viewHead(state.active && !paused ? 'live' : '', text, ...actions), list);
}
