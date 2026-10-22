import { LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import { OVERRIDE_KEY, getActiveProjectOverride, resolveActiveProject } from '../shared/active-project.js';
import { CONNECTION_KEY, getConnectionSettings, isConnected } from '../shared/connection-settings.js';
import { initI18n, localizeDocument, t, uiLanguage } from '../shared/i18n.js';
import { injectionFailureText } from '../shared/injection-failure.js';
import { RECORDING_KEY, getRecordingState } from '../shared/recording-storage.js';
import { REPLAY_KEY, getReplayState } from '../shared/replay-storage.js';
import { CONDITIONS_KEY } from '../shared/request-conditions.js';
import {
  evalInPage,
  injectContentScript,
  inspectedOrigin,
  inspectedTabId,
  requestSiteAccess,
  sitePattern,
} from './inspected.js';
import { renderRecordTab } from './panel-record.js';
import { renderReplayTab } from './panel-replay.js';
import { networkOriginChanged, refreshNetworkList, renderNetworkTab, startNetworkLog } from './panel-network.js';
import { renderLocatorsTab } from './panel-locators.js';
import { renderSessionTab } from './panel-session.js';
import { setUpViewportRow } from './panel-viewport.js';
import { SESSION_KEY } from '../shared/session-storage.js';
import { patternOrigin } from '../shared/web-origin.js';
import { decorateIcons } from '../shared/icons.js';
import { STEP_CSS } from '../shared/step-view.js';
import { PATTERN_CSS } from '../shared/pattern-view.js';
import { button, iconLine, noAccessText } from './ui.js';

/**
 * The Piwi panel in DevTools. It mirrors what runs on the page, from the same
 * session storage the in-page panels read: the recording's steps (Record),
 * the replay's steps and verdict (Replay), and redraws whenever that storage
 * changes, so it stays up across the page's navigations. Network lists the
 * page's API calls from DevTools' own log, for Mock this response. Locators
 * tries a locator on the page and reveals what it finds in the Elements panel;
 * Session lists the elements named so far. The toolbar holds the popup's tools
 * that act on the page (Pick, Lint, Tested elements), then those that set the
 * page up for a test: its viewport, the Playwright view and Save login.
 * Recording and replaying keep their panels on the page as well, for when
 * DevTools is closed.
 */

type TabId = 'record' | 'replay' | 'network' | 'locators' | 'session';

const TAB_KEYS: Record<TabId, string[]> = {
  record: [RECORDING_KEY],
  replay: [REPLAY_KEY],
  network: [CONDITIONS_KEY],
  locators: [],
  session: [SESSION_KEY],
};

const content = document.getElementById('content') as HTMLElement;
const notice = document.getElementById('notice') as HTMLElement;
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

let current: TabId = 'record';
let generation = 0;

/**
 * Draws the open tab; `pageUrl` is the page's address after a navigation, which the Network tab lists for. False when
 * a later draw took its place.
 */
async function render(pageUrl?: string): Promise<boolean> {
  const mine = ++generation;
  const container = document.createElement('div');
  if (current === 'record') await renderRecordTab(container);
  else if (current === 'replay') await renderReplayTab(container);
  else if (current === 'network') await renderNetworkTab(container, pageUrl);
  else if (current === 'locators') renderLocatorsTab(container);
  else await renderSessionTab(container);
  if (mine !== generation) return false;
  content.classList.toggle('flush', current === 'network');
  content.setAttribute('aria-labelledby', `tab-${current}`);
  content.replaceChildren(...container.childNodes);
  return true;
}

/** A dot on Record while a recording runs, and on Replay while a replay does, whatever tab is open. */
async function markLiveTabs(): Promise<void> {
  const [recording, replay] = await Promise.all([getRecordingState(), getReplayState()]);
  const live: Record<TabId, boolean> = {
    record: recording.active,
    replay: replay?.status === 'running' || replay?.status === 'paused',
    network: false,
    locators: false,
    session: false,
  };
  for (const tab of tabButtons) tab.dataset.live = String(live[tab.dataset.tab as TabId]);
}

/** Opens `tab`. Opened with a click, the Locators tab puts the caret in its field; the arrow keys keep it on the tabs. */
function select(tab: TabId, byClick = false): void {
  current = tab;
  for (const button of tabButtons) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  void render().then((drawn) => {
    if (drawn && byClick) content.querySelector<HTMLInputElement>('.locator-input')?.focus();
  });
}

/**
 * The inspected page's host permission pattern, read ahead of any click so that the click asks for it before awaiting
 * anything; null on a page the extension cannot run on.
 */
let pagePattern: string | null = null;

function dismissButton(): HTMLButtonElement {
  return button(t('common_close'), () => notice.replaceChildren(), { icon: 'close', iconOnly: true, tone: 'ghost' });
}

/**
 * Runs one of the extension's page tools (`file`, a content script) in the inspected tab. DevTools grants no
 * `activeTab`: the click asks for the site's access first, before anything is awaited (Firefox shows no prompt for a
 * request made after one), which a site already granted answers at once. When the tool still cannot run, the notice
 * says why, with Allow on this site when the site's access would do.
 */
async function runPageTool(file: string): Promise<void> {
  notice.replaceChildren();
  const granted = pagePattern ? await requestSiteAccess(pagePattern) : false;
  const injected = await injectContentScript(file);
  if (injected.ok) return;
  const href = await evalInPage<string>('location.href');
  const url = href.ok && typeof href.value === 'string' ? href.value : '';
  pagePattern = sitePattern(url);
  const pattern = pagePattern;
  if (pattern && !granted) {
    const allow = button(
      t('devtools_allowSite'),
      () => {
        void requestSiteAccess(pattern).then((yes) => {
          if (!yes) return;
          notice.replaceChildren();
          void runPageTool(file);
        });
      },
      { icon: 'check', tone: 'primary' },
    );
    notice.replaceChildren(iconLine('lock', '', ...noAccessText(patternOrigin(pattern))), allow, dismissButton());
    return;
  }
  notice.replaceChildren(iconLine('blocked', '', injectionFailureText(injected.error, url)), dismissButton());
}

const testedButton = document.getElementById('tested-elements') as HTMLButtonElement;
/** Why Tested elements cannot run on the inspected page, in the popup's words; null when it can, undefined until read. */
let testedUnavailable: string | null | undefined;
let testedGeneration = 0;

/**
 * Tested elements needs a connected instance and a project for the inspected page, as in the popup: the button says
 * so, and is marked disabled until both are there.
 */
async function refreshTestedButton(pageUrl?: string): Promise<void> {
  const mine = ++testedGeneration;
  const url = pageUrl ?? (await inspectedTab()).url;
  const [connection, override] = await Promise.all([getConnectionSettings(), getActiveProjectOverride(url)]);
  if (mine !== testedGeneration) return;
  testedUnavailable = !isConnected(connection)
    ? t('popup_testedElementsConnect')
    : resolveActiveProject(connection, override, url)
      ? null
      : t('coverage_noProject');
  testedButton.setAttribute('aria-disabled', String(testedUnavailable !== null));
  testedButton.title = testedUnavailable ?? t('devtools_testedElementsTitle');
}

function openTestedElements(): void {
  if (testedUnavailable === undefined) return;
  if (testedUnavailable === null) {
    void runPageTool('coverage-overlay.js');
    return;
  }
  const settings = button(t('coverage_openSettings'), () => void chrome.runtime.openOptionsPage(), {
    icon: 'settings',
  });
  notice.replaceChildren(iconLine('info', '', testedUnavailable), settings, dismissButton());
}

/** The inspected tab and its address, read in the page, which needs no permission. */
async function inspectedTab(): Promise<{ id: number; url: string }> {
  const href = await evalInPage<string>('location.href');
  return { id: inspectedTabId(), url: href.ok && typeof href.value === 'string' ? href.value : '' };
}

/** Opens Save login for tests for the inspected tab, in a tab of its own. */
async function openSaveLogin(): Promise<void> {
  const tab = await inspectedTab();
  const query = new URLSearchParams({ tabId: String(tab.id), url: tab.url });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`login.html?${query}`) });
}

/** Viewport shows or hides its bar, set up the first time it opens with the sizes of the project inspected then. */
function wireViewport(): void {
  const toggle = document.getElementById('viewport-toggle') as HTMLButtonElement;
  const row = document.getElementById('viewport-row') as HTMLFormElement;
  let set = false;
  toggle.addEventListener('click', () => {
    const open = row.hidden;
    row.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open || set) return;
    set = true;
    void setUpViewportRow(inspectedTab, (text) => {
      notice.replaceChildren(iconLine('alert', 'warn-text', text));
    });
  });
}

async function start(): Promise<void> {
  const texts = initI18n();
  // Wired before the texts load: a tab clicked meanwhile opens once they have,
  // after the Record tab the start opens.
  for (const button of tabButtons) {
    const open = (tab: HTMLButtonElement, byClick = false) =>
      void texts.then(() => select(tab.dataset.tab as TabId, byClick));
    button.addEventListener('click', () => open(button, true));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const index = tabButtons.indexOf(button);
      const next = tabButtons[(index + (event.key === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length]!;
      next.focus();
      open(next);
    });
  }
  await texts;
  document.documentElement.lang = uiLanguage();
  localizeDocument();
  const style = document.createElement('style');
  style.textContent = `${LOCATOR_SYNTAX_CSS}${STEP_CSS}${PATTERN_CSS}`;
  document.head.appendChild(style);
  decorateIcons();

  for (const [id, file] of [
    ['pick', 'pick.js'],
    ['lint', 'lint-overlay.js'],
    ['playwright-view', 'playwright-view.js'],
  ] as const) {
    document.getElementById(id)!.addEventListener('click', () => void runPageTool(file));
  }
  testedButton.addEventListener('click', openTestedElements);
  document.getElementById('save-login')!.addEventListener('click', () => void openSaveLogin());
  wireViewport();
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && CONNECTION_KEY in changes) || (area === 'session' && OVERRIDE_KEY in changes)) {
      void refreshTestedButton();
    }
    if (area !== 'session') return;
    if (TAB_KEYS[current].some((key) => key in changes)) void render();
    if (RECORDING_KEY in changes || REPLAY_KEY in changes) void markLiveTabs();
  });
  startNetworkLog(() => {
    if (current === 'network') refreshNetworkList();
  });
  // The Network tab lists the page's own origin and sets conditions for it: a page on another one draws it again.
  chrome.devtools.network.onNavigated.addListener((url) => {
    pagePattern = sitePattern(url);
    void refreshTestedButton(url);
    if (current === 'network' && networkOriginChanged(url)) void render(url);
  });
  // `data-ready` once the toolbar's tools know the page: what an e2e spec waits for before it clicks one.
  void Promise.all([
    inspectedOrigin().then((origin) => {
      pagePattern = sitePattern(origin);
    }),
    refreshTestedButton(),
  ]).then(() => {
    document.documentElement.dataset.ready = 'true';
  });
  select('record');
  void markLiveTabs();
}

void start();
