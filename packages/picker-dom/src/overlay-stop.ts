/** Arguments for `showStopHighlight`. */
export interface StopHighlightArg {
  /** Names this highlight in its document, for `removeStopHighlight`. */
  id: string;
  /** `call`: the element the stopped call acts on; `count`: the matches of a locator counted at the stop. */
  kind: 'call' | 'count';
  /** The locator, as source, shown beside the first element drawn; none when empty. */
  label: string;
}

/**
 * Runs inside the browser via `locator.evaluateAll()`: draws a box over each of `elements` (the first 500) while a test
 * is stopped, in Piwi's own layer of the page, kept on them as the page scrolls or moves them, and the locator beside
 * the first one shown. Leaves the page's own elements, and Playwright's highlights, as they are. Draws nothing once
 * `removeStopHighlight` took the same `id` down in this document, as a draw that comes after the stop ended would.
 * Answers whether it drew. Must stay fully self-contained.
 */
export function showStopHighlight(elements: unknown[], arg: StopHighlightArg): boolean {
  const g = globalThis as any;
  const doc = g.document;
  const gone: Set<string> = g.__piwiStopHighlightsGone instanceof Set ? g.__piwiStopHighlightsGone : new Set();
  g.__piwiStopHighlightsGone = gone;
  if (gone.has(arg.id) || !doc || !doc.documentElement) return false;
  const Z = 2147483600;
  const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const layer = doc.createElement('div');
  layer.id = `__piwi_stop_highlight_${arg.id}`;
  layer.setAttribute('data-piwi-stop-highlight', arg.kind);
  // Out of the page's accessibility tree: an ARIA snapshot taken at the stop leaves it out.
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = `position:fixed;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:${Z - 1};`;
  // A light hairline outside the ring and a dark one outside that, so the box keeps its edge on any background.
  const look =
    arg.kind === 'call'
      ? 'border:2px solid #a855f7;background:rgba(168,85,247,.14);border-radius:4px;' +
        'box-shadow:0 0 0 1px rgba(255,255,255,.9),0 0 0 3px rgba(59,7,100,.55);'
      : 'border:2px dashed #a78bfa;background:rgba(167,139,250,.15);border-radius:3px;' +
        'box-shadow:0 0 0 1px rgba(255,255,255,.8);';
  const targets = elements.slice(0, 500) as any[];
  const boxes = targets.map(() => {
    const box = doc.createElement('div');
    box.style.cssText = `position:fixed;display:none;box-sizing:border-box;pointer-events:none;${look}`;
    layer.appendChild(box);
    return box;
  });
  const label = doc.createElement('div');
  label.style.cssText =
    'position:fixed;display:none;pointer-events:none;box-sizing:border-box;max-width:min(620px,92vw);' +
    'background:#0b1120;color:#f9fafb;border:1px solid #7c3aed;border-radius:6px;padding:2px 7px;' +
    `font:12px/1.45 ${MONO};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
    'box-shadow:0 2px 10px rgba(0,0,0,.4);';
  label.textContent = arg.label;
  layer.appendChild(label);
  doc.documentElement.appendChild(layer);

  const place = () => {
    if (!layer.isConnected) return;
    let first: any = null;
    targets.forEach((el, i) => {
      const box = boxes[i];
      const rect =
        el && el.isConnected && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';
      box.style.left = `${rect.left - 2}px`;
      box.style.top = `${rect.top - 2}px`;
      box.style.width = `${rect.width + 4}px`;
      box.style.height = `${rect.height + 4}px`;
      first ??= rect;
    });
    if (first && arg.label) {
      label.style.display = 'block';
      const height = label.offsetHeight || 20;
      const above = first.top - 2 - height - 4;
      label.style.left = `${Math.max(4, first.left - 2)}px`;
      label.style.top = `${above >= 4 ? above : first.bottom + 6}px`;
    } else {
      label.style.display = 'none';
    }
    g.requestAnimationFrame(place);
  };
  place();
  return true;
}

/**
 * Runs inside the browser via `locator.evaluateAll()` (`elements` unread): takes the highlight `id` down in this
 * document, and keeps a draw of it that comes later from drawing (`showStopHighlight`). Answers whether one showed.
 * Must stay fully self-contained.
 */
export function removeStopHighlight(_elements: unknown, id: string): boolean {
  const g = globalThis as any;
  const gone: Set<string> = g.__piwiStopHighlightsGone instanceof Set ? g.__piwiStopHighlightsGone : new Set();
  g.__piwiStopHighlightsGone = gone;
  gone.add(id);
  const layer = g.document?.getElementById(`__piwi_stop_highlight_${id}`);
  if (!layer) return false;
  layer.remove();
  return true;
}
