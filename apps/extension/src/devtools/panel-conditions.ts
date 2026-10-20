import { cpuText, throttleText } from '../shared/condition-words.js';
import { formatNumber, t, tNodes } from '../shared/i18n.js';
import { icon } from '../shared/icons.js';
import { patternView } from '../shared/pattern-view.js';
import {
  CONDITIONS_KEY,
  CPU_RATES,
  MAX_DELAY_MS,
  NETWORK_THROTTLES,
  isThrottle,
  type ConditionKind,
  type ConditionsState,
  type NetworkThrottle,
  type RequestCondition,
} from '../shared/request-conditions.js';
import { mockUrlPattern } from '../shared/mock-code.js';
import { sessionArea } from '../shared/session-area.js';
import { inspectedTabId, requestSiteAccess, sitePattern } from './inspected.js';
import { button, el, methodView } from './ui.js';
import type { NetworkEntry } from './panel-network.js';

/**
 * Slow down or fail a request, in the Network tab: buttons under the selected
 * request, the whole page's network and CPU in the toolbar, and what is on for
 * this tab with a way to remove it. The background worker applies them
 * (`piwi-set-conditions`): through the debugging protocol in Chrome and Edge,
 * through the page's `fetch`/XHR wrapper otherwise. The site's host permission
 * is asked for inside the click.
 */

/** What is on for this tab: the requests' conditions, the page's network and CPU, and the origin they were set for. */
interface TabConditions {
  origin: string | null;
  conditions: RequestCondition[];
  throttle: NetworkThrottle | null;
  cpuRate: number | null;
  via: ConditionsState['via'];
  lost: ConditionsState['lost'];
}

async function onThisTab(): Promise<TabConditions> {
  const state = (await sessionArea().get(CONDITIONS_KEY))[CONDITIONS_KEY] as ConditionsState | undefined;
  if (state?.tabId !== inspectedTabId()) {
    return { origin: null, conditions: [], throttle: null, cpuRate: null, via: undefined, lost: null };
  }
  return {
    origin: state.origin,
    conditions: state.conditions,
    throttle: state.throttle ?? null,
    cpuRate: state.cpuRate ?? null,
    via: state.via,
    lost: state.lost ?? null,
  };
}

/**
 * What is on for this tab at `origin`. What was set for another origin, which
 * the page has left since, is left out: a change made here sets this
 * origin's conditions, and does not carry the other origin's along.
 */
async function onThisTabAt(origin: string | null): Promise<TabConditions> {
  const on = await onThisTab();
  if (on.origin === null || on.origin === origin) return on;
  return { ...on, conditions: [], throttle: null, cpuRate: null };
}

/**
 * A condition in words, as `conditionText` says it, its request's method and
 * pattern set apart: for the strip and the Replay tab's list.
 */
export function conditionView(condition: RequestCondition): Array<Node | string> {
  const request = el('span', 'condition-request');
  request.append(methodView(condition.method), ' ', patternView(condition.pattern));
  switch (condition.kind) {
    case 'delay':
      return tNodes('devtools_conditionDelay', { request, seconds: formatNumber(condition.delayMs / 1000) });
    case 'error':
      return tNodes('devtools_conditionError', { request });
    case 'abort':
      return tNodes('devtools_conditionAbort', { request });
  }
}

/** Whether this browser gives the extension the debugging protocol: Chrome and Edge do, Firefox does not. */
function debuggingProtocol(): boolean {
  return typeof chrome.debugger?.attach === 'function';
}

async function setState(
  origin: string,
  next: Pick<TabConditions, 'conditions' | 'throttle' | 'cpuRate'>,
  report: (text: string) => void,
): Promise<void> {
  const reply = (await chrome.runtime
    .sendMessage({ type: 'piwi-set-conditions', tabId: inspectedTabId(), origin, ...next })
    .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))) as {
    ok: boolean;
    error?: string;
  };
  if (!reply?.ok) report(t('devtools_conditionFailed', { error: reply?.error ?? '' }));
}

async function setConditions(origin: string, conditions: RequestCondition[], report: (text: string) => void) {
  const { throttle, cpuRate } = await onThisTabAt(origin);
  await setState(origin, { conditions, throttle, cpuRate }, report);
}

/**
 * The whole page's network (fast 3G, slow 3G, offline) and CPU (4, 6 or 20
 * times slower), as DevTools offers them, for this tab until turned off. Only
 * where the debugging protocol is: nothing is drawn without it.
 */
export async function pageConditions(origin: string | null, report: (text: string) => void): Promise<HTMLElement> {
  const group = el('span', 'page-conditions');
  if (!debuggingProtocol()) return group;
  const current = await onThisTabAt(origin);
  const choice = (label: string, options: Array<[string, string]>, value: string) => {
    const select = el('select');
    select.setAttribute('aria-label', label);
    for (const [key, text] of options) {
      const option = el('option', '', text);
      option.value = key;
      select.appendChild(option);
    }
    select.value = value;
    const wrap = el('label', 'check');
    wrap.append(label, select);
    group.appendChild(wrap);
    return select;
  };
  const network = choice(
    t('devtools_throttleLabel'),
    [['', t('devtools_throttleNone')], ...NETWORK_THROTTLES.map((k): [string, string] => [k, throttleText(k)])],
    current.throttle ?? '',
  );
  const cpu = choice(
    t('devtools_cpuLabel'),
    [['', t('devtools_throttleNone')], ...CPU_RATES.map((r): [string, string] => [String(r), cpuText(r)])],
    current.cpuRate ? String(current.cpuRate) : '',
  );
  const apply = () => {
    report('');
    const pattern = sitePattern(origin);
    if (!origin || !pattern) return report(t('devtools_conditionsNoPage'));
    // Inside the change: the browser shows the request only during it.
    void requestSiteAccess(pattern).then(async (granted) => {
      if (!granted) return report(t('devtools_conditionsNeedAccess'));
      const throttle = isThrottle(network.value) ? network.value : null;
      const cpuRate = cpu.value ? Number(cpu.value) : null;
      await setState(origin, { conditions: (await onThisTabAt(origin)).conditions, throttle, cpuRate }, report);
    });
  };
  network.addEventListener('change', apply);
  cpu.addEventListener('change', apply);
  return group;
}

/** The section under a selected request: slow it down by the seconds given, or make it fail. */
export function conditionActions(entry: NetworkEntry, origin: string | null): HTMLElement {
  const status = document.createElement('span');
  status.className = 'warn-text';
  status.setAttribute('role', 'status');
  const report = (text: string) => {
    status.textContent = text;
  };
  const seconds = document.createElement('input');
  seconds.type = 'number';
  seconds.min = '0.1';
  seconds.max = String(MAX_DELAY_MS / 1000);
  seconds.step = '0.5';
  seconds.value = '2';
  seconds.className = 'seconds';
  seconds.setAttribute('aria-label', t('devtools_delaySeconds'));

  const add = (kind: ConditionKind) => {
    report('');
    const pattern = sitePattern(origin);
    if (!origin || !pattern) return report(t('devtools_conditionsNoPage'));
    const delayMs = Math.round(Math.min(Math.max(Number(seconds.value) || 0, 0), MAX_DELAY_MS / 1000) * 1000);
    const condition: RequestCondition = {
      id: crypto.randomUUID(),
      method: entry.method.toUpperCase(),
      pattern: mockUrlPattern(entry.url),
      kind,
      delayMs: kind === 'delay' ? delayMs : 0,
    };
    // Inside the click: the browser shows the request only during it.
    void requestSiteAccess(pattern).then(async (granted) => {
      if (!granted) return report(t('devtools_conditionsNeedAccess'));
      const others = (await onThisTabAt(origin)).conditions.filter(
        (c) => c.method !== condition.method || c.pattern !== condition.pattern,
      );
      await setConditions(origin, [...others, condition], report);
    });
  };
  const section = el('section', 'condition-actions');
  section.setAttribute('aria-label', t('devtools_conditionsFor'));
  const controls = el('div', 'controls');
  controls.append(
    seconds,
    button(t('devtools_slowDown'), () => add('delay'), { icon: 'gauge' }),
    button(t('devtools_failError'), () => add('error'), { icon: 'server-error' }),
    button(t('devtools_failAbort'), () => add('abort'), { icon: 'blocked' }),
    status,
  );
  const limits = el('details', 'limits');
  limits.append(
    el('summary', '', t('devtools_conditionsLimitsTitle')),
    el('p', '', t(debuggingProtocol() ? 'devtools_conditionsLimits' : 'devtools_conditionsLimitsPage')),
  );
  section.append(el('h3', 'section-title', t('devtools_conditionsFor')), controls, limits);
  return section;
}

/**
 * What is on for this tab, each with Remove, and Turn all off; nothing when
 * nothing is on. They act on the origin the conditions were set for. Once the
 * page is on another, the strip names that origin and keeps Turn all off: the
 * background worker changes a tab's conditions only while it shows their origin.
 */
export async function renderConditions(strip: HTMLElement, pageOrigin: string | null): Promise<void> {
  const on = await onThisTab();
  const { conditions } = on;
  const origin = on.origin ?? pageOrigin;
  const away = origin !== pageOrigin;
  const lostNote =
    on.lost === 'canceled'
      ? t('devtools_conditionsLostCanceled')
      : on.lost === 'lost'
        ? t('devtools_conditionsLostEnded')
        : null;
  if ((conditions.length === 0 && !on.throttle && !on.cpuRate) || !origin) {
    strip.replaceChildren(...(lostNote && origin ? [el('span', 'warn-text', lostNote)] : []));
    return;
  }
  const status = el('span', 'warn-text');
  const report = (text: string) => {
    status.textContent = text;
  };
  const list = el('ul');
  /** A line of the strip: what is on, and Remove while the page shows the origin it was set for. */
  const line = (text: Array<Node | string>, remove: () => void) => {
    const item = el('li');
    const words = el('span');
    words.append(...text);
    item.append(
      words,
      ...(away ? [] : [button(t('devtools_conditionRemove'), remove, { icon: 'close', tone: 'remove', small: true })]),
    );
    list.appendChild(item);
  };
  for (const condition of conditions) {
    line(conditionView(condition), () => {
      void setConditions(
        origin,
        conditions.filter((c) => c.id !== condition.id),
        report,
      );
    });
  }
  const whole: Array<[string, Partial<TabConditions>]> = [
    ...(on.throttle ? [[throttleText(on.throttle), { throttle: null }] as [string, Partial<TabConditions>]] : []),
    ...(on.cpuRate ? [[cpuText(on.cpuRate), { cpuRate: null }] as [string, Partial<TabConditions>]] : []),
  ];
  for (const [text, off] of whole) {
    line([text], () => {
      void setState(origin, { conditions, throttle: on.throttle, cpuRate: on.cpuRate, ...off }, report);
    });
  }
  const allOff = button(
    t('devtools_conditionsAllOff'),
    () => void setState(origin, { conditions: [], throttle: null, cpuRate: null }, report),
    { icon: 'stop', tone: 'remove' },
  );
  const title = el('span', 'strip-title');
  title.append(icon('gauge'), t('devtools_conditionsTitle'));
  const parts: HTMLElement[] = [title, list, allOff, status];
  if (away) {
    const note = el('span', 'strip-note');
    note.append(...tNodes('devtools_conditionsSetFor', { site: patternView(origin) }));
    parts.push(note);
  }
  if (on.via === 'debugger') parts.push(el('span', 'strip-note', t('devtools_conditionsDebugging')));
  if (lostNote) parts.push(el('span', 'warn-text', lostNote));
  strip.replaceChildren(...parts);
}
