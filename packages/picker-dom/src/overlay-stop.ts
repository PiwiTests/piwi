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
 * Runs inside the browser via `locator.evaluateAll()`, again each time its caller finds the matches anew: draws a box
 * over each of `elements` (the first 500) while a test is stopped, in Piwi's own layer of the page, kept on them as the
 * page moves them, and the locator beside the first one shown. The layer is a manual popover in the page's top layer,
 * raised again on each draw, so it shows above a modal dialog or a popover the page opened and in the viewport under a
 * transformed `<html>`; without popovers it stays a fixed layer. A draw on the same elements leaves the layer as it is,
 * one on others draws it anew, and one on none takes it away. Leaves the page's own elements, and Playwright's
 * highlights, as they are. Draws nothing once `removeStopHighlight` took the same `id` down in this document, as a
 * draw that comes after the stop ended would. Answers how many boxes show. Must stay fully self-contained.
 */
export function showStopHighlight(elements: unknown[], arg: StopHighlightArg): number {
  const g = globalThis as any;
  const doc = g.document;
  const gone: Set<string> = g.__piwiStopHighlightsGone instanceof Set ? g.__piwiStopHighlightsGone : new Set();
  g.__piwiStopHighlightsGone = gone;
  if (!doc || !doc.documentElement) return 0;
  const drawn = doc.getElementById(`__piwi_stop_highlight_${arg.id}`);
  const targets = gone.has(arg.id) ? [] : (elements.slice(0, 500) as any[]);
  const shownIn = (layer: any): number =>
    Array.from(layer.children as ArrayLike<any>).filter((box) => box.dataset.box && box.style.display !== 'none')
      .length;
  /** Raise the layer above what the page put in the top layer since. */
  const raise = (layer: any) => {
    if (!layer.hasAttribute('popover')) return;
    try {
      if (layer.matches(':popover-open')) layer.hidePopover();
      layer.showPopover();
    } catch {
      // A popover the page's browser refuses: the layer stays in the page.
      layer.removeAttribute('popover');
    }
  };
  const before: any[] | undefined = drawn?.__piwiTargets;
  if (drawn && before && before.length === targets.length && before.every((el, i) => el === targets[i])) {
    if (targets.length) raise(drawn);
    drawn.__piwiPlace?.();
    return shownIn(drawn);
  }
  drawn?.remove();
  if (!targets.length) return 0;

  const Z = 2147483600;
  const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const layer = doc.createElement('div');
  layer.id = `__piwi_stop_highlight_${arg.id}`;
  layer.setAttribute('data-piwi-stop-highlight', arg.kind);
  // Out of the page's accessibility tree: an ARIA snapshot taken at the stop leaves it out.
  layer.setAttribute('aria-hidden', 'true');
  layer.setAttribute('popover', 'manual');
  // A popover's own look reset: a box of no size at the viewport's corner, its children placed in the viewport.
  layer.style.cssText =
    'position:fixed;inset:auto;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;background:transparent;' +
    `overflow:visible;pointer-events:none;z-index:${Z - 1};`;
  layer.__piwiTargets = targets;
  // A light hairline outside the ring and a dark one outside that, so the box keeps its edge on any background.
  const look =
    arg.kind === 'call'
      ? 'border:2px solid #a855f7;background:rgba(168,85,247,.14);border-radius:4px;' +
        'box-shadow:0 0 0 1px rgba(255,255,255,.9),0 0 0 3px rgba(59,7,100,.55);'
      : 'border:2px dashed #a78bfa;background:rgba(167,139,250,.15);border-radius:3px;' +
        'box-shadow:0 0 0 1px rgba(255,255,255,.8);';
  const boxes = targets.map(() => {
    const box = doc.createElement('div');
    box.dataset.box = '1';
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
  raise(layer);

  /** Place each box on its element, and the label beside the first one shown. */
  const place = () => {
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
  };
  layer.__piwiPlace = place;
  const follow = () => {
    if (!layer.isConnected) return;
    place();
    g.requestAnimationFrame(follow);
  };
  follow();
  return shownIn(layer);
}

/**
 * Runs inside the browser via `frame.evaluate()`, in each frame a highlight was drawn in: takes the highlight `id`
 * down in this document, and keeps a draw of it that comes later from drawing (`showStopHighlight`). Answers whether
 * one showed. Must stay fully self-contained.
 */
export function removeStopHighlight(id: string): boolean {
  const g = globalThis as any;
  const gone: Set<string> = g.__piwiStopHighlightsGone instanceof Set ? g.__piwiStopHighlightsGone : new Set();
  g.__piwiStopHighlightsGone = gone;
  gone.add(id);
  const layer = g.document?.getElementById(`__piwi_stop_highlight_${id}`);
  if (!layer) return false;
  layer.remove();
  return true;
}
