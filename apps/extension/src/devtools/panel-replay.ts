import { sessionFromSteps } from '@piwitests/core/steps';
import { conditionText } from '../shared/condition-words.js';
import { t } from '../shared/i18n.js';
import { getReplayState, updateReplayState, type ReplayState } from '../shared/replay-storage.js';
import { hostPattern } from '../shared/web-origin.js';
import { driverText, replayVerdict, stepGlyph, verdictText, type ReplayVerdict } from '../content/replay-core.js';
import { stepRow, viewHead } from './panel-record.js';
import { button, el, emptyState } from './ui.js';

/** The message the replay script answers in each page of the replayed site: redraw its panel, and go on when `wake`. */
const REPLAY_WAKE_MESSAGE = 'piwi-replay-wake';

/**
 * Tells the replay script, in every tab of the replayed site, that the state
 * changed. `wake: true` (Next step, Stop) releases a wait for Next or
 * Continue, or is kept for the next one; `'waiting'` (Pause, Continue) only
 * releases a wait in progress, so it is never taken for a Next later.
 */
async function notifyReplay(origin: string, wake: boolean | 'waiting'): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: hostPattern(origin) });
  } catch {
    return;
  }
  await Promise.all(
    tabs.map((tab) =>
      tab.id == null
        ? undefined
        : chrome.tabs.sendMessage(tab.id, { type: REPLAY_WAKE_MESSAGE, wake }).catch(() => undefined),
    ),
  );
}

async function change(state: ReplayState, next: Partial<ReplayState>, wake: boolean | 'waiting'): Promise<void> {
  await updateReplayState((s) => ({ ...s, ...next }));
  await notifyReplay(state.origin, wake);
}

const VERDICT_TONES: Record<ReplayVerdict['kind'], string> = {
  reproduced: 'bad',
  diverged: 'warn',
  stopped: 'warn',
  'not-reproduced': 'good',
  completed: 'good',
};

/**
 * The Replay tab: the replay's steps with their results, the locator each was
 * recorded with, and the verdict. Pause, Continue, Next step and Stop change
 * the stored state as the replay's panel on the page does, then tell that
 * panel.
 */
export async function renderReplayTab(container: HTMLElement): Promise<void> {
  const state = await getReplayState();
  if (!state) {
    container.replaceChildren(emptyState('replay', t('devtools_noReplay')));
    return;
  }
  const steps = sessionFromSteps(state.steps, state.origin).steps;
  const done = state.status === 'done' || state.status === 'stopped';
  const paused = state.status === 'paused';
  const text = `${t(done ? 'replay_statusDone' : paused ? 'replay_statusPaused' : 'replay_statusRunning')} · ${state.origin}`;

  const actions: HTMLElement[] = [];
  if (!done) {
    actions.push(
      button(paused ? t('replay_continue') : t('replay_pause'), () => {
        void change(state, { status: paused ? 'running' : 'paused' }, 'waiting');
      }),
    );
    if (state.stepMode) {
      actions.push(button(t('replay_nextStep'), () => void notifyReplay(state.origin, true), 'primary'));
    }
    actions.push(button(t('common_stop'), () => void change(state, { status: 'stopped' }, true), 'danger'));
  }

  const parts: HTMLElement[] = [viewHead(done ? 'done' : paused ? '' : 'running', text, ...actions)];
  if (state.conditions?.length) {
    const chips = el('div', 'view-note chips');
    chips.appendChild(el('span', '', t('devtools_conditionsTitle')));
    for (const condition of state.conditions) chips.appendChild(el('span', 'chip', conditionText(condition)));
    parts.push(chips);
  }
  if (state.driver) parts.push(el('div', 'view-note', driverText(state.driver)));
  if (done) {
    const verdict = replayVerdict(steps, state.results, state.status === 'stopped', state.runFailedStep ?? null);
    const { title, detail } = verdictText(verdict, steps);
    const box = el('div', `verdict ${VERDICT_TONES[verdict.kind]}`);
    box.append(el('strong', '', title), el('div', '', detail));
    parts.push(box);
  }

  const list = el('ol', 'steps');
  steps.forEach((step, index) => {
    const result = state.results[index];
    const current = !done && index === state.position;
    const row = stepRow(step, stepGlyph(result, current));
    if (current) row.classList.add('current');
    if (result?.status) row.dataset.status = result.status;
    if (result?.detail) row.appendChild(el('div', 'detail', result.detail));
    if (result?.driver)
      row.appendChild(el('div', 'detail', t(result.driver === 'cdp' ? 'replay_stepTrusted' : 'replay_stepEvents')));
    list.appendChild(row);
  });
  parts.push(list);
  container.replaceChildren(...parts);
}
