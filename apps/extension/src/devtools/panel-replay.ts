import { sessionFromSteps } from '@piwitests/core/steps';
import { t } from '../shared/i18n.js';
import { icon } from '../shared/icons.js';
import { getReplayState, updateReplayState, type ReplayState } from '../shared/replay-storage.js';
import { richText } from '../shared/step-view.js';
import { patternView } from '../shared/pattern-view.js';
import { hostPattern } from '../shared/web-origin.js';
import {
  driverText,
  replayVerdict,
  stepStatus,
  VERDICT_ICONS,
  verdictText,
  type ReplayVerdict,
} from '../content/replay-core.js';
import { conditionView } from './panel-conditions.js';
import { stepRow, viewHead } from './panel-record.js';
import { button, el, emptyState, iconLine } from './ui.js';

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
  const text = [
    t(done ? 'replay_statusDone' : paused ? 'replay_statusPaused' : 'replay_statusRunning'),
    ' · ',
    patternView(state.origin),
  ];

  const actions: HTMLElement[] = [];
  if (!done) {
    actions.push(
      button(
        paused ? t('replay_continue') : t('replay_pause'),
        () => {
          void change(state, { status: paused ? 'running' : 'paused' }, 'waiting');
        },
        { icon: paused ? 'play' : 'pause' },
      ),
    );
    if (state.stepMode) {
      actions.push(
        button(t('replay_nextStep'), () => void notifyReplay(state.origin, true), { icon: 'next', tone: 'primary' }),
      );
    }
    actions.push(
      button(t('common_stop'), () => void change(state, { status: 'stopped' }, true), { icon: 'stop', tone: 'danger' }),
    );
  }

  const parts: HTMLElement[] = [viewHead(done ? 'done' : paused ? '' : 'running', text, ...actions)];
  if (state.conditions?.length) {
    const chips = el('div', 'view-note chips');
    chips.appendChild(el('span', '', t('devtools_conditionsTitle')));
    for (const condition of state.conditions) {
      const chip = el('span', 'chip');
      chip.append(...conditionView(condition));
      chips.appendChild(chip);
    }
    parts.push(chips);
  }
  if (state.driver) parts.push(iconLine('info', 'view-note', driverText(state.driver)));
  if (done) {
    const verdict = replayVerdict(steps, state.results, state.status === 'stopped', state.runFailedStep ?? null);
    const { title, detail } = verdictText(verdict, steps);
    const box = el('div', `verdict ${VERDICT_TONES[verdict.kind]}`);
    const words = el('div');
    const detailEl = el('div');
    detailEl.append(...richText(detail));
    words.append(el('strong', '', title), detailEl);
    box.append(icon(VERDICT_ICONS[verdict.kind]), words);
    parts.push(box);
  }

  const list = el('ol', 'steps');
  steps.forEach((step, index) => {
    const result = state.results[index];
    const current = !done && index === state.position;
    const row = stepRow(step, stepStatus(result, current).icon);
    if (current) row.classList.add('current');
    if (result?.status) row.dataset.status = result.status;
    if (result?.detail) {
      const why = el('div', 'detail');
      why.append(...richText(result.detail));
      row.appendChild(why);
    }
    if (result?.driver)
      row.appendChild(el('div', 'detail', t(result.driver === 'cdp' ? 'replay_stepTrusted' : 'replay_stepEvents')));
    list.appendChild(row);
  });
  parts.push(list);
  container.replaceChildren(...parts);
}
