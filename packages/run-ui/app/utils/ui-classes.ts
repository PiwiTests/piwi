/**
 * The neutral classes a few shared marks take, the same in the dashboard and Piwi Runner's window: code in a sentence,
 * a toggle button that is on, the current item in a strip of status-colored marks.
 */

/**
 * Code inside a heading or a sentence of the situation block — a locator, a
 * commit — sits in a small chip, so it reads as code at a glance without a second
 * font color for the prose around it. The chip wraps with its text on a narrow
 * screen, each line keeping its own edges.
 */
export const CODE_CHIP_CLASS = 'font-mono rounded-md border border-default bg-elevated px-1 box-decoration-clone';

/**
 * A toggle button that is on (`aria-pressed`), such as the Local runs tray's Watch and Interact: the neutral
 * raised surface of a selected tab, its weight kept so the label does not move.
 */
export const PRESSED_TOGGLE_CLASS = 'bg-elevated text-highlighted';

/**
 * The current item in a strip of small status-colored marks (this execution in
 * its test's history, this attempt among the retries): a ring in the strongest
 * neutral, set off the mark by the page's own background so it reads on any
 * status color in both themes.
 */
export const CURRENT_ITEM_RING_CLASS = 'ring-2 ring-offset-1 ring-offset-bg ring-inverted';
