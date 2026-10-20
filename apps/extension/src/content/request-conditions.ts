import { formatNumber, initI18n, t, tn, tNodes, uiLanguage } from '../shared/i18n.js';
import { cpuText, emulationLines, throttleText } from '../shared/condition-words.js';
import {
  CONDITIONS_MESSAGE_SOURCE,
  isCondition,
  isCpuRate,
  isThrottle,
  type NetworkThrottle,
  type RequestCondition,
} from '../shared/request-conditions.js';
import { attachPanelShadow } from './panel-root.js';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { icon, type IconName } from '../shared/icons.js';

/**
 * The isolated-world half of Slow down or fail a request: asks the background
 * worker for this tab's conditions, hands the main-world script those it
 * applies (none when the debugging protocol applies them) by
 * `window.postMessage`, and shows a banner while any condition or throttling
 * is on, with Turn off. Injected again whenever the conditions change, which
 * posts them again.
 */

interface TabConditions {
  conditions: RequestCondition[];
  forPage: RequestCondition[];
  throttle: NetworkThrottle | null;
  cpuRate: number | null;
}

const BANNER_HOST_ID = 'piwi-conditions-banner';

async function conditionsForThisTab(): Promise<TabConditions> {
  try {
    const reply = (await chrome.runtime.sendMessage({ type: 'piwi-get-conditions' })) as {
      conditions?: unknown[];
      forPage?: unknown[];
      throttle?: unknown;
      cpuRate?: unknown;
    };
    return {
      conditions: (reply?.conditions ?? []).filter(isCondition),
      forPage: (reply?.forPage ?? reply?.conditions ?? []).filter(isCondition),
      throttle: isThrottle(reply?.throttle) ? reply.throttle : null,
      cpuRate: isCpuRate(reply?.cpuRate) ? reply.cpuRate : null,
    };
  } catch {
    return { conditions: [], forPage: [], throttle: null, cpuRate: null };
  }
}

/** What each kind of condition does, by icon. */
const CONDITION_ICONS: Record<RequestCondition['kind'], IconName> = {
  delay: 'clock',
  error: 'server-error',
  abort: 'blocked',
};

/** A condition in words, its method and address pattern set apart as code. */
function conditionNodes(condition: RequestCondition): Array<Node | string> {
  const request = document.createElement('span');
  request.className = 'request';
  const method = document.createElement('span');
  method.className = 'method';
  method.textContent = condition.method;
  const pattern = document.createElement('code');
  pattern.textContent = condition.pattern;
  request.append(method, ' ', pattern);
  switch (condition.kind) {
    case 'delay':
      return tNodes('devtools_conditionDelay', { request, seconds: formatNumber(condition.delayMs / 1000) });
    case 'error':
      return tNodes('devtools_conditionError', { request });
    case 'abort':
      return tNodes('devtools_conditionAbort', { request });
  }
}

interface BannerLine {
  icon: IconName;
  words: Array<Node | string>;
}

/** Each line of the banner: its icon and its words, the requests' conditions first, then the page's network and CPU. */
function bannerLines(on: TabConditions): BannerLine[] {
  const lines: BannerLine[] = on.conditions.map((condition) => ({
    icon: CONDITION_ICONS[condition.kind],
    words: conditionNodes(condition),
  }));
  if (on.throttle)
    lines.push({ icon: on.throttle === 'offline' ? 'blocked' : 'network', words: [throttleText(on.throttle)] });
  if (on.cpuRate) lines.push({ icon: 'gauge', words: [cpuText(on.cpuRate)] });
  return lines;
}

function drawBanner(on: TabConditions): void {
  document.getElementById(BANNER_HOST_ID)?.remove();
  const lines = emulationLines(on);
  if (lines.length === 0) return;
  const host = document.createElement('div');
  host.id = BANNER_HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483646;';
  const root = attachPanelShadow(host, { mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    ${BUTTON_CSS}
    .bar {
      display: flex; gap: 12px; align-items: center; max-width: min(560px, 90vw); box-sizing: border-box;
      background: #78350f; color: #fffbeb; border-radius: 10px; padding: 8px 8px 8px 12px;
      border: 1px solid rgba(251,191,36,.45);
      font: 12.5px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.35);
    }
    .text { min-width: 0; }
    .title { display: flex; align-items: center; gap: 6px; font-weight: 700; line-height: 18px; }
    .title .piwi-icon { color: #fcd34d; }
    ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 2px; }
    li { display: flex; align-items: flex-start; gap: 6px; line-height: 18px; overflow-wrap: anywhere; }
    li .piwi-icon { width: 14px; height: 14px; margin-top: 2px; color: #fcd34d; }
    .request { white-space: nowrap; }
    .method {
      font: 700 10.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 0 4px; border-radius: 4px;
      background: rgba(255,251,235,.18);
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; color: #fde68a;
      white-space: normal; overflow-wrap: anywhere;
    }
    .bar .piwi-btn { flex-shrink: 0; }
  `;
  const bar = document.createElement('div');
  bar.className = 'bar piwi-dark';
  bar.setAttribute('role', 'status');
  bar.lang = uiLanguage();
  const text = document.createElement('div');
  text.className = 'text';
  const title = document.createElement('div');
  title.className = 'title';
  const heading = document.createElement('span');
  heading.textContent = tn('devtools_conditionsOn', lines.length);
  title.append(icon('alert'), heading);
  const list = document.createElement('ul');
  for (const line of bannerLines(on)) {
    const item = document.createElement('li');
    const words = document.createElement('span');
    words.append(...line.words);
    item.append(icon(line.icon), words);
    list.appendChild(item);
  }
  text.append(title, list);
  const off = makeButton(
    t('devtools_conditionsOff'),
    () => {
      void chrome.runtime.sendMessage({ type: 'piwi-clear-conditions' }).catch(() => undefined);
    },
    { icon: 'stop', tone: 'danger', small: true },
  );
  bar.append(text, off);
  root.append(style, bar);
  (document.body ?? document.documentElement).appendChild(host);
}

async function relay(): Promise<void> {
  const [on] = await Promise.all([conditionsForThisTab(), initI18n()]);
  window.postMessage({ source: CONDITIONS_MESSAGE_SOURCE, conditions: on.forPage }, '*');
  if (emulationLines(on).length === 0) return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => drawBanner(on), { once: true });
  } else drawBanner(on);
}

void relay();
