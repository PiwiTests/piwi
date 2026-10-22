import { highlightLocator, LOCATOR_SYNTAX_CSS } from '@piwitests/picker-dom';
import { renderCopyMode } from '../shared/copy-modes.js';
import { formatNumber, t, tn, tNodes, uiLanguage } from '../shared/i18n.js';
import { getLastCopyMode } from '../shared/storage.js';
import type { CheckedLocator } from './verified-locators.js';
import { getConnectionSettings, isConnected } from '../shared/connection-settings.js';
import { getActiveProjectOverride, resolveActiveProject } from '../shared/active-project.js';
import { pageHere } from '../shared/page-here.js';
import type { PathPrefixes } from '@piwitests/core/page-key';
import { ensureSessionAccess } from '../shared/session-access.js';
import { addNamedPick } from '../shared/session-add.js';
import { getCachedLocatorIndex } from '../shared/locator-index-cache.js';
import { getLocatorBranchOverride, resolveLocatorBranch } from '../shared/locator-branch.js';
import { ALL_BRANCHES } from '@piwitests/core/locator-index';
import { requestLocatorIndex } from '../shared/locator-index-refresh.js';
import { projectLocatorsUrl, testCaseUrl } from '../shared/instance-links.js';
import { elementReach, pageView, scanCoverage, type ReachGroup } from './coverage-scan.js';
import { chainStabilities, usePlace } from './coverage-risk.js';
import { actionLabel, stabilityText } from '../shared/core-words.js';
import { statusLabel, testTitle } from './coverage-view.js';
import { attachPanelShadow } from './panel-root.js';
import { holdFocus } from './modal-panel.js';
import { getEditorPairing } from '../shared/editor-pairing.js';
import { sendToEditor, showSendResult } from '../shared/editor-send.js';
import { bindToTool, toolIsCurrent } from '../shared/tool-session.js';
import { copyWithFeedback } from '../shared/clipboard.js';
import { BUTTON_CSS, makeButton, styleButton } from '../shared/buttons.js';
import { iconText, type IconName } from '../shared/icons.js';
import { COPY_MODE_CSS, copyFacts, copyModeButtons } from './copy-mode-row.js';
import { locatorStability, verdictWords } from '../shared/verdict-words.js';

const HOST_ID = 'piwi-picker-results-host';

export interface ResultsOptions {
  /** Offer Scope to a parent, which reopens the anchors step for the element. */
  canScope?: boolean;
}

/** How the panel ended: dismissed, with a request for the anchors step, or with one to pick another element. */
export type ResultsOutcome = 'closed' | 'scope' | 'pick-another';

/** How many tests the Piwi section lists before pointing at the full view. */
const PIWI_TESTS_SHOWN = 6;

/**
 * Renders the ranked-locator results panel in a closed shadow root — the
 * copy modes are extension-specific (the reporter's equivalent panel,
 * `showPickerChoices`, exists to commit a single replacement, not to browse
 * several source-code renderings of each candidate), so this is native
 * extension UI rather than a reuse of picker-dom's confirm step.
 *
 * `ranked` is already checked against the page (`checkLocators`): the
 * locators finding the picked element alone come first, then those finding it
 * among others, each with the number of elements it finds.
 *
 * With `target` (the picked element) and a connection to a Piwi instance, a
 * section lists the project's tests whose locators reach that element.
 *
 * Resolves once the user dismisses the panel (Escape, the close button, a
 * click outside it, or handing the element over to Tested elements), with
 * `closed`; asks for the anchors step (Scope to a parent, offered with
 * `canScope`), with `scope`; or for another pick (Pick another), with
 * `pick-another`; `closed` too once the tool started as `toolEpoch` ends.
 * While it is open, `target` stays outlined on the page. The caller has run
 * `initI18n()`.
 */
export async function renderResultsPanel(
  ranked: CheckedLocator[],
  target: Element | null,
  toolEpoch: number,
  options: ResultsOptions = {},
): Promise<ResultsOutcome> {
  let activeMode = await getLastCopyMode().catch(() => 'bare' as const);
  const paired = (await getEditorPairing().catch(() => null)) !== null;
  if (!toolIsCurrent(toolEpoch)) return 'closed';
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const openShadow = (globalThis as { __piwiTestOpenShadow?: boolean }).__piwiTestOpenShadow === true;
  const root = attachPanelShadow(host, { mode: openShadow ? 'open' : 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    ${LOCATOR_SYNTAX_CSS}
    ${BUTTON_CSS}
    ${COPY_MODE_CSS}
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,.35);
      display: flex; align-items: flex-start; justify-content: center; padding-top: 8vh;
    }
    .backdrop.spotlit { background: transparent; }
    .backdrop[data-side="start"] { justify-content: flex-start; padding-inline: 16px; }
    .backdrop[data-side="end"] { justify-content: flex-end; padding-inline: 16px; }
    .spotlight {
      position: fixed; pointer-events: none; border: 2px solid #a78bfa; border-radius: 4px;
      box-shadow: 0 0 0 1px rgba(17,24,39,.6), 0 0 0 100vmax rgba(0,0,0,.35);
    }
    .panel {
      position: relative;
      background: #111827; color: #f9fafb; border-radius: 12px; padding: 16px;
      width: min(640px, 92vw); max-height: 78vh; overflow: auto;
      box-shadow: 0 8px 40px rgba(0,0,0,.5); font-size: 13px; line-height: 1.5;
    }
    @media (prefers-color-scheme: light) {
      .panel { background: #ffffff; color: #111827; box-shadow: 0 8px 40px rgba(0,0,0,.2); }
    }
    @media (prefers-reduced-motion: no-preference) {
      .panel { animation: piwi-in 120ms ease-out; }
    }
    @keyframes piwi-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
    .header > div:first-child { min-width: 0; }
    .title { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; hyphens: auto; }
    .sub { color: #9ca3af; font-size: 12px; }
    .header-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: -4px 0 12px; }
    .row {
      display: flex; flex-direction: column; gap: 7px;
      border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 9px 11px; margin-bottom: 8px;
    }
    .row.best { border-color: rgba(167,139,250,.55); background: rgba(124,58,237,.07); }
    .row-top { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
    .word {
      font-size: 11px; font-weight: 600; flex-shrink: 0; white-space: nowrap;
      border: 1px solid currentColor; border-radius: 999px; padding: 0 7px; margin-top: 1px;
    }
    .word.good { color: #4ade80; }
    .word.warn { color: #fbbf24; }
    .order { color: #9ca3af; font-size: 12px; }
    .why { font-size: 11.5px; line-height: 16px; color: #9ca3af; }
    .why summary { cursor: pointer; width: max-content; }
    .why div { margin-top: 3px; overflow-wrap: anywhere; }
    .row code { font-size: 13px; line-height: 1.55; min-width: 0; overflow-wrap: anywhere; }
    .row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .row-actions .send { margin-inline-start: auto; }
    .session-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .session-form input {
      flex: 1 1 180px; min-width: 0; font: inherit; font-size: 12.5px; color: inherit; background: transparent;
      border: 1px solid rgba(128,128,128,.45); border-radius: 6px; padding: 3px 8px;
    }
    .form-message { flex-basis: 100%; color: #fbbf24; font-size: 11.5px; }
    .form-message:empty { display: none; }
    .confirm { display: flex; align-items: flex-start; gap: 5px; font-size: 11.5px; line-height: 16px; color: #4ade80; }
    .confirm .piwi-icon { width: 14px; height: 14px; margin-top: 1px; }
    .unique, .ambiguous, .footer { display: flex; align-items: flex-start; gap: 5px; font-size: 11.5px; line-height: 16px; }
    .unique .piwi-icon, .ambiguous .piwi-icon, .footer .piwi-icon { width: 14px; height: 14px; margin-top: 1px; }
    .unique { color: #4ade80; }
    .ambiguous { color: #fbbf24; }
    .footer { color: #c4b5fd; font-weight: 500; }
    .unique, .ambiguous, .footer, .piwi .lead, .piwi .muted { overflow-wrap: anywhere; hyphens: auto; }
    .piwi li a { overflow-wrap: anywhere; }
    .piwi {
      border: 1px solid #7c3aed66; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;
      background: rgba(124,58,237,.08); font-size: 12.5px;
    }
    .piwi .lead { font-weight: 600; display: flex; align-items: flex-start; gap: 6px; line-height: 18px; }
    .piwi .lead .piwi-icon { color: #c4b5fd; margin-top: 1px; }
    .piwi .group { margin-top: 8px; font-weight: 600; }
    .piwi .muted { color: #9ca3af; font-size: 12px; }
    .piwi ul { list-style: none; margin: 6px 0 0; padding: 0; }
    .piwi li { display: flex; align-items: baseline; gap: 7px; padding: 2px 0; }
    .piwi li .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; align-self: center; background: #64748b; }
    .piwi .dot.passed { background: #10b981; }
    .piwi .dot.failed { background: #e11d48; }
    .piwi .dot.flaky { background: #9333ea; }
    .piwi .dot.skipped { background: #a1a1aa; }
    .piwi li a { color: inherit; text-decoration: underline dotted; text-underline-offset: 2px; }
    .piwi li a:hover { text-decoration-style: solid; }
    .piwi .brittle { display: flex; align-items: flex-start; gap: 5px; margin-top: 6px; color: #fdba74; line-height: 18px; }
    .piwi .brittle .piwi-icon { width: 14px; height: 14px; margin-top: 2px; flex-shrink: 0; }
    .piwi .brittle code { font-size: 12px; }
    .piwi .actions { margin-top: 10px; }
    @media (prefers-color-scheme: light) {
      .piwi .muted { color: #6b7280; }
      .sub { color: #6b7280; }
      .word.good { color: #15803d; }
      .word.warn { color: #b45309; }
      .order, .why { color: #6b7280; }
      .form-message { color: #b45309; }
      .confirm { color: #15803d; }
      .unique { color: #15803d; }
      .ambiguous { color: #b45309; }
      .footer, .piwi .lead .piwi-icon { color: #6d28d9; }
      .row.best { border-color: rgba(124,58,237,.4); background: rgba(124,58,237,.04); }
      .piwi .brittle { color: #c2410c; }
    }
  `;
  root.appendChild(style);

  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.lang = uiLanguage();
  panel.setAttribute('aria-label', t('pick_panelLabel'));
  panel.tabIndex = -1;

  const header = document.createElement('div');
  header.className = 'header';
  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = tn('pick_title', ranked.length);
  const order = document.createElement('div');
  order.className = 'order';
  order.textContent = t('pick_order');
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `${t('common_escToClose')} · ${t('pick_tabHint')}`;
  titleWrap.append(title, order, sub);
  const headerActions = document.createElement('div');
  headerActions.className = 'header-actions';
  const copyAll = makeButton(
    tn('pick_copyAll', ranked.length),
    () => void copyWithFeedback(ranked.map((alt) => alt.locator).join('\n'), copyAll),
    { icon: 'copy', small: true, title: t('pick_copyAllHint'), className: 'copy' },
  );
  headerActions.append(copyAll);
  header.append(titleWrap, headerActions);
  panel.appendChild(header);
  const tools = document.createElement('div');
  tools.className = 'tools';

  const piwiSection = document.createElement('div');
  piwiSection.className = 'piwi';
  piwiSection.hidden = true;
  panel.appendChild(piwiSection);

  return new Promise<ResultsOutcome>((resolve) => {
    let done = false;
    let outcome: ResultsOutcome = 'closed';
    const endWith = (ending: ResultsOutcome) => () => {
      outcome = ending;
      finish();
    };
    const stopSpotlight = target ? spotlight(backdrop, panel, target) : () => {};
    let releaseFocus = () => {};
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish();
      }
    };
    // Escape in an Add to session form closes that form alone, before the tool's own Escape hears it.
    const onFormKeyDown = (e: KeyboardEvent) => {
      const form = e.key === 'Escape' ? root.activeElement?.closest('form.session-form') : null;
      if (!(form instanceof HTMLFormElement)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      form.reset();
    };
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keydown', onFormKeyDown, true);
    const finish = bindToTool(toolEpoch, () => {
      done = true;
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keydown', onFormKeyDown, true);
      stopSpotlight();
      host.remove();
      releaseFocus();
      resolve(outcome);
    });
    headerActions.append(
      makeButton(t('common_close'), finish, { icon: 'close', iconOnly: true, tone: 'ghost', className: 'close' }),
    );
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish();
    });
    tools.appendChild(
      makeButton(t('pick_pickAnother'), endWith('pick-another'), {
        icon: 'pick',
        small: true,
        title: t('pick_pickAnotherHint'),
        className: 'pick-another',
      }),
    );
    if (options.canScope) {
      tools.appendChild(
        makeButton(t('pick_scopeToParent'), endWith('scope'), {
          icon: 'layers',
          small: true,
          title: t('pick_scopeToParentHint'),
          className: 'scope',
        }),
      );
    }
    header.after(tools);

    for (const [i, alt] of ranked.entries()) {
      const best = i === 0 && (alt.verdict === 'unique' || alt.verdict === 'narrowed');
      const row = document.createElement('div');
      row.className = best ? 'row best' : 'row';
      const top = document.createElement('div');
      top.className = 'row-top';
      const verdict = verdictWords({ ...alt, ...locatorStability(alt.locator) });
      const word = document.createElement('span');
      word.className = `word ${verdict.tone}`;
      word.textContent = verdict.word;
      word.title = verdict.explanation;
      const code = document.createElement('code');
      code.className = 'piwi-loc';
      code.innerHTML = highlightLocator(alt.locator);
      top.append(word, code);
      row.appendChild(top);

      const badge = verdictBadge(alt);
      if (badge) row.appendChild(badge);
      row.appendChild(reasons(verdict.explanation, alt.score));
      if (best)
        row.appendChild(withLeadingIcon(document.createElement('div'), 'sparkles', 'footer', t('pick_topPick')));

      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.appendChild(
        copyModeButtons({ ...alt, facts: copyFacts(target) }, panel, activeMode, (mode) => {
          activeMode = mode;
        }),
      );
      const addToSession = makeButton(
        t('devtools_addToSession'),
        () => openSessionForm(row, addToSession, alt.locator),
        { icon: 'plus', small: true, className: 'add-to-session' },
      );
      actions.appendChild(addToSession);
      if (paired) {
        // The mode is the panel's: each row's Send to editor sends the one chosen last.
        const send = makeButton(
          t('pick_sendToEditor'),
          () => {
            void sendToEditor({ kind: 'locator', text: renderCopyMode(alt, activeMode, copyFacts(target)) }).then(
              (result) => showSendResult(send, result),
            );
          },
          { icon: 'send', small: true, className: 'send' },
        );
        actions.appendChild(send);
      }
      row.appendChild(actions);

      panel.appendChild(row);
    }

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    releaseFocus = holdFocus(panel);
    void fillPiwiSection(piwiSection, ranked, target, () => done, finish);
  });
}

type PickCoverage =
  | { status: 'off' | 'checking' | 'unavailable'; message?: string }
  | {
      status: 'ready';
      project: string;
      /** Tests reaching the element or something inside it. */
      tests: string[];
      /** Of those, the ones reaching only something inside it. */
      inside: string[];
      /** Tests reaching only an element around it. */
      around: string[];
      locators: string[];
      /** The brittle locators among those finding the element itself. */
      brittle: string[];
    };

function reportPickCoverage(value: PickCoverage): void {
  (globalThis as { __piwiPickCoverage?: PickCoverage }).__piwiPickCoverage = value;
}

/**
 * Connected mode: which of the project's tests reach the picked element,
 * resolved on this page from the project's locator index. Silent when the
 * extension is not connected or no project is mapped to the page. Handing the
 * element over to Tested elements closes the panel through `close`.
 */
async function fillPiwiSection(
  section: HTMLElement,
  ranked: CheckedLocator[],
  target: Element | null,
  closed: () => boolean,
  close: () => void,
): Promise<void> {
  reportPickCoverage({ status: 'off' });
  if (!target) return;
  let settings: Awaited<ReturnType<typeof getConnectionSettings>>;
  let projectId: number;
  let projectLabel: string;
  let branch: string | null;
  let prefixes: PathPrefixes;
  try {
    await ensureSessionAccess();
    settings = await getConnectionSettings();
    if (!isConnected(settings)) return;
    const override = await getActiveProjectOverride().catch(() => null);
    const project = resolveActiveProject(settings, override, location.href);
    if (!project) return;
    projectId = project.projectId;
    projectLabel = project.projectLabel;
    prefixes = { pathPrefix: project.pathPrefix, testPathPrefix: project.testPathPrefix };
    branch = resolveLocatorBranch(project, await getLocatorBranchOverride(projectId).catch(() => undefined));
  } catch {
    return;
  }

  const findInPiwi = () => {
    const link = document.createElement('a');
    link.href = projectLocatorsUrl(
      settings.instanceUrl,
      projectId,
      ranked.map((alt) => alt.locator),
      branch,
    );
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('pick_findInPiwi');
    return styleButton(link, { icon: 'search', small: true });
  };
  const lead = (text: string) => withLeadingIcon(document.createElement('div'), 'tested', 'lead', text);

  const where =
    branch === ALL_BRANCHES
      ? t('pick_whereAnyBranch', { project: projectLabel })
      : branch
        ? t('pick_whereBranch', { project: projectLabel, branch })
        : projectLabel;
  section.hidden = false;
  section.replaceChildren(lead(t('pick_checking', { where })));
  reportPickCoverage({ status: 'checking' });

  let index = (await getCachedLocatorIndex(projectId, branch).catch(() => null))?.index ?? null;
  if (!index) {
    const answer = await requestLocatorIndex(projectId, { branch });
    if (answer.ok && answer.refreshed) index = answer.index;
    else {
      const muted = document.createElement('div');
      muted.className = 'muted';
      muted.textContent = answer.ok ? t('pick_indexNotReady') : t('pick_indexFailed', { error: answer.error });
      const actions = document.createElement('div');
      actions.className = 'actions piwi-actions';
      actions.appendChild(findInPiwi());
      section.replaceChildren(lead(t('pick_testsOf', { where })), muted, actions);
      reportPickCoverage({ status: 'unavailable', message: muted.textContent });
      return;
    }
  }
  if (closed()) return;

  const fullScan = await scanCoverage(index, document, {
    testIdAttributes: index.testIdAttributes ?? undefined,
    ignore: (element) => (element.getAttribute('id') ?? '').startsWith('piwi-'),
    keepGoing: () => !closed(),
  });
  if (!fullScan || closed()) return;
  // As Tested elements counts by default: what tests do on this page, and uses whose page no run recorded.
  const { key } = pageHere(location.href, prefixes);
  const position = key && index.pages ? index.pages.indexOf(key) : -1;
  const keep = (_entry: number, use: Parameters<typeof usePlace>[0]) =>
    !index!.pages?.length || usePlace(use, position) !== 'elsewhere';
  const scan = index.pages?.length ? pageView(fullScan, index, keep) : fullScan;
  const reach = elementReach(scan, index, target, keep);
  const direct = [...reach.self.tests, ...reach.inside.tests];

  const openCoverage = (scoped: boolean) => {
    if (scoped) (globalThis as { __piwiCoverageScopeRequest?: Element }).__piwiCoverageScopeRequest = target;
    void chrome.runtime.sendMessage({ type: 'piwi-open-coverage' }).catch(() => undefined);
    close();
  };
  const actions = document.createElement('div');
  actions.className = 'actions piwi-actions';
  actions.append(
    findInPiwi(),
    makeButton(t('pick_showInside'), () => openCoverage(true), {
      icon: 'viewport',
      small: true,
      title: t('pick_showInsideHint'),
    }),
    makeButton(t('pick_showAll'), () => openCoverage(false), {
      icon: 'tested',
      small: true,
      title: t('pick_showAllHint'),
    }),
  );

  const muted = (text: string) => {
    const el = document.createElement('div');
    el.className = 'muted';
    el.textContent = text;
    return el;
  };
  const nearest = reach.containers.elements[reach.containers.elements.length - 1];
  const groups: Array<{ label: string; group: ReachGroup }> = [
    { label: t('pick_groupSelf'), group: reach.self },
    { label: tn('pick_groupInside', reach.inside.elements.length), group: reach.inside },
    {
      label:
        reach.containers.elements.length === 1 && nearest
          ? t('pick_groupAroundOne', { element: scan.describe(nearest) })
          : tn('pick_groupAround', reach.containers.elements.length),
      group: reach.containers,
    },
  ].filter(({ group }) => group.tests.length > 0);

  const children: Node[] = [];
  if (direct.length) {
    children.push(lead(tn('pick_reachedBy', direct.length, { where })));
  } else {
    children.push(lead(t('pick_notReached', { where })));
    children.push(muted(reach.containers.tests.length ? t('pick_onlyAround') : t('pick_noneHere')));
  }

  let shown = 0;
  const labelled = groups.length > 1 || groups[0]?.group !== reach.self;
  for (const { label, group } of groups) {
    if (shown >= PIWI_TESTS_SHOWN) break;
    if (labelled) {
      const heading = muted(label);
      heading.classList.add('group');
      children.push(heading);
    }
    const list = document.createElement('ul');
    for (const testIndex of group.tests.slice(0, PIWI_TESTS_SHOWN - shown)) {
      const test = index.tests[testIndex]!;
      const item = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = `dot ${test.status ?? ''}`;
      dot.title = statusLabel(test.status);
      const link = document.createElement('a');
      link.href = testCaseUrl(settings.instanceUrl, test.id);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = testTitle(test);
      link.title = test.file;
      const actionsOf = new Set<string>();
      for (const entry of group.entries) {
        for (const use of index.locators[entry]!.uses)
          if (use.test === testIndex) use.actions.forEach((a) => actionsOf.add(a));
      }
      const meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = [...actionsOf].map(actionLabel).join(', ');
      item.append(dot, link, meta);
      list.appendChild(item);
      shown++;
    }
    children.push(list);
  }
  const total = groups.reduce((sum, { group }) => sum + group.tests.length, 0);
  if (total > shown) children.push(muted(tn('pick_more', total - shown)));
  // Brittle locators finding the element itself: the ranked list above has the stable one to replace them with.
  const stabilities = chainStabilities(index);
  const brittle = reach.self.entries.filter((entry) => stabilities[entry]?.level === 'brittle');
  for (const entry of brittle.slice(0, 3)) {
    const line = document.createElement('div');
    line.className = 'brittle';
    const code = document.createElement('code');
    code.className = 'piwi-loc';
    code.innerHTML = highlightLocator(index.locators[entry]!.locator);
    iconText(line, 'alert', ...tNodes('pick_brittle', { locator: code, reasons: stabilityText(stabilities[entry]!) }));
    children.push(line);
  }
  if (brittle.length) children.push(muted(t('pick_useRankedInstead')));
  children.push(actions);
  section.replaceChildren(...children);
  const titles = (tests: number[]) => tests.map((position) => index!.tests[position]!.title);
  reportPickCoverage({
    status: 'ready',
    project: projectLabel,
    tests: titles(direct),
    inside: titles(reach.inside.tests),
    around: titles(reach.containers.tests),
    locators: [...reach.self.entries, ...reach.inside.entries].map((e) => index!.locators[e]!.locator),
    brittle: brittle.map((e) => index!.locators[e]!.locator),
  });
}

/** `el` with `className`, saying `text` after the icon `name`. */
function withLeadingIcon<T extends HTMLElement>(el: T, name: IconName, className: string, text: string): T {
  el.className = className;
  return iconText(el, name, text);
}

/**
 * Rings `target` on the page under the panel, the rest of the page dimmed
 * around it, following it as the page scrolls or moves it; the backdrop dims
 * everything while it is off screen or gone. The first time the ring falls
 * under `panel`, the panel moves to the side of the page away from it, and
 * stays there. Returns the function that stops following it.
 */
function spotlight(backdrop: HTMLElement, panel: HTMLElement, target: Element): () => void {
  const ring = document.createElement('div');
  ring.className = 'spotlight';
  ring.hidden = true;
  backdrop.prepend(ring);
  let placed = '';
  let frame = 0;
  const place = () => {
    const box = target.isConnected ? target.getBoundingClientRect() : null;
    const onScreen =
      box !== null &&
      box.width + box.height > 0 &&
      box.bottom > 0 &&
      box.right > 0 &&
      box.top < innerHeight &&
      box.left < innerWidth;
    const key = onScreen ? `${box.left} ${box.top} ${box.width} ${box.height}` : '';
    if (key !== placed) {
      placed = key;
      ring.hidden = !onScreen;
      backdrop.classList.toggle('spotlit', onScreen);
      if (onScreen) {
        ring.style.left = `${box.left - 3}px`;
        ring.style.top = `${box.top - 3}px`;
        ring.style.width = `${box.width + 6}px`;
        ring.style.height = `${box.height + 6}px`;
      }
    }
    if (onScreen && !backdrop.dataset.side) {
      const over = panel.getBoundingClientRect();
      const covered =
        over.width > 0 &&
        box.left < over.right &&
        box.right > over.left &&
        box.top < over.bottom &&
        box.bottom > over.top;
      if (covered) backdrop.dataset.side = box.left + box.width / 2 < innerWidth / 2 ? 'end' : 'start';
    }
    frame = requestAnimationFrame(place);
  };
  place();
  return () => cancelAnimationFrame(frame);
}

/**
 * Under `row`, a form naming `locator` for the pick session the DevTools
 * panel's Session tab lists, kept by `addNamedPick` as the DevTools pages keep
 * it: the name a page object field takes, the locator, and this page's
 * address. It is drawn here, in the panel's shadow root, with the panel's
 * buttons. Cancel and Escape (the form's reset) close it and give the focus
 * back to `opener`.
 */
function openSessionForm(row: HTMLElement, opener: HTMLElement, locator: string): void {
  row.querySelector('.session-form')?.remove();
  row.querySelector('.confirm')?.remove();
  const form = document.createElement('form');
  form.className = 'session-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = t('session_namePlaceholder');
  input.setAttribute('aria-label', t('session_nameLabel'));
  // Save submits the form, which checks the name.
  const save = makeButton(t('common_save'), () => undefined, { icon: 'save', tone: 'primary', small: true });
  save.type = 'submit';
  const cancel = makeButton(t('common_cancel'), () => undefined, { icon: 'close', small: true });
  cancel.type = 'reset';
  const message = document.createElement('div');
  message.className = 'form-message';
  message.setAttribute('role', 'status');
  form.append(input, save, cancel, message);
  form.addEventListener('reset', () => {
    form.remove();
    opener.focus();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      const name = input.value.trim();
      await ensureSessionAccess();
      const refused = await addNamedPick(name, locator, () => location.href);
      if (refused !== null) {
        message.textContent = refused;
        return;
      }
      form.remove();
      const added = document.createElement('code');
      added.textContent = name;
      const confirm = document.createElement('div');
      confirm.className = 'confirm';
      confirm.setAttribute('role', 'status');
      row.appendChild(iconText(confirm, 'check-circle', ...tNodes('devtools_addedToSession', { name: added })));
      opener.focus();
    })();
  });
  row.appendChild(form);
  input.focus();
}

/** The row's details: the verdict and the stability rules in full, and the engine's score. */
function reasons(explanation: string, score: number): HTMLElement {
  const details = document.createElement('details');
  details.className = 'why';
  const summary = document.createElement('summary');
  summary.textContent = t('pick_reasons');
  const words = document.createElement('div');
  words.className = 'explanation';
  words.textContent = explanation;
  const value = document.createElement('div');
  value.className = 'score';
  value.textContent = t('pick_scoreValue', { score: formatNumber(score) });
  value.title = t('pick_score');
  details.append(summary, words, value);
  return details;
}

/** What the engine found for a locator, under it; nothing for one it could not evaluate. */
function verdictBadge(alt: CheckedLocator): HTMLElement | null {
  const badge = document.createElement('div');
  switch (alt.verdict) {
    case 'unique':
      return withLeadingIcon(badge, 'check-circle', 'unique', t('pick_unique'));
    case 'narrowed':
      return withLeadingIcon(badge, 'check-circle', 'unique', tn('pick_narrowed', alt.from!.count));
    case 'position':
      return withLeadingIcon(badge, 'alert', 'ambiguous', tn('pick_byPosition', alt.from!.count));
    case 'ambiguous':
      return withLeadingIcon(
        badge,
        'alert',
        'ambiguous',
        tn('pick_ambiguous', alt.count!, { first: '.first()', filter: '.filter({ hasText: … })' }),
      );
    case 'unchecked':
      return null;
  }
}
