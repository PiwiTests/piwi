/**
 * The coverage overlay's side panel: the page's summary (interactive elements
 * reached by a test, the untested ones, the tests reaching the page), three
 * lists to explore it — tested elements, tests, untested elements — and the
 * display toggles. Collapses to a pill that keeps the summary in view.
 */
import { highlightLocator } from '@piwitests/picker-dom';
import { ALL_BRANCHES } from '@piwitests/core/locator-index';
import { actionLabel, stabilityText } from '../shared/core-words.js';
import { editText, type BrittleRow, type PageRiskRow, type Replacement } from './coverage-risk.js';
import type { CoveredElement, UncoveredElement } from './coverage-scan.js';
import {
  ageLabel,
  isScoped,
  isSingular,
  kindShown,
  riskCount,
  statusLabel,
  testTitle,
  worstStatus,
  type CoverageContext,
  type CoverageTab,
  type ViewState,
} from './coverage-view.js';
import { testCaseUrl } from '../shared/instance-links.js';
import { formatNumber, t, tn, tNodes, uiLanguage } from '../shared/i18n.js';
import { copyWithFeedback } from '../shared/clipboard.js';
import { makeButton } from '../shared/buttons.js';
import { icon, withIcon, type IconName } from '../shared/icons.js';
import { urlView } from '../shared/step-view.js';

export type PanelStatus = 'loading' | 'not-connected' | 'no-project' | 'error' | 'ready';

export interface PanelModel {
  status: PanelStatus;
  /** The page shows a modal dialog, which makes everything outside it inert, this panel included. */
  modalOpen: boolean;
  message: string | null;
  projectLabel: string | null;
  context: CoverageContext | null;
  fetchedAt: number | null;
  refreshing: boolean;
  refreshError: string | null;
  scanning: { done: number; total: number } | null;
  state: ViewState;
  /** The branch asked for: a name, `*` for every branch, null for the default branch. */
  branch: string | null;
  /** How the element the view is limited to reads in the lists. */
  scopeLabel: string | null;
  /** The view can widen to a container of that element before reaching the whole page. */
  canWiden: boolean;
}

export interface PanelCallbacks {
  onClose(): void;
  onCollapse(collapsed: boolean): void;
  onDock(): void;
  onRefresh(): void;
  /** '' for the default branch, `*` for every branch, else a branch. */
  onBranch(value: string): void;
  onOpenSettings(): void;
  onTab(tab: CoverageTab): void;
  onQuery(query: string): void;
  onToggle(key: 'showOperated' | 'showChecked' | 'showUncovered' | 'heatmap' | 'showBrittle'): void;
  onElementHover(element: Element | null): void;
  onElementSelect(element: Element): void;
  onTestHover(test: number | null): void;
  onTestSelect(test: number): void;
  onChooseScope(): void;
  onCancelChoosing(): void;
  onWidenScope(): void;
  onClearScope(): void;
  onContainerHover(element: Element | null): void;
  onContainerSelect(element: Element): void;
  suggestLocator(element: Element): string | null;
  /** A replacement for the chain at `entry`, which finds only `element` here. */
  replacementFor(element: Element, entry: number): Replacement | null;
  /** Count what tests do on this page only, or on every page. */
  onPageScope(scope: 'page' | 'all'): void;
}

/** Containers listed around the element the view is limited to. */
const AROUND_ROWS = 3;

/** Rows rendered per list, so a page with thousands of matches stays fast; the search narrows the rest. */
const MAX_ROWS = 300;
/** Untested rows that get a generated locator. */
const MAX_SUGGESTIONS = 60;

/** Where the focus was among what `render` replaces: the key of the nearest keyed element, and the way down from it. */
interface FocusMark {
  key: string;
  path: number[];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A locator, highlighted: a `code` in a row of its own, a `span` inside a line of text. */
function locatorCode(tag: 'code' | 'span', locator: string): HTMLElement {
  const node = el(tag, 'piwi-loc');
  node.innerHTML = highlightLocator(locator);
  return node;
}

/** The progress bar's fill, as a transform: it moves without laying out or painting the panel again. */
function progressTransform({ done, total }: { done: number; total: number }): string {
  return `scaleX(${total ? done / total : 0})`;
}

/** The page in the subtitle, saying which of the URL mapping's path prefixes were removed or added to key it. */
function subtitlePage(context: CoverageContext): Array<Node | string> | null {
  const { pageKey, prefixRemoved: removed, prefixAdded: added } = context;
  if (!pageKey) return null;
  const page = urlView(pageKey);
  if (removed && added) return tNodes('coverage_subtitleSwappedPrefix', { page, removed, added });
  if (removed) return tNodes('coverage_subtitleWithoutPrefix', { page, prefix: removed });
  if (added) return tNodes('coverage_subtitleWithPrefix', { page, prefix: added });
  return [page];
}

/** The first call site, in code, and how many more there are. */
function callSites(sites: readonly string[]): HTMLElement {
  return el('span', 'site', `${sites[0]}${sites.length > 1 ? ` +${sites.length - 1}` : ''}`);
}

/** `parts` with ` · ` between them. */
function joined(parts: Array<Node | string>): Array<Node | string> {
  return parts.flatMap((part, i) => (i === 0 ? [part] : [' · ', part]));
}

/** A count set apart as a badge, for a tab or a section heading. */
function countBadge(count: number, tone?: string): HTMLElement {
  return el('span', tone ? `count-badge ${tone}` : 'count-badge', formatNumber(count));
}

/** A section heading of At risk: its icon, and its words with the count as a badge. */
function sectionHead(name: IconName, words: Array<Node | string>): HTMLElement {
  const head = el('h3', 'section-head');
  head.append(icon(name), ...words);
  return head;
}

export class CoveragePanel {
  private readonly panel: HTMLElement;
  private readonly pill: HTMLButtonElement;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly body: HTMLElement;
  /** What `render` replaces, above and below the search, which stays put so typing in it keeps its focus. */
  private readonly upper: HTMLElement;
  private readonly lower: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly toggles = new Map<string, HTMLInputElement>();
  private readonly dock: HTMLButtonElement;
  /** Whether the notes were open in the last render, so a render keeps them as the reader left them. */
  private notesOpen = false;
  /** The fill of the progress bar the last render drew, while the page is checked. */
  private progressFill: HTMLElement | null = null;

  constructor(
    parent: ShadowRoot,
    private readonly callbacks: PanelCallbacks,
  ) {
    this.panel = el('aside', 'panel');
    this.panel.setAttribute('role', 'dialog');
    this.panel.lang = uiLanguage();
    this.panel.setAttribute('aria-label', t('coverage_panelLabel'));

    const head = el('div', 'head');
    const titles = el('div');
    this.titleEl = el('div', 'title', t('coverage_title'));
    this.subEl = el('div', 'sub');
    titles.append(this.titleEl, this.subEl);
    const icons = el('div', 'icons');
    this.dock = this.iconButton('arrow-left', t('coverage_dock'), () => callbacks.onDock());
    const collapse = this.iconButton('minus', t('coverage_collapse'), () => callbacks.onCollapse(true));
    const close = this.iconButton('close', t('coverage_closeEsc'), () => callbacks.onClose());
    icons.append(this.dock, collapse, close);
    head.append(titles, icons);

    this.body = el('div', 'body');
    this.upper = el('div');
    this.lower = el('div');
    this.search = el('input', 'search');
    this.search.type = 'search';
    this.search.placeholder = t('coverage_search');
    this.search.setAttribute('aria-label', t('coverage_searchLabel'));
    this.search.addEventListener('input', () => callbacks.onQuery(this.search.value));
    this.body.append(this.upper, this.search, this.lower);

    this.foot = el('div', 'foot');
    const toggles = el('div', 'toggles');
    for (const [key, label, title] of [
      ['showOperated', t('coverage_toggleActed'), t('coverage_toggleActedTitle')],
      ['showChecked', t('coverage_toggleChecked'), t('coverage_toggleCheckedTitle')],
      ['showUncovered', t('coverage_toggleUntested'), t('coverage_toggleUntestedTitle')],
      ['heatmap', t('coverage_toggleHeat'), t('coverage_toggleHeatTitle')],
      ['showBrittle', t('coverage_toggleBrittle'), t('coverage_toggleBrittleTitle')],
    ] as const) {
      const wrap = el('label');
      wrap.title = title;
      const input = el('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => callbacks.onToggle(key));
      this.toggles.set(key, input);
      wrap.append(input, label);
      toggles.appendChild(wrap);
    }
    const legend = el('div', 'legend');
    for (const [cls, label] of [
      ['swatch operated', t('coverage_legendActed')],
      ['swatch checked', t('coverage_legendChecked')],
      ['swatch uncovered', t('coverage_legendUntested')],
      ['dotted', t('coverage_legendAmbiguous')],
      ['swatch brittle', t('coverage_legendBrittle')],
    ] as const) {
      const item = el('span');
      item.append(el('span', cls), label);
      legend.appendChild(item);
    }
    this.foot.append(toggles, legend);

    this.panel.append(head, this.body, this.foot);
    parent.appendChild(this.panel);

    this.pill = el('button', 'pill');
    this.pill.type = 'button';
    this.pill.lang = uiLanguage();
    this.pill.title = t('coverage_expand');
    this.pill.addEventListener('click', () => callbacks.onCollapse(false));
    parent.appendChild(this.pill);
  }

  private iconButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
    return makeButton(title, onClick, { icon: name, iconOnly: true, tone: 'ghost', small: true });
  }

  destroy(): void {
    this.panel.remove();
    this.pill.remove();
  }

  /**
   * What Escape does in the search: clears its text, when it has the focus
   * and some. True when it did; the overlay calls it before an Escape closes
   * anything else.
   */
  clearSearch(): boolean {
    if (!this.search.value || !this.search.matches(':focus')) return false;
    this.search.value = '';
    this.callbacks.onQuery('');
    return true;
  }

  private focusMark(): FocusMark | null {
    let node = (this.panel.getRootNode() as ShadowRoot).activeElement;
    if (!node || !(this.upper.contains(node) || this.lower.contains(node))) return null;
    const path: number[] = [];
    while (node && node !== this.upper && node !== this.lower) {
      const key = (node as HTMLElement).dataset.key;
      if (key) return { key, path };
      const parent: Element = node.parentElement!;
      path.unshift([...parent.children].indexOf(node));
      node = parent;
    }
    return null;
  }

  /** Focuses the counterpart of the element `mark` was taken from in what was just rendered, if there is one. */
  private restoreFocus(mark: FocusMark | null): void {
    if (!mark) return;
    let node: Element | null = this.body.querySelector(`[data-key="${mark.key}"]`);
    for (const index of mark.path) node = node?.children[index] ?? null;
    (node as HTMLElement | null)?.focus({ preventScroll: true });
  }

  /** Moves the progress bar the last render drew, without drawing the rest of the panel again. */
  setProgress(scanning: { done: number; total: number }): void {
    if (this.progressFill) this.progressFill.style.transform = progressTransform(scanning);
  }

  render(model: PanelModel): void {
    const { state } = model;
    this.progressFill = null;
    this.panel.classList.toggle('left', state.dock === 'left');
    this.pill.classList.toggle('left', state.dock === 'left');
    const dockIcon: IconName = state.dock === 'left' ? 'arrow-right' : 'arrow-left';
    if (this.dock.querySelector('svg')?.dataset.icon !== dockIcon) withIcon(this.dock, dockIcon);
    this.panel.style.display = state.collapsed ? 'none' : '';
    this.pill.style.display = state.collapsed ? '' : 'none';
    for (const [key, input] of this.toggles) input.checked = state[key as keyof ViewState] === true;

    const page = model.context ? subtitlePage(model.context) : null;
    const sub: Array<Node | string> = [];
    if (model.projectLabel) sub.push(el('span', 'project', model.projectLabel), ' · ');
    if (page) sub.push(...page, ' · ');
    this.subEl.replaceChildren(...sub, t('common_escToClose'));
    this.renderPill(model);

    // The page rescans while the reader works in the panel: a render keeps the
    // focus and the notes where they were.
    const focus = this.focusMark();
    const shownNotes = this.lower.querySelector<HTMLDetailsElement>('details.notes');
    if (shownNotes) this.notesOpen = shownNotes.open;

    if (model.status !== 'ready' || !model.context) {
      this.foot.style.display = 'none';
      this.search.hidden = true;
      this.upper.replaceChildren(...this.renderMessage(model));
      this.lower.replaceChildren();
      this.restoreFocus(focus);
      return;
    }
    this.foot.style.display = '';
    this.search.hidden = false;
    const context = model.context;
    const upper: Node[] = [];
    if (model.modalOpen) {
      upper.push(el('p', 'message', t('coverage_modalOpen')));
    }
    upper.push(...this.renderSummary(model, context));
    const around = this.renderAround(context);
    if (around) upper.push(around);
    upper.push(this.renderTabs(state.tab, context));
    if (this.search.value !== state.query) this.search.value = state.query;
    const lower: Node[] = [this.renderList(state, context)];
    const notes = this.renderNotes(context);
    if (notes) lower.push(notes);
    this.upper.replaceChildren(...upper);
    this.lower.replaceChildren(...lower);
    this.restoreFocus(focus);
  }

  private renderPill(model: PanelModel): void {
    const scan = model.context?.scan;
    this.pill.replaceChildren();
    const swatch = el('span', 'swatch');
    swatch.style.background = '#10b981';
    this.pill.appendChild(swatch);
    if (scan) {
      const total = scan.coveredInteractive + scan.uncoveredCount;
      this.pill.append(
        tn('coverage_pill', scan.coveredInteractive, {
          total: formatNumber(total),
          tests: tn('coverage_testCount', scan.tests.length),
        }),
      );
      // Tests find these as soon as the page loads: the strongest sign a test will fail here.
      const missing = model.context!.missing.filter((row) => row.arrival).length;
      if (missing) this.pill.append(` · ${tn('coverage_pillMissing', missing)}`);
    } else {
      this.pill.append(t('coverage_pillIdle'));
    }
  }

  private renderMessage(model: PanelModel): Node[] {
    const out: Node[] = [];
    const message = el('p', model.status === 'error' ? 'message error' : 'message', model.message ?? '');
    out.push(message);
    if (model.status === 'not-connected' || model.status === 'no-project') {
      const button = makeButton(t('coverage_openSettings'), () => this.callbacks.onOpenSettings(), {
        icon: 'settings',
        tone: 'primary',
      });
      button.dataset.key = 'settings';
      out.push(button);
    } else if (model.status === 'error') {
      const button = makeButton(t('coverage_tryAgain'), () => this.callbacks.onRefresh(), {
        icon: 'refresh',
        tone: 'primary',
      });
      button.dataset.key = 'retry';
      out.push(button);
    }
    return out;
  }

  private renderSummary(model: PanelModel, context: CoverageContext): Node[] {
    const { scan, index } = context;
    const out: Node[] = [];
    const status = el('div', 'status-line');
    const refresh = makeButton(
      model.refreshing ? t('common_refreshing') : t('common_refresh'),
      () => this.callbacks.onRefresh(),
      { icon: 'refresh', small: true, tone: 'ghost', title: t('coverage_refreshTitle'), className: 'refresh' },
    );
    refresh.dataset.key = 'refresh';
    refresh.disabled = model.refreshing;
    const size = el(
      'span',
      'index-size',
      tn('coverage_indexSize', index.locators.length, { tests: tn('coverage_testCount', index.tests.length) }),
    );
    if (model.fetchedAt) size.append(` · ${t('coverage_updated', { age: ageLabel(model.fetchedAt) })}`);
    status.append(this.renderBranchSelect(model, context), refresh, size);
    out.push(status);
    if (model.refreshError)
      out.push(el('p', 'message error', t('coverage_refreshFailed', { error: model.refreshError })));
    if (model.scanning) {
      const bar = el('div', 'progress');
      const fill = el('span');
      fill.style.transform = progressTransform(model.scanning);
      this.progressFill = fill;
      bar.appendChild(fill);
      bar.title = t('coverage_checking');
      out.push(bar);
    }

    const pageSwitch = this.renderPageSwitch(model, context);
    if (pageSwitch) out.push(pageSwitch);
    out.push(this.renderScopeBar(model));

    const inside = isScoped(scan);
    const total = scan.coveredInteractive + scan.uncoveredCount;
    const summary = el('div', 'summary');
    const tile = (cls: string, n: number, label: string, title: string) => {
      const box = el('div', `tile ${cls}`);
      box.title = title;
      box.append(el('div', 'n', formatNumber(n)), el('div', 'l', label));
      return box;
    };
    const oneTest = isSingular(scan.tests.length);
    summary.append(
      tile(
        'operated',
        scan.coveredInteractive,
        t('coverage_tileTested'),
        inside ? t('coverage_tileTestedTitleInside') : t('coverage_tileTestedTitle'),
      ),
      tile(
        'uncovered',
        scan.uncoveredCount,
        t('coverage_tileUntested'),
        inside ? t('coverage_tileUntestedTitleInside') : t('coverage_tileUntestedTitle'),
      ),
      tile(
        'tests',
        scan.tests.length,
        inside
          ? t(oneTest ? 'coverage_tileTestInside' : 'coverage_tileTestsInside')
          : t(oneTest ? 'coverage_tileTestHere' : 'coverage_tileTestsHere'),
        inside ? t('coverage_tileTestsTitleInside') : t('coverage_tileTestsTitle'),
      ),
    );
    out.push(summary);
    const meter = el('div', 'meter');
    const fill = el('span');
    const percent = total ? Math.round((scan.coveredInteractive / total) * 100) : 0;
    fill.style.width = `${percent}%`;
    meter.appendChild(fill);
    meter.setAttribute('role', 'img');
    meter.setAttribute('aria-label', t('coverage_meterLabel', { percent: formatNumber(percent) }));
    out.push(meter);
    const checkedOnly = scan.covered.filter((c) => c.kind === 'checked').length;
    const brittle = context.brittleElements.size;
    const parts = total
      ? [
          tn(inside ? 'coverage_meterShareInside' : 'coverage_meterShare', total, { percent: formatNumber(percent) }),
          tn('coverage_meterFound', scan.covered.length, { checked: formatNumber(checkedOnly) }),
        ]
      : [
          inside ? t('coverage_meterNoneInside') : t('coverage_meterNone'),
          tn('coverage_meterFoundOnly', scan.covered.length),
        ];
    if (brittle) parts.push(tn('coverage_meterBrittle', brittle));
    out.push(el('div', 'meter-label', parts.join(' · ')));
    return out;
  }

  /** This page / All pages, when the index records the page each use was made on. */
  private renderPageSwitch(model: PanelModel, context: CoverageContext): HTMLElement | null {
    if (!context.hasPages) return null;
    const bar = el('div', 'page-switch');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', t('coverage_pageSwitch'));
    for (const [scope, label, title, glyph] of [
      ['page', t('coverage_thisPage'), t('coverage_thisPageTitle'), 'file'],
      ['all', t('coverage_allPages'), t('coverage_allPagesTitle'), 'layers'],
    ] as const) {
      const button = withIcon(el('button', 'tab', label), glyph);
      button.type = 'button';
      button.dataset.key = `page-${scope}`;
      button.title = title;
      button.setAttribute('aria-pressed', String(model.state.pageScope === scope));
      button.addEventListener('click', () => this.callbacks.onPageScope(scope));
      bar.appendChild(button);
    }
    return bar;
  }

  private renderBranchSelect(model: PanelModel, context: CoverageContext): HTMLSelectElement {
    const { index } = context;
    const select = el('select', 'branch-select');
    select.dataset.key = 'branch';
    select.setAttribute('aria-label', t('coverage_branch'));
    select.title = t('coverage_branchTitle');
    const option = (value: string, label: string) => {
      const o = el('option', undefined, label);
      o.value = value;
      select.appendChild(o);
    };
    option(
      '',
      index.defaultBranch
        ? t('coverage_branchDefaultNamed', { branch: index.defaultBranch })
        : t('coverage_branchDefault'),
    );
    option(ALL_BRANCHES, t('coverage_branchAll'));
    for (const b of index.branches) option(b.name, `${b.name} · ${tn('coverage_testCount', b.tests)}`);
    const current = model.branch ?? '';
    if (![...select.options].some((o) => o.value === current)) option(current, current);
    select.value = current;
    select.addEventListener('change', () => this.callbacks.onBranch(select.value));
    return select;
  }

  private renderScopeBar(model: PanelModel): HTMLElement {
    const bar = el('div', 'scope-bar');
    const button = (
      key: string,
      glyph: IconName,
      text: string,
      title: string,
      onClick: () => void,
      disabled = false,
    ) => {
      const b = makeButton(text, onClick, { icon: glyph, small: true, title });
      b.dataset.key = key;
      b.disabled = disabled;
      return b;
    };
    if (model.state.choosingScope) {
      const keys = el('span', 'keys');
      keys.append(
        ...tNodes('coverage_choosingKeys', {
          up: el('kbd', undefined, '↑'),
          down: el('kbd', undefined, '↓'),
          esc: el('kbd', undefined, t('coverage_escKey')),
        }),
      );
      bar.append(
        el('span', 'what', t('coverage_clickPart')),
        button('scope-cancel', 'close', t('common_cancel'), t('coverage_cancelChoosingTitle'), () =>
          this.callbacks.onCancelChoosing(),
        ),
        keys,
      );
      bar.dataset.mode = 'choosing';
    } else if (model.scopeLabel) {
      const what = el('span', 'what');
      what.append(...tNodes('coverage_inside', { element: el('span', 'scope-name', model.scopeLabel) }));
      what.title = model.scopeLabel;
      bar.append(
        what,
        button(
          'scope-widen',
          'viewport',
          t('coverage_widen'),
          t('coverage_widenTitle'),
          () => this.callbacks.onWidenScope(),
          !model.canWiden,
        ),
        button('scope-whole', 'file', t('coverage_wholePage'), t('coverage_wholePageTitle'), () =>
          this.callbacks.onClearScope(),
        ),
      );
      bar.dataset.mode = 'scoped';
    } else {
      bar.append(
        el('span', 'what', t('coverage_wholePage')),
        button('scope-limit', 'pick', t('coverage_limit'), t('coverage_limitTitle'), () =>
          this.callbacks.onChooseScope(),
        ),
      );
      bar.dataset.mode = 'page';
    }
    return bar;
  }

  /** The tested containers of the element the view is limited to: a test checking the card around a button. */
  private renderAround(context: CoverageContext): HTMLElement | null {
    const { scan } = context;
    if (!isScoped(scan) || scan.containers.length === 0) return null;
    const block = el('div', 'around');
    block.appendChild(el('div', 'hint', t('coverage_aroundHint')));
    const list = el('ul', 'rows');
    for (const [i, c] of scan.containers.slice(0, AROUND_ROWS).entries()) {
      const label = el('span', 'label', c.description);
      const row = this.row(
        `around-${i}`,
        label,
        (on) => this.callbacks.onContainerHover(on ? c.element : null),
        () => this.callbacks.onContainerSelect(c.element),
      );
      row.dataset.kind = c.kind;
      row.title = t('coverage_aroundRowTitle');
      row.appendChild(el('span', `swatch ${c.kind}`));
      row.appendChild(label);
      row.appendChild(el('span', 'count', tn('coverage_testCount', c.tests.length)));
      list.appendChild(row);
    }
    if (scan.containers.length > AROUND_ROWS) {
      list.appendChild(el('li', 'empty', tn('coverage_aroundMore', scan.containers.length - AROUND_ROWS)));
    }
    block.appendChild(list);
    return block;
  }

  private renderTabs(tab: CoverageTab, context: CoverageContext): HTMLElement {
    const tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', t('coverage_tabs'));
    const { scan } = context;
    const risk = riskCount(context);
    for (const [id, label] of [
      ['elements', tNodes('coverage_tabElements', { count: countBadge(scan.covered.length, 'operated') })],
      ['tests', tNodes('coverage_tabTests', { count: countBadge(scan.tests.length) })],
      ['untested', tNodes('coverage_tabUntested', { count: countBadge(scan.uncoveredCount, 'uncovered') })],
      ['risk', tNodes('coverage_tabRisk', { count: countBadge(risk, risk ? 'risk' : undefined) })],
    ] as const) {
      const button = el('button', 'tab');
      button.append(...label);
      button.type = 'button';
      button.dataset.key = `tab-${id}`;
      button.setAttribute('aria-pressed', String(tab === id));
      button.addEventListener('click', () => this.callbacks.onTab(id));
      tabs.appendChild(button);
    }
    return tabs;
  }

  private renderList(state: ViewState, context: CoverageContext): HTMLElement {
    const query = state.query.trim().toLowerCase();
    if (state.tab === 'tests') return this.renderTests(state, context, query);
    if (state.tab === 'untested') return this.renderUncovered(context, query);
    if (state.tab === 'risk') return this.renderRisk(context, query);
    return this.renderCovered(state, context, query);
  }

  private rowsOrEmpty(rows: HTMLLIElement[], empty: string, total: number): HTMLElement {
    if (rows.length === 0) return el('div', 'empty', empty);
    const list = el('ul', 'rows');
    list.append(...rows);
    if (total > rows.length) {
      const more = el('li', 'empty', tn('coverage_listMore', total - rows.length));
      list.appendChild(more);
    }
    return list;
  }

  /**
   * A row of a list; `key` names it across renders, so the focus stays on it
   * when the list is drawn again. The whole row takes the pointer; `label`,
   * which the caller puts in it, is the button the keyboard reaches, so the
   * row's own links and buttons are not inside another button.
   */
  private row(key: string, label: HTMLElement, onHover: (on: boolean) => void, onSelect: () => void): HTMLLIElement {
    const row = el('li', 'row');
    row.dataset.key = key;
    row.addEventListener('mouseenter', () => onHover(true));
    row.addEventListener('mouseleave', () => onHover(false));
    row.addEventListener('click', onSelect);
    label.tabIndex = 0;
    label.setAttribute('role', 'button');
    label.addEventListener('focus', () => onHover(true));
    label.addEventListener('blur', () => onHover(false));
    label.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    });
    return row;
  }

  private renderCovered(state: ViewState, context: CoverageContext, query: string): HTMLElement {
    const { index, scan } = context;
    const matches = (c: CoveredElement) =>
      !query ||
      c.description.toLowerCase().includes(query) ||
      c.tests.some(
        (test) =>
          testTitle(index.tests[test]!).toLowerCase().includes(query) ||
          index.tests[test]!.file.toLowerCase().includes(query),
      ) ||
      c.matches.some((m) => index.locators[m.entry]!.locator.toLowerCase().includes(query));
    const shown = scan.covered.filter((c) => kindShown(state, c) && matches(c));
    const rows = shown.slice(0, MAX_ROWS).map((c, i) => {
      const label = el('span', 'label', c.description);
      const row = this.row(
        `covered-${i}`,
        label,
        (on) => this.callbacks.onElementHover(on ? c.element : null),
        () => this.callbacks.onElementSelect(c.element),
      );
      if (state.pinned === c.element) row.classList.add('active');
      row.dataset.kind = c.kind;
      row.appendChild(el('span', `swatch ${c.kind}`));
      label.title = c.description;
      row.appendChild(label);
      const count = el('span', 'count', tn('coverage_testCount', c.tests.length));
      const health = worstStatus(index, c.tests);
      if (health) count.title = health === 'failed' ? t('coverage_reachFailing') : t('coverage_reachFlaky');
      if (health) count.prepend(el('span', `dot ${health}`), ' ');
      row.appendChild(count);
      const first = index.locators[c.matches[0]!.entry]!.locator;
      const detail = el('span', 'detail mono');
      if (!c.visible) detail.append(`${t('coverage_hiddenNow')} · `);
      detail.append(locatorCode('span', first));
      if (c.matches.length > 1) detail.append(` +${c.matches.length - 1}`);
      detail.title = c.matches.map((m) => index.locators[m.entry]!.locator).join('\n');
      row.appendChild(detail);
      return row;
    });
    return this.rowsOrEmpty(
      rows,
      scan.covered.length === 0
        ? isScoped(scan)
          ? t('coverage_emptyElementsInside')
          : t('coverage_emptyElements')
        : t('coverage_noMatch'),
      shown.length,
    );
  }

  private renderTests(state: ViewState, context: CoverageContext, query: string): HTMLElement {
    const { index, scan } = context;
    const shown = scan.tests.filter(({ test }) => {
      const entry = index.tests[test]!;
      return !query || testTitle(entry).toLowerCase().includes(query) || entry.file.toLowerCase().includes(query);
    });
    const rows = shown.slice(0, MAX_ROWS).map(({ test, elements }) => {
      const entry = index.tests[test]!;
      const label = el('span', 'label', testTitle(entry));
      const row = this.row(
        `test-${test}`,
        label,
        (on) => this.callbacks.onTestHover(on ? test : null),
        () => this.callbacks.onTestSelect(test),
      );
      if (state.focusTest === test) row.classList.add('focused');
      const dot = el('span', `swatch dot ${entry.status ?? 'unknown'}`);
      dot.style.borderRadius = '50%';
      dot.title = statusLabel(entry.status);
      row.appendChild(dot);
      label.title = testTitle(entry);
      row.appendChild(label);
      row.appendChild(el('span', 'count', tn('coverage_elementCount', elements.length)));
      const detail = el('span', 'detail mono');
      const link = el('a', undefined, entry.file);
      link.href = testCaseUrl(context.instanceUrl, entry.id);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = t('coverage_openTest');
      link.style.color = 'inherit';
      link.addEventListener('click', (e) => e.stopPropagation());
      detail.appendChild(link);
      if (state.focusTest === test) detail.append(` · ${t('coverage_onlyItsElements')}`);
      row.appendChild(detail);
      return row;
    });
    return this.rowsOrEmpty(
      rows,
      scan.tests.length === 0
        ? isScoped(scan)
          ? t('coverage_emptyTestsInside')
          : t('coverage_emptyTests')
        : t('coverage_noMatch'),
      shown.length,
    );
  }

  private renderUncovered(context: CoverageContext, query: string): HTMLElement {
    const uncovered: UncoveredElement[] = context.scan.uncovered;
    const scoped = isScoped(context.scan);
    const shown = uncovered.filter((u) => !query || u.description.toLowerCase().includes(query));
    const rows = shown.slice(0, MAX_ROWS).map((u, i) => {
      const label = el('span', 'label', u.description);
      const row = this.row(
        `untested-${i}`,
        label,
        (on) => this.callbacks.onElementHover(on ? u.element : null),
        () => this.callbacks.onElementSelect(u.element),
      );
      row.dataset.kind = 'uncovered';
      row.appendChild(el('span', 'swatch uncovered'));
      label.title = u.description;
      row.appendChild(label);
      const suggestion = i < MAX_SUGGESTIONS ? this.callbacks.suggestLocator(u.element) : null;
      if (suggestion) {
        const copy = makeButton(
          t('coverage_copyLocator'),
          (e) => {
            e.stopPropagation();
            void copyWithFeedback(suggestion, copy);
          },
          { icon: 'copy', small: true, title: t('coverage_copyLocatorTitle'), className: 'row-copy' },
        );
        row.appendChild(copy);
      } else {
        row.appendChild(el('span', 'count'));
      }
      // This page: a locator tests use on other pages finds it. Perhaps the same component, perhaps a lookalike.
      const elsewhere = context.elsewhere.get(u.element);
      if (elsewhere?.length) {
        const entry = context.index.locators[elsewhere[0]!]!;
        const pages = [...new Set(entry.uses.flatMap((use) => (use.pages ?? []).map((p) => context.index.pages?.[p])))]
          .filter(Boolean)
          .slice(0, 2);
        const hint = el('span', 'detail');
        const locator = locatorCode('span', entry.locator);
        hint.append(
          ...(pages.length
            ? tNodes('coverage_foundElsewhere', { locator, pages: pages.join(', ') })
            : tNodes('coverage_foundElsewhereOther', { locator })),
        );
        hint.title = elsewhere.map((e) => context.index.locators[e]!.locator).join('\n');
        row.appendChild(hint);
      }
      if (suggestion) {
        const code = el('code', 'piwi-loc');
        code.innerHTML = highlightLocator(suggestion);
        row.appendChild(code);
      }
      return row;
    });
    return this.rowsOrEmpty(
      rows,
      uncovered.length === 0
        ? scoped
          ? t('coverage_emptyUntestedInside')
          : t('coverage_emptyUntested')
        : t('coverage_noMatch'),
      shown.length,
    );
  }

  /** The locators likely to break, most urgent first. */
  private renderRisk(context: CoverageContext, query: string): HTMLElement {
    const block = el('div', 'risk');
    if (context.pageScoped) {
      block.appendChild(this.renderMissing(context, query));
      block.appendChild(this.renderSeveral(context, query));
    }
    block.appendChild(this.renderBrittle(context, query));
    return block;
  }

  private pageRiskMatches(context: CoverageContext, query: string): (row: PageRiskRow) => boolean {
    const { index } = context;
    return (row) =>
      !query ||
      index.locators[row.entry]!.locator.toLowerCase().includes(query) ||
      row.callSites.some((site) => site.toLowerCase().includes(query)) ||
      row.tests.some((test) => testTitle(index.tests[test]!).toLowerCase().includes(query));
  }

  /** Chains a test uses on this page that find nothing now: the test will fail here, or the page is in another state. */
  private renderMissing(context: CoverageContext, query: string): HTMLElement {
    const section = el('section', 'risk-section');
    section.appendChild(
      sectionHead('missing', tNodes('coverage_missingHead', { count: countBadge(context.missing.length, 'missing') })),
    );
    section.appendChild(el('p', 'section-hint', t('coverage_missingHint')));
    const shown = context.missing.filter(this.pageRiskMatches(context, query));
    const rows = shown.slice(0, MAX_ROWS).map((row) => this.pageRiskRow(context, row));
    section.appendChild(
      this.rowsOrEmpty(
        rows,
        context.missing.length === 0 ? t('coverage_missingEmpty') : t('coverage_noMatch'),
        shown.length,
      ),
    );
    return section;
  }

  /** Chains a test clicks or fills on this page that find several elements: strict mode refuses that. */
  private renderSeveral(context: CoverageContext, query: string): HTMLElement {
    const section = el('section', 'risk-section');
    section.appendChild(
      sectionHead('layers', tNodes('coverage_severalHead', { count: countBadge(context.several.length, 'risk') })),
    );
    section.appendChild(el('p', 'section-hint', t('coverage_severalHint')));
    const shown = context.several.filter(this.pageRiskMatches(context, query));
    const rows = shown.slice(0, MAX_ROWS).map((row) => this.pageRiskRow(context, row));
    section.appendChild(
      this.rowsOrEmpty(
        rows,
        context.several.length === 0 ? t('coverage_severalEmpty') : t('coverage_noMatch'),
        shown.length,
      ),
    );
    return section;
  }

  private pageRiskRow(context: CoverageContext, row: PageRiskRow): HTMLLIElement {
    const { index } = context;
    const locator = index.locators[row.entry]!.locator;
    const item = el('li', 'row static');
    item.dataset.kind = row.count === 0 ? 'missing' : 'several';
    item.appendChild(el('span', `swatch ${row.count === 0 ? 'missing' : 'brittle'}`));
    const label = el(
      'span',
      'label',
      row.count === 0
        ? row.arrival
          ? t('coverage_notFoundOnLoad')
          : t('coverage_notFoundNow')
        : tn('coverage_findsCount', row.count),
    );
    item.appendChild(label);
    const count = el('span', 'count', tn('coverage_testCount', row.tests.length));
    const health = worstStatus(index, row.tests);
    if (health) count.prepend(el('span', `dot ${health}`), ' ');
    item.appendChild(count);
    const chain = el('code', 'piwi-loc');
    chain.innerHTML = highlightLocator(locator);
    item.appendChild(chain);
    const parts: Array<Node | string> = [row.actions.slice(0, 3).map(actionLabel).join(', ')];
    if (row.callSites.length) parts.push(callSites(row.callSites));
    if (row.projects.length) parts.push(row.projects.join(', '));
    const stability = context.stabilities[row.entry];
    if (stability?.level === 'brittle')
      parts.push(t('coverage_brittleRules', { rules: stabilityText(stability, ', ') }));
    const detail = el('span', 'detail');
    detail.append(...joined(parts.filter(Boolean)));
    detail.title = row.tests.map((test) => testTitle(index.tests[test]!)).join('\n');
    item.appendChild(detail);
    return item;
  }

  private renderBrittle(context: CoverageContext, query: string): HTMLElement {
    const { index, scan } = context;
    const section = el('section', 'risk-section');
    section.appendChild(
      sectionHead('alert', tNodes('coverage_brittleHead', { count: countBadge(context.brittle.length, 'risk') })),
    );
    section.appendChild(el('p', 'section-hint', t('coverage_brittleHint')));
    const matches = (row: BrittleRow) =>
      !query ||
      index.locators[row.entry]!.locator.toLowerCase().includes(query) ||
      row.elements.some((e) => scan.describe(e).toLowerCase().includes(query)) ||
      row.callSites.some((site) => site.toLowerCase().includes(query)) ||
      row.tests.some((test) => testTitle(index.tests[test]!).toLowerCase().includes(query));
    const shown = context.brittle.filter(matches);
    const rows = shown.slice(0, MAX_ROWS).map((row, i) => this.brittleRow(context, row, i < MAX_SUGGESTIONS));
    section.appendChild(
      this.rowsOrEmpty(
        rows,
        context.brittle.length === 0
          ? isScoped(scan)
            ? t('coverage_brittleEmptyInside')
            : t('coverage_brittleEmpty')
          : t('coverage_noMatch'),
        shown.length,
      ),
    );
    return section;
  }

  private brittleRow(context: CoverageContext, row: BrittleRow, suggest: boolean): HTMLLIElement {
    const { index, scan } = context;
    const locator = index.locators[row.entry]!.locator;
    const first = row.elements[0]!;
    const label = el('span', 'label', row.count > 1 ? tn('coverage_elementCount', row.count) : scan.describe(first));
    const item = this.row(
      `brittle-${row.entry}`,
      label,
      (on) => this.callbacks.onElementHover(on ? first : null),
      () => this.callbacks.onElementSelect(first),
    );
    item.dataset.kind = 'brittle';
    item.appendChild(el('span', 'swatch brittle'));
    label.title = row.elements.map((e) => scan.describe(e)).join('\n');
    item.appendChild(label);
    const count = el('span', 'count', tn('coverage_testCount', row.tests.length));
    const health = worstStatus(index, row.tests);
    if (health) {
      count.prepend(el('span', `dot ${health}`), ' ');
      count.title = health === 'failed' ? t('coverage_useFailing') : t('coverage_useFlaky');
    }
    item.appendChild(count);
    const chain = el('code', 'piwi-loc');
    chain.innerHTML = highlightLocator(locator);
    item.appendChild(chain);
    const why = el('span', 'detail', stabilityText(row.stability));
    why.title = row.stability.findings.map((f) => f.detail).join('\n');
    if (row.callSites.length) why.append(' · ', callSites(row.callSites));
    item.appendChild(why);

    if (row.count > 1) {
      item.appendChild(el('span', 'detail wrap', tn('coverage_severalNoReplacement', row.count)));
      return item;
    }
    const replacement = suggest ? this.callbacks.replacementFor(first, row.entry) : null;
    if (replacement?.kind === 'add-test-id') {
      item.appendChild(el('span', 'detail wrap', t('coverage_addTestId')));
    } else if (replacement?.kind === 'replace') {
      const next = replacement.recommended.locator;
      const code = el('code', 'piwi-loc suggestion');
      code.innerHTML = `→ ${highlightLocator(next)}`;
      code.title = t('coverage_replacementTitle');
      item.appendChild(code);
      if (replacement.durable) {
        const durable = el('span', 'detail');
        durable.append(...tNodes('coverage_mostStable', { locator: locatorCode('span', replacement.durable.locator) }));
        durable.title = replacement.durable.locator;
        item.appendChild(durable);
      }
      const actions = el('div', 'row-actions');
      const copy = makeButton(
        t('coverage_copyLocator'),
        (e) => {
          e.stopPropagation();
          void copyWithFeedback(next, copy);
        },
        { icon: 'copy', small: true, title: t('coverage_copyReplacementTitle') },
      );
      const edit = makeButton(
        t('coverage_copyEdit'),
        (e) => {
          e.stopPropagation();
          void copyWithFeedback(editText(row.callSites, locator, next), edit);
        },
        { icon: 'edit', small: true, title: t('coverage_copyEditTitle') },
      );
      actions.append(copy, edit);
      item.appendChild(actions);
    }
    return item;
  }

  private renderNotes(context: CoverageContext): HTMLElement | null {
    const { scan, index } = context;
    const items: Node[] = [];
    if (scan.unmatched) {
      items.push(el('li', undefined, tn('coverage_notesUnmatched', scan.unmatched)));
    }
    if (index.truncated) items.push(el('li', undefined, t('coverage_notesTruncated')));
    if (index.testIdAttributes?.length) {
      items.push(el('li', undefined, t('coverage_notesTestIds', { attributes: index.testIdAttributes.join(', ') })));
    }
    const counted = context.pageScoped
      ? context.pageKey
        ? t('coverage_notesPageScoped', { page: context.pageKey })
        : t('coverage_notesPageScopedHere')
      : t('coverage_notesAllPages');
    items.push(
      el(
        'li',
        undefined,
        `${tn('coverage_notesChecked', scan.evaluated, { ms: formatNumber(scan.durationMs) })} ${counted}`,
      ),
    );
    if (context.prefixRemoved) {
      items.push(el('li', undefined, t('coverage_notesPrefixRemoved', { prefix: context.prefixRemoved })));
    }
    if (context.prefixAdded) {
      items.push(el('li', undefined, t('coverage_notesPrefixAdded', { prefix: context.prefixAdded })));
    }
    if (scan.errors.length) {
      const errorItem = el('li', undefined, tn('coverage_notesErrors', scan.errors.length));
      const list = el('ul');
      for (const error of scan.errors.slice(0, 20)) {
        const li = el('li');
        li.append(locatorCode('code', index.locators[error.entry]!.locator), ` — ${error.message}`);
        list.appendChild(li);
      }
      errorItem.appendChild(list);
      items.push(errorItem);
    }
    const details = el('details', 'notes');
    details.dataset.key = 'notes';
    details.open = this.notesOpen;
    const summary = el(
      'summary',
      undefined,
      scan.errors.length ? tn('coverage_notesWithErrors', scan.errors.length) : t('coverage_notes'),
    );
    const list = el('ul');
    list.append(...items);
    details.append(summary, list);
    return details;
  }
}
