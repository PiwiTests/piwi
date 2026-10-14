import type { PageInteraction } from '@piwitests/core/page-interaction';

/**
 * Reads, in the page, what it is doing beyond its DOM: the element holding keyboard focus (and the caret or
 * selected range of a text field), the element under the mouse, a text selection outside fields, and the
 * checkboxes in the indeterminate state. Elements are named by element path and text by offset, the format
 * `@piwitests/core/page-interaction` describes and the dashboard resolves in the failure-time DOM. Never reads
 * a field's value or the selected text.
 *
 * Runs in the browser through `page.evaluate`, so it is self-contained: no reference to this module's scope,
 * and `any` for the DOM this package has no types for.
 */
export function readPageInteraction(): PageInteraction {
  const doc: any = (globalThis as any).document;
  const SKIPPED_TEXT = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'];

  // Tag and position among same-tag siblings, from the root down; `|` into a shadow root.
  const pathOf = (el: any): string => {
    const levels: string[] = [];
    for (let node = el; node;) {
      const steps: string[] = [];
      let root: any = null;
      for (let cur = node; cur; cur = cur.parentElement) {
        let position = 1;
        for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) {
          if (s.localName === cur.localName) position++;
        }
        steps.unshift(`${cur.localName}:${position}`);
        if (!cur.parentElement) root = cur.parentNode;
      }
      levels.unshift(steps.join('/'));
      node = root && root.host ? root.host : null;
    }
    return levels.join('|');
  };
  const isField = (el: any): boolean => /^(input|textarea|select)$/.test(el.localName) || !!el.isContentEditable;
  const label = (el: any): string => {
    const tag = el.localName;
    if (el.id) return `${tag}#${el.id}`;
    for (const attr of ['name', 'aria-label']) {
      const value = el.getAttribute(attr);
      if (value) return `${tag}[${attr}="${value}"]`;
    }
    const text = isField(el)
      ? ''
      : String(el.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
    return text ? `${tag} "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"` : tag;
  };
  const ref = (el: any) => ({ path: pathOf(el), label: label(el) });

  // Characters of `el`'s text before `stop` (a node inside it, or null for all of it), plus `extra`.
  const textOffset = (el: any, stop: any, extra: number): number => {
    const walker = doc.createTreeWalker(el, 4);
    let offset = 0;
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (stop && (text === stop || stop.contains(text) || stop.compareDocumentPosition(text) & 4)) break;
      if (!SKIPPED_TEXT.includes(text.parentElement?.tagName)) offset += text.data.length;
    }
    return offset + extra;
  };
  const textPoint = (node: any, offset: number) => {
    if (node.nodeType === 3)
      return { path: pathOf(node.parentElement), offset: textOffset(node.parentElement, node, offset) };
    return { path: pathOf(node), offset: textOffset(node, node.childNodes[offset] ?? null, 0) };
  };

  const out: PageInteraction = {};

  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (active && active !== doc.body && active !== doc.documentElement) {
    let visible = false;
    try {
      visible = active.matches(':focus-visible');
    } catch {
      // A browser without :focus-visible.
    }
    out.focus = { element: ref(active), visible };
    try {
      if (typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
        out.focus.selection = [active.selectionStart, active.selectionEnd];
      }
    } catch {
      // A field type with no selection.
    }
  }

  let scope = doc;
  for (;;) {
    const chain = scope.querySelectorAll(':hover');
    const innermost = chain[chain.length - 1];
    if (!innermost) break;
    out.hover = ref(innermost);
    if (!innermost.shadowRoot) break;
    scope = innermost.shadowRoot;
  }

  const selection = doc.getSelection?.();
  if (selection && selection.rangeCount > 0 && !selection.isCollapsed && !(active && isField(active))) {
    const range = selection.getRangeAt(0);
    const start = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const end = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer;
    if (start?.nodeType === 1 && end?.nodeType === 1) {
      out.selection = {
        start: textPoint(range.startContainer, range.startOffset),
        end: textPoint(range.endContainer, range.endOffset),
        length: String(selection).length,
      };
    }
  }

  const boxes: any[] = [];
  const roots = [doc];
  for (let i = 0; i < roots.length && boxes.length < 20; i++) {
    for (const el of roots[i].querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (el.localName === 'input' && el.type === 'checkbox' && el.indeterminate && boxes.length < 20)
        boxes.push(ref(el));
    }
  }
  if (boxes.length) out.indeterminate = boxes;
  return out;
}
