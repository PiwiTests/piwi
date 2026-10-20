/**
 * What the coverage overlay draws over the page itself: one box per element
 * (green when tests operate it, blue when they only assert on it, hatched
 * amber when no test reaches it), a badge with the number of tests, a preview
 * card on hover and a detail card pinned from a badge. Boxes never take
 * pointer events, so the page stays usable underneath.
 */
import { highlightLocator } from '@piwitests/picker-dom';
import { actionLabel, stabilityText } from '../shared/core-words.js';
import { editText, type Replacement } from './coverage-risk.js';
import type { CoveredElement, UncoveredElement } from './coverage-scan.js';
import { statusLabel, testTitle, usePages, type CoverageContext } from './coverage-view.js';
import { projectLocatorsUrl, testCaseUrl } from '../shared/instance-links.js';
import { t, tn, uiLanguage } from '../shared/i18n.js';
import { copyWithFeedback } from '../shared/clipboard.js';
import { makeButton, styleButton } from '../shared/buttons.js';

export interface Drawable {
  element: Element;
  kind: 'operated' | 'checked' | 'uncovered';
  covered: CoveredElement | null;
  uncovered: UncoveredElement | null;
  health: 'failed' | 'flaky' | null;
  /** 0 to 1, how many tests reach it relative to the most-tested element here. */
  heat: number;
  /** A brittle locator finds it, and the marks are shown. */
  brittle: boolean;
  emphasis: 'normal' | 'dim' | 'strong';
}

/** An outline around a part of the page, with a label on its top edge. */
export interface Frame {
  element: Element;
  /** The element the view is limited to, the one being chosen, or a container hovered in the panel. */
  kind: 'scope' | 'choosing' | 'around';
  label: string;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * An element's box in the top window's viewport: frame offsets added, and
 * clipped to each frame it sits in. Null when nothing of it shows.
 */
function viewportRect(element: Element): Rect | null {
  const r = element.getBoundingClientRect();
  let left = r.left;
  let top = r.top;
  let right = r.right;
  let bottom = r.bottom;
  let view = element.ownerDocument.defaultView;
  while (view && view.frameElement) {
    const frame = view.frameElement;
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, view.innerWidth);
    bottom = Math.min(bottom, view.innerHeight);
    const frameRect = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
    const offsetX = frameRect.left + frame.clientLeft + parseFloat(style?.paddingLeft || '0');
    const offsetY = frameRect.top + frame.clientTop + parseFloat(style?.paddingTop || '0');
    left += offsetX;
    right += offsetX;
    top += offsetY;
    bottom += offsetY;
    view = frame.ownerDocument.defaultView;
  }
  if (right - left <= 0 || bottom - top <= 0) return null;
  return { left, top, width: right - left, height: bottom - top };
}

const PREVIEW_TESTS = 4;
const CARD_TESTS = 8;

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

function locatorCode(locator: string): HTMLElement {
  const code = el('code', 'piwi-loc piwi-loc-dark');
  code.innerHTML = highlightLocator(locator);
  return code;
}

export interface LayerCallbacks {
  /** A badge was clicked: open that element's detail card. */
  onPin(element: Element): void;
  onClosePinned(): void;
  /** The best locator for an untested element, generated on demand. */
  suggestLocator(element: Element): string | null;
  /** A replacement for the chain at `entry`, which finds only `element` here. */
  replacementFor(element: Element, entry: number): Replacement | null;
}

export class CoverageLayer {
  private readonly container: HTMLDivElement;
  /** Before the boxes, so they paint above the frames. */
  private readonly frameContainer: HTMLDivElement;
  private frames: Array<{ frame: Frame; outline: HTMLDivElement; tag: HTMLDivElement }> = [];
  private readonly nodes = new Map<Element, { box: HTMLDivElement; badge: HTMLButtonElement | null }>();
  private readonly rects = new Map<Element, Rect>();
  private drawables: Drawable[] = [];
  private context: CoverageContext | null = null;
  private previewCard: HTMLDivElement | null = null;
  private previewFor: Element | null = null;
  private pinnedCard: HTMLDivElement | null = null;
  private pinnedFor: Element | null = null;
  private hovered: Element | null = null;

  constructor(
    parent: ShadowRoot,
    private readonly callbacks: LayerCallbacks,
  ) {
    this.container = el('div', 'layer');
    this.container.lang = uiLanguage();
    this.frameContainer = el('div', 'frames');
    this.container.appendChild(this.frameContainer);
    parent.appendChild(this.container);
  }

  setContext(context: CoverageContext | null): void {
    this.context = context;
  }

  /** Replace what is drawn. */
  draw(drawables: Drawable[]): void {
    this.drawables = drawables;
    const wanted = new Set(drawables.map((d) => d.element));
    for (const [element, nodes] of this.nodes) {
      if (wanted.has(element)) continue;
      nodes.box.remove();
      nodes.badge?.remove();
      this.nodes.delete(element);
    }
    for (const d of drawables) {
      let nodes = this.nodes.get(d.element);
      if (!nodes) {
        const box = el('div', 'box');
        this.container.appendChild(box);
        nodes = { box, badge: null };
        this.nodes.set(d.element, nodes);
      }
      const classes = ['box', d.kind];
      if (d.covered?.ambiguous) classes.push('ambiguous');
      if (d.brittle) classes.push('brittle');
      if (d.emphasis !== 'normal') classes.push(d.emphasis);
      if (d.element === this.hovered) classes.push('hover');
      nodes.box.className = classes.join(' ');
      nodes.box.style.setProperty('--heat', d.heat.toFixed(3));
      nodes.box.dataset.kind = d.kind;

      if (d.covered) {
        if (!nodes.badge) {
          const badge = el('button', 'badge');
          badge.type = 'button';
          const element = d.element;
          badge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.callbacks.onPin(element);
          });
          this.container.appendChild(badge);
          nodes.badge = badge;
        }
        const badge = nodes.badge;
        badge.className = `badge ${d.kind}${d.emphasis === 'dim' ? ' dim' : ''}`;
        const count = String(d.covered.tests.length);
        badge.replaceChildren(count);
        // Estimated from the content, so placing badges never has to measure them.
        badge.dataset.width = String(12 + count.length * 7 + (d.health ? 10 : 0));
        if (d.health) {
          const dot = el('span', `dot ${d.health}`);
          badge.appendChild(dot);
        }
        const tests = d.covered.tests.length;
        const element = { element: d.covered.description };
        badge.title =
          d.health === 'failed'
            ? tn('coverage_badgeTitleFailing', tests, element)
            : d.health === 'flaky'
              ? tn('coverage_badgeTitleFlaky', tests, element)
              : tn('coverage_badgeTitle', tests, element);
        badge.setAttribute('aria-label', tn('coverage_badgeLabel', tests, element));
      } else if (nodes.badge) {
        nodes.badge.remove();
        nodes.badge = null;
      }
    }
    this.position();
  }

  /** Replace the outlines drawn around parts of the page. */
  setFrames(frames: Frame[]): void {
    this.frameContainer.replaceChildren();
    this.frames = frames.map((frame) => {
      const outline = el('div', `frame ${frame.kind}`);
      const tag = el('div', 'frame-tag', frame.label);
      this.frameContainer.append(outline, tag);
      return { frame, outline, tag };
    });
    this.positionFrames(
      this.frames.map(({ frame }) => (frame.element.isConnected ? viewportRect(frame.element) : null)),
    );
  }

  private positionFrames(rects: Array<Rect | null>): void {
    this.frames.forEach(({ outline, tag }, i) => {
      const rect = rects[i];
      outline.style.display = rect ? '' : 'none';
      tag.style.display = rect ? '' : 'none';
      if (!rect) return;
      outline.style.left = `${rect.left - 3}px`;
      outline.style.top = `${rect.top - 3}px`;
      outline.style.width = `${rect.width + 6}px`;
      outline.style.height = `${rect.height + 6}px`;
      tag.style.left = `${Math.max(rect.left - 3, 2)}px`;
      tag.style.top = `${rect.top - 24 >= 2 ? rect.top - 24 : Math.min(rect.top + rect.height + 5, window.innerHeight - 22)}px`;
    });
  }

  /**
   * Move every box, badge and card to where its element is now. Every rect is
   * read before any style is written: interleaving the two would make the
   * browser lay the page out again for each element.
   */
  position(): void {
    this.rects.clear();
    const width = window.innerWidth;
    const height = window.innerHeight;
    for (const d of this.drawables) {
      const rect = d.element.isConnected ? viewportRect(d.element) : null;
      if (rect) this.rects.set(d.element, rect);
    }
    const frameRects = this.frames.map(({ frame }) => (frame.element.isConnected ? viewportRect(frame.element) : null));
    this.positionFrames(frameRects);
    for (const d of this.drawables) {
      const nodes = this.nodes.get(d.element);
      if (!nodes) continue;
      const rect = this.rects.get(d.element);
      if (!rect) {
        nodes.box.style.display = 'none';
        if (nodes.badge) nodes.badge.style.display = 'none';
        continue;
      }
      const style = nodes.box.style;
      style.display = '';
      style.left = `${rect.left}px`;
      style.top = `${rect.top}px`;
      style.width = `${rect.width}px`;
      style.height = `${rect.height}px`;
      if (nodes.badge) {
        const badge = nodes.badge;
        badge.style.display = '';
        const badgeWidth = Number(badge.dataset.width) || 24;
        const x = Math.min(Math.max(rect.left + rect.width - badgeWidth + 6, 2), width - badgeWidth - 2);
        const y = Math.min(Math.max(rect.top - 9, 2), height - 20);
        badge.style.left = `${x}px`;
        badge.style.top = `${y}px`;
      }
    }
    if (this.previewCard && this.previewFor) this.placeCard(this.previewCard, this.previewFor);
    if (this.pinnedCard && this.pinnedFor) this.placeCard(this.pinnedCard, this.pinnedFor);
  }

  /** The smallest drawn element under a viewport point. */
  hitTest(x: number, y: number): Element | null {
    let best: Element | null = null;
    let bestArea = Infinity;
    for (const d of this.drawables) {
      if (d.emphasis === 'dim') continue;
      const rect = this.rects.get(d.element);
      if (!rect || x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) continue;
      const area = rect.width * rect.height;
      if (area < bestArea) {
        best = d.element;
        bestArea = area;
      }
    }
    return best;
  }

  rectOf(element: Element): Rect | null {
    return this.rects.get(element) ?? null;
  }

  setHovered(element: Element | null): void {
    if (element === this.hovered) return;
    const previous = this.hovered ? this.nodes.get(this.hovered) : undefined;
    previous?.box.classList.remove('hover');
    this.hovered = element;
    if (element) this.nodes.get(element)?.box.classList.add('hover');
  }

  flash(element: Element): void {
    const box = this.nodes.get(element)?.box;
    if (!box) return;
    box.classList.remove('flash');
    void box.offsetWidth;
    box.classList.add('flash');
    setTimeout(() => box.classList.remove('flash'), 1700);
  }

  showPreview(element: Element | null): void {
    if (element === this.previewFor) return;
    this.previewCard?.remove();
    this.previewCard = null;
    this.previewFor = null;
    if (!element || element === this.pinnedFor) return;
    const d = this.drawables.find((x) => x.element === element);
    if (!d || !this.context) return;
    const card = el('div', 'card preview piwi-dark');
    card.setAttribute('role', 'tooltip');
    this.fillPreview(card, d, this.context);
    this.container.appendChild(card);
    this.previewCard = card;
    this.previewFor = element;
    this.placeCard(card, element);
  }

  showPinned(element: Element | null): void {
    this.pinnedCard?.remove();
    this.pinnedCard = null;
    this.pinnedFor = null;
    if (!element) return;
    if (element === this.previewFor) this.showPreview(null);
    const d = this.drawables.find((x) => x.element === element);
    if (!d || !this.context) return;
    const card = el('div', 'card pinned piwi-dark');
    card.setAttribute('role', 'dialog');
    const description = d.covered?.description ?? d.uncovered?.description;
    card.setAttribute(
      'aria-label',
      description ? t('coverage_cardLabel', { element: description }) : t('coverage_cardLabelThis'),
    );
    this.fillPinned(card, d, this.context);
    this.container.appendChild(card);
    this.pinnedCard = card;
    this.pinnedFor = element;
    this.placeCard(card, element);
  }

  destroy(): void {
    this.container.remove();
    this.nodes.clear();
  }

  private placeCard(card: HTMLDivElement, element: Element): void {
    const rect = this.rects.get(element) ?? viewportRect(element);
    if (!rect) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    const width = card.offsetWidth || 380;
    const height = card.offsetHeight || 160;
    const below = rect.top + rect.height + 10;
    const above = rect.top - height - 10;
    const top =
      below + height <= window.innerHeight - 8
        ? below
        : above >= 8
          ? above
          : Math.max(8, window.innerHeight - height - 8);
    const left = Math.min(Math.max(rect.left, 8), window.innerWidth - width - 8);
    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${top}px`;
  }

  /** A chain's stability findings, and for one finding only this element, its replacement. */
  private appendStability(
    block: HTMLElement,
    element: Element,
    entry: number,
    count: number,
    context: CoverageContext,
  ): void {
    const stability = context.stabilities[entry];
    if (!stability || stability.level === 'stable') return;
    const note = el(
      'div',
      `note stability ${stability.level}`,
      t(stability.level === 'brittle' ? 'coverage_noteBrittle' : 'coverage_noteWatch', {
        rules: stabilityText(stability, ', '),
      }),
    );
    note.title = stability.findings.map((f) => f.detail).join('\n');
    block.appendChild(note);
    if (count !== 1) return;
    const replacement = this.callbacks.replacementFor(element, entry);
    if (replacement?.kind === 'add-test-id') {
      block.appendChild(el('div', 'hint', t('coverage_addTestId')));
      return;
    }
    if (replacement?.kind !== 'replace') return;
    const next = replacement.recommended.locator;
    const suggestion = el('div', 'replacement');
    suggestion.appendChild(el('div', 'hint', t('coverage_replaceWith')));
    suggestion.appendChild(locatorCode(next));
    if (replacement.durable) {
      suggestion.appendChild(el('div', 'hint', t('coverage_mostStableHead')));
      suggestion.appendChild(locatorCode(replacement.durable.locator));
    }
    const actions = el('div', 'card-actions');
    const copy = makeButton(t('coverage_copyLocator'), () => void copyWithFeedback(next, copy), {
      icon: 'copy',
      small: true,
      title: t('coverage_copyReplacementTitle'),
    });
    const locator = context.index.locators[entry]!;
    const sites = [...new Set(locator.uses.flatMap((use) => use.callSites))];
    const edit = makeButton(
      t('coverage_copyEdit'),
      () => void copyWithFeedback(editText(sites, locator.locator, next), edit),
      { icon: 'edit', small: true, title: t('coverage_copyEditTitle') },
    );
    actions.append(copy, edit);
    suggestion.appendChild(actions);
    block.appendChild(suggestion);
  }

  private kindLine(d: Drawable): HTMLElement {
    const line = el('div', 'kind');
    if (d.covered) {
      const tests = d.covered.tests.length;
      const kind = el(
        'span',
        d.kind,
        d.kind === 'operated' ? tn('coverage_actedOnBy', tests) : tn('coverage_checkedBy', tests),
      );
      line.appendChild(kind);
      const actions = new Set<string>();
      const index = this.context!.index;
      for (const m of d.covered.matches)
        for (const use of index.locators[m.entry]!.uses) use.actions.forEach((a) => actions.add(a));
      if (actions.size) line.append(` · ${[...actions].slice(0, 4).map(actionLabel).join(', ')}`);
      if (d.covered.ambiguous) line.append(` · ${t('coverage_ambiguous')}`);
    } else {
      line.appendChild(el('span', 'uncovered', t('coverage_notTested')));
      line.append(` · ${t('coverage_noLocatorReaches')}`);
    }
    return line;
  }

  private testItem(
    testIndex: number,
    context: CoverageContext,
    detail: Array<Node | string> | null,
    link: boolean,
  ): HTMLLIElement {
    const test = context.index.tests[testIndex]!;
    const item = el('li');
    const dot = el('span', `dot ${test.status ?? 'unknown'}`);
    dot.title = statusLabel(test.status);
    item.appendChild(dot);
    if (link) {
      const a = el('a', undefined, testTitle(test));
      a.href = testCaseUrl(context.instanceUrl, test.id);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = t('coverage_openTestFile', { file: test.file });
      item.appendChild(a);
    } else {
      item.appendChild(el('span', undefined, testTitle(test)));
    }
    if (detail) {
      const meta = el('span', 'meta');
      meta.append(...detail);
      item.appendChild(meta);
    }
    return item;
  }

  private fillPreview(card: HTMLDivElement, d: Drawable, context: CoverageContext): void {
    card.appendChild(el('div', 'what', d.covered?.description ?? d.uncovered?.description ?? ''));
    card.appendChild(this.kindLine(d));
    if (d.covered && context.brittleElements.has(d.element)) {
      card.appendChild(el('div', 'note brittle', t('coverage_previewBrittle')));
    }
    if (d.covered) {
      const list = el('ul');
      for (const test of d.covered.tests.slice(0, PREVIEW_TESTS))
        list.appendChild(this.testItem(test, context, null, false));
      card.appendChild(list);
      const rest = d.covered.tests.length - PREVIEW_TESTS;
      card.appendChild(el('div', 'more', rest > 0 ? tn('coverage_previewMore', rest) : t('coverage_previewHint')));
    } else if (d.uncovered) {
      const suggestion = this.callbacks.suggestLocator(d.element);
      if (suggestion) {
        const chain = el('div', 'chain');
        chain.appendChild(el('div', 'hint', t('coverage_aLocator')));
        chain.appendChild(locatorCode(suggestion));
        card.appendChild(chain);
      }
    }
  }

  private fillPinned(card: HTMLDivElement, d: Drawable, context: CoverageContext): void {
    const head = el('div', 'card-head');
    const titleWrap = el('div');
    titleWrap.appendChild(el('div', 'what', d.covered?.description ?? d.uncovered?.description ?? ''));
    titleWrap.appendChild(this.kindLine(d));
    const close = makeButton(t('common_close'), () => this.callbacks.onClosePinned(), {
      icon: 'close',
      iconOnly: true,
      tone: 'ghost',
      small: true,
      className: 'close',
    });
    head.append(titleWrap, close);
    card.appendChild(head);

    if (d.covered) {
      const index = context.index;
      const locators: string[] = [];
      for (const match of d.covered.matches) {
        const entry = index.locators[match.entry]!;
        locators.push(entry.locator);
        const block = el('div', 'chain');
        block.appendChild(locatorCode(entry.locator));
        if (match.count > 1) {
          block.appendChild(el('div', 'note', tn('coverage_matchesOnPage', match.count)));
        }
        this.appendStability(block, d.element, match.entry, match.count, context);
        const list = el('ul');
        for (const use of entry.uses.slice(0, CARD_TESTS)) {
          const where = use.callSites[0] ?? index.tests[use.test]!.file;
          const pages = usePages(index, use);
          const detail: Array<Node | string> = [
            el('span', 'act', use.actions.map(actionLabel).join(', ')),
            ' · ',
            el('span', 'site mono', where),
          ];
          if (use.projects.length) detail.push(` · ${use.projects.join(', ')}`);
          if (pages.length) {
            detail.push(
              ` · ${t('coverage_onPages', { pages: `${pages.slice(0, 3).join('; ')}${pages.length > 3 ? ` +${pages.length - 3}` : ''}` })}`,
            );
          }
          list.appendChild(this.testItem(use.test, context, detail, true));
        }
        block.appendChild(list);
        if (entry.uses.length > CARD_TESTS)
          block.appendChild(el('div', 'more', tn('coverage_moreTests', entry.uses.length - CARD_TESTS)));
        card.appendChild(block);
      }
      const actions = el('div', 'card-actions');
      const find = styleButton(el('a', 'button', t('coverage_findInPiwi')), { icon: 'search', small: true });
      find.href = projectLocatorsUrl(
        context.instanceUrl,
        context.projectId,
        locators,
        context.branch,
        context.pageScoped && context.pagePosition >= 0 ? context.pageKey : null,
      );
      find.target = '_blank';
      find.rel = 'noopener noreferrer';
      actions.appendChild(find);
      card.appendChild(actions);
    } else {
      card.appendChild(el('div', 'hint', t('coverage_noTestReaches')));
      const suggestion = this.callbacks.suggestLocator(d.element);
      if (suggestion) {
        const block = el('div', 'chain');
        block.appendChild(el('div', 'hint', t('coverage_mostStableFor')));
        block.appendChild(locatorCode(suggestion));
        const actions = el('div', 'card-actions');
        const copy = makeButton(t('coverage_copyLocator'), () => void copyWithFeedback(suggestion, copy), {
          icon: 'copy',
          small: true,
          title: t('coverage_copyLocatorTitle'),
        });
        actions.appendChild(copy);
        block.appendChild(actions);
        card.appendChild(block);
      }
    }
  }
}
