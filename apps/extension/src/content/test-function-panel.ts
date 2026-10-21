import { initI18n, t, tn, uiLanguage } from '../shared/i18n.js';
import { startTool, endTool, installEscapeToCancel, toolIsCurrent } from '../shared/tool-session.js';
import { TAG_TO_ROLE, INPUT_TYPE_TO_ROLE } from '@piwitests/core/locator-generation';
import { testCatalogAgainstPage, type FunctionTestResult } from './test-function-scan.js';
import { createPageEngine } from './verified-locators.js';
import { getCachedCatalog } from '../shared/catalog-cache.js';
import { requestCatalogRefresh } from '../shared/catalog-refresh.js';
import { ensureSessionAccess } from '../shared/session-access.js';
import { getConnectionSettings, type ConnectionSettings } from '../shared/connection-settings.js';
import { projectCatalogUrl } from '../shared/instance-links.js';
import { getActiveProjectOverride, resolveActiveProject, type ActiveProject } from '../shared/active-project.js';
import { attachPanelShadow } from './panel-root.js';
import { holdFocus } from './modal-panel.js';
import { BUTTON_CSS, makeButton } from '../shared/buttons.js';
import { icon, iconText, setLabel, type IconName } from '../shared/icons.js';

const HOST_ID = 'piwi-test-function-host';
const MAPS = { tagRoles: TAG_TO_ROLE, inputRoles: INPUT_TYPE_TO_ROLE };

/** A function's verdict, and a step's, by icon. */
const VERDICT_ICONS: Record<FunctionTestResult['verdict'], IconName> = {
  ready: 'check-circle',
  partial: 'alert',
  'not-found': 'missing',
};
const STEP_ICONS: Record<FunctionTestResult['steps'][number]['verdict'], IconName> = {
  unique: 'check',
  ambiguous: 'alert',
  missing: 'close',
};

function verdictLabel(verdict: FunctionTestResult['verdict']): string {
  if (verdict === 'ready') return t('functions_ready');
  if (verdict === 'partial') return t('functions_partial');
  return t('functions_notFound');
}

function stepLabel(step: FunctionTestResult['steps'][number]): string {
  if (step.verdict === 'unique') return t('functions_stepUnique', { action: step.action });
  if (step.verdict === 'ambiguous') return tn('functions_stepAmbiguous', step.matchCount, { action: step.action });
  return t('functions_stepMissing', { action: step.action });
}

function renderResult(result: FunctionTestResult): HTMLElement {
  const row = document.createElement('div');
  row.className = `row ${result.verdict}`;

  const top = document.createElement('div');
  top.className = 'row-top';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = result.entry.name;
  const badge = document.createElement('span');
  badge.className = `badge ${result.verdict}`;
  const verdict = document.createElement('span');
  verdict.textContent = verdictLabel(result.verdict);
  badge.append(icon(VERDICT_ICONS[result.verdict]), verdict);
  top.append(name, badge);
  row.appendChild(top);

  const steps = document.createElement('div');
  steps.className = 'steps';
  for (const step of result.steps) {
    const line = document.createElement('div');
    line.className = `step ${step.verdict}`;
    iconText(line, STEP_ICONS[step.verdict], stepLabel(step));
    steps.appendChild(line);
  }
  row.appendChild(steps);

  return row;
}

async function renderPanel(): Promise<void> {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  let closed = false;
  let releaseFocus = () => {};
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') finish();
  };
  const finish = () => {
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    host.remove();
    releaseFocus();
    endTool(toolEpoch);
  };
  // The page is claimed before the host is mounted: the tool this replaces,
  // this panel included, takes its surfaces with it here.
  const toolEpoch = startTool('test-function-panel', finish);
  installEscapeToCancel();
  /** False once the panel is closed or another tool took over: what an `await` brings back is then dropped. */
  const live = () => !closed && toolIsCurrent(toolEpoch);

  // `getActiveProjectOverride` reads session storage — see `session-access.ts`.
  let connection: ConnectionSettings;
  let override: ActiveProject | null;
  try {
    await ensureSessionAccess();
    [connection, override] = await Promise.all([
      getConnectionSettings(),
      getActiveProjectOverride().catch(() => null),
      initI18n(),
    ]);
  } catch {
    finish();
    return;
  }
  if (!live()) return;

  // Mounted once there is a panel to show, so a read that fails leaves nothing over the page.
  document.getElementById(HOST_ID)?.remove();
  document.documentElement.appendChild(host);
  const root = attachPanelShadow(host, { mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    ${BUTTON_CSS}
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: flex-start; justify-content: center; padding-top: 8vh; }
    .panel { background: #111827; color: #f9fafb; border-radius: 12px; padding: 16px; width: min(560px, 92vw); max-height: 78vh;
      overflow: auto; box-shadow: 0 8px 40px rgba(0,0,0,.5); font-size: 13px; line-height: 1.5; }
    @media (prefers-color-scheme: light) { .panel { background: #ffffff; color: #111827; box-shadow: 0 8px 40px rgba(0,0,0,.2); } }
    .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
    .header > div:first-child { min-width: 0; }
    .title { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; hyphens: auto; }
    .sub { color: #9ca3af; font-size: 12px; }
    .manage-link { color: #a78bfa; text-decoration: none; overflow-wrap: anywhere; }
    .manage-link:hover, .manage-link:focus-visible { text-decoration: underline; }
    .header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .refresh { white-space: nowrap; }
    .refresh-error { color: #eab308; font-size: 11.5px; padding: 4px 0 8px; overflow-wrap: anywhere; }
    .empty { color: #9ca3af; font-size: 12.5px; padding: 8px 0; overflow-wrap: anywhere; hyphens: auto; }
    .row { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 9px 11px; margin-bottom: 8px; }
    .row.ready { border-color: rgba(34,197,94,.4); }
    .row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
    .badge {
      display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 500; line-height: 16px;
      padding: 2px 8px 2px 6px; border-radius: 999px; flex-shrink: 0; max-width: 55%;
    }
    .badge .piwi-icon { width: 12px; height: 12px; flex-shrink: 0; }
    .step .piwi-icon { width: 14px; height: 14px; flex-shrink: 0; }
    .badge.ready { background: rgba(34,197,94,.2); color: #4ade80; }
    .badge.partial { background: rgba(234,179,8,.2); color: #facc15; }
    .badge.not-found { background: rgba(128,128,128,.2); color: #9ca3af; }
    .steps { margin-top: 7px; display: flex; flex-direction: column; gap: 3px; }
    .step {
      display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; line-height: 16px; color: #9ca3af;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere;
    }
    .step .piwi-icon { margin-top: 1px; }
    .step.unique { color: #4ade80; }
    .step.ambiguous { color: #facc15; }
    .step.missing { color: #fca5a5; }
    @media (prefers-color-scheme: light) {
      .sub, .empty, .step, .badge.not-found { color: #6b7280; }
      .manage-link { color: #6d28d9; }
      .refresh-error, .step.ambiguous, .badge.partial { color: #a16207; }
      .step.unique, .badge.ready { color: #15803d; }
      .step.missing { color: #b91c1c; }
      .row.ready { border-color: rgba(21,128,61,.35); }
    }
  `;
  root.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.tabIndex = -1;
  panel.lang = uiLanguage();
  panel.setAttribute('aria-label', t('functions_title'));
  const activeProject = resolveActiveProject(connection, override, location.href);
  const projectId = activeProject?.projectId ?? null;

  const header = document.createElement('div');
  header.className = 'header';
  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = t('functions_title');
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.append(t('common_escToClose'));
  if (activeProject != null && connection.instanceUrl.trim()) {
    sub.append(' · ');
    const manageLink = document.createElement('a');
    manageLink.className = 'manage-link';
    manageLink.href = projectCatalogUrl(connection.instanceUrl, activeProject.projectId);
    manageLink.target = '_blank';
    manageLink.rel = 'noopener noreferrer';
    manageLink.textContent = t('functions_manage', { project: activeProject.projectLabel });
    sub.appendChild(manageLink);
  }
  titleWrap.append(title, sub);

  const actions = document.createElement('div');
  actions.className = 'header-actions';
  const refreshBtn = makeButton(t('common_refresh'), () => void revalidate(true), {
    icon: 'refresh',
    small: true,
    title: t('functions_refreshHint'),
    className: 'refresh',
  });
  if (projectId == null) refreshBtn.disabled = true;
  const closeBtn = makeButton(t('common_close'), finish, {
    icon: 'close',
    iconOnly: true,
    tone: 'ghost',
    className: 'close',
  });
  actions.append(refreshBtn, closeBtn);
  header.append(titleWrap, actions);
  panel.appendChild(header);

  const resultsEl = document.createElement('div');
  panel.appendChild(resultsEl);

  function renderResults(catalog: Awaited<ReturnType<typeof getCachedCatalog>>): void {
    resultsEl.replaceChildren();
    if (catalog.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent =
        activeProject == null
          ? t('functions_noProject')
          : t('functions_empty', { project: activeProject.projectLabel });
      resultsEl.appendChild(empty);
      return;
    }
    const engine = createPageEngine(document);
    const results = testCatalogAgainstPage(catalog, MAPS, {
      elements: engine.elements(),
      nameOf: (el) => engine.model.normalizedAccessibleName(el, false) || null,
      isHidden: (el) => engine.model.isHiddenForAria(el),
    });
    const order = { ready: 0, partial: 1, 'not-found': 2 };
    results.sort((a, b) => order[a.verdict] - order[b.verdict]);
    for (const result of results) resultsEl.appendChild(renderResult(result));
  }

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) finish();
  });
  document.addEventListener('keydown', onKeyDown, true);

  backdrop.appendChild(panel);
  root.appendChild(backdrop);
  releaseFocus = holdFocus(panel);

  /** The cached catalog, or null, saying so in the list, when it cannot be read. */
  const readCatalog = async (): Promise<Awaited<ReturnType<typeof getCachedCatalog>> | null> => {
    try {
      return await getCachedCatalog(projectId);
    } catch {
      if (!live()) return null;
      const failed = document.createElement('div');
      failed.className = 'empty';
      failed.textContent = t('functions_cacheFailed');
      resultsEl.replaceChildren(failed);
      return null;
    }
  };

  // Cache first so the panel is instant and still works with the instance
  // unreachable; the re-fetch below then swaps in anything newer.
  const cached = await readCatalog();
  if (!live()) return;
  if (cached) renderResults(cached);

  async function revalidate(force: boolean): Promise<void> {
    if (projectId == null) return;
    refreshBtn.disabled = true;
    if (force) setLabel(refreshBtn, t('common_refreshing'));
    const result = await requestCatalogRefresh(projectId, { force });
    if (!live()) return;
    if (result.ok && result.refreshed) {
      const refreshed = await readCatalog();
      if (!live()) return;
      if (refreshed) renderResults(refreshed);
    }
    setLabel(refreshBtn, t('common_refresh'));
    refreshBtn.disabled = false;
    if (!result.ok && force) {
      const failed = document.createElement('div');
      failed.className = 'refresh-error';
      failed.textContent = t('functions_refreshFailed', { error: result.error });
      resultsEl.prepend(failed);
    }
  }

  // Opening the panel is itself a "show me the current catalog" request —
  // TTL-guarded so repeated opens don't hit the instance every time.
  void revalidate(false);
}

/** Re-injecting while the panel is already open just re-runs the scan against the page's current state instead of stacking a second host. */
async function runTestFunctionPanel(): Promise<void> {
  await renderPanel();
}

void runTestFunctionPanel();
