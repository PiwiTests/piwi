/**
 * The Piwi panel's toolbar shows each tool's label while the tabs and the labelled tools fit its width in one row,
 * and the icons alone (`compact`) once they do not, whatever the language and the fonts. A compact tool keeps its
 * label for assistive technology and as its tooltip.
 */

const COMPACT = 'compact';

/** Sets `compact` on `toolbar` by whether its labelled content overflows its width. */
export function fitToolbar(toolbar: HTMLElement): void {
  toolbar.classList.remove(COMPACT);
  if (toolbar.scrollWidth > toolbar.clientWidth) toolbar.classList.add(COMPACT);
}

/**
 * Fits `toolbar` now and again whenever it or one of `parts` (whose width does not depend on `compact`) changes size.
 * Each fit waits for the next frame, so the size it changes is measured outside the observer's callback.
 */
export function keepToolbarFitted(toolbar: HTMLElement, parts: HTMLElement[]): void {
  fitToolbar(toolbar);
  let queued = false;
  const observer = new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fitToolbar(toolbar);
    });
  });
  for (const el of [toolbar, ...parts]) observer.observe(el);
}
