import { sessionArea } from './session-area.js';

/**
 * The Locators console's history: the expressions evaluated with Enter or
 * copied, kept in session storage so that they outlive the DevTools panel
 * (closed and opened again in the same browser run), and walked with the arrow
 * keys from the field, as a shell walks its own.
 */

export const LOCATOR_HISTORY_KEY = 'piwiLocatorHistory';
/** How many expressions the history keeps; the oldest go first. */
export const LOCATOR_HISTORY_MAX = 50;

/** `history` with `expression` as its newest entry: an earlier copy of it moves to the end, the oldest past `max` go. */
export function withHistoryEntry(history: readonly string[], expression: string, max = LOCATOR_HISTORY_MAX): string[] {
  return [...history.filter((entry) => entry !== expression), expression].slice(-max);
}

/** The expressions kept, oldest first. */
export async function getLocatorHistory(): Promise<string[]> {
  const value = (await sessionArea().get(LOCATOR_HISTORY_KEY))[LOCATOR_HISTORY_KEY];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Keeps `expression` as the newest entry and returns the history; a blank one is not kept. */
export async function rememberLocator(expression: string): Promise<string[]> {
  const history = await getLocatorHistory();
  const trimmed = expression.trim();
  if (!trimmed) return history;
  const next = withHistoryEntry(history, trimmed);
  await sessionArea().set({ [LOCATOR_HISTORY_KEY]: next });
  return next;
}

/**
 * Where the arrow keys are in the history. Up goes to an older entry, Down to
 * a newer one and, past the newest, back to the text typed before the first
 * Up. An entry equal to the text in the field is passed over, so each key
 * changes it.
 */
export class HistoryCursor {
  private entries: readonly string[];
  private position: number;
  private draft = '';

  constructor(entries: readonly string[] = []) {
    this.entries = entries;
    this.position = entries.length;
  }

  /** Back at the field's own text, with `entries` as the history. */
  reset(entries: readonly string[] = this.entries): void {
    this.entries = entries;
    this.position = entries.length;
  }

  /** The entry before the one shown, or null at the oldest; `current` is the field's text. */
  older(current: string): string | null {
    let position = this.position;
    do {
      position -= 1;
    } while (position >= 0 && this.entries[position] === current);
    if (position < 0) return null;
    if (this.position === this.entries.length) this.draft = current;
    this.position = position;
    return this.entries[position]!;
  }

  /** The entry after the one shown, the text typed before past the newest, or null when that text shows already. */
  newer(current: string): string | null {
    if (this.position >= this.entries.length) return null;
    let position = this.position;
    do {
      position += 1;
    } while (position < this.entries.length && this.entries[position] === current);
    this.position = position;
    return position === this.entries.length ? this.draft : this.entries[position]!;
  }
}

/** The locator an expression names, without the `page.` (`await page.`, `this.page.`) the console accepts before it. */
export function bareLocator(expression: string): string {
  return expression.trim().replace(/^(?:await\s+)?(?:this\.)?page\./, '');
}
