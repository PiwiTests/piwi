import type { SessionPick } from './session-storage.js';

/** Names a page object's own members hold: its `page`, and the `constructor` no field may be called. */
const RESERVED_PICK_NAMES = new Set(['page', 'constructor']);

/** A pick's name becomes a class field name in the fixture export: a valid JS identifier, and none the class holds. */
export function isValidPickName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !isReservedPickName(name);
}

/** Whether `name` is taken by the page object's own members. */
export function isReservedPickName(name: string): boolean {
  return RESERVED_PICK_NAMES.has(name);
}

/** Why a name cannot name a new pick: none typed, one the page object uses, not an identifier, or one in the list. */
export type PickNameProblem = 'required' | 'reserved' | 'invalid' | 'taken';

/** What keeps `name` from naming a new pick beside `picks`; null when it can. */
export function pickNameProblem(name: string, picks: readonly SessionPick[]): PickNameProblem | null {
  if (!name) return 'required';
  if (isReservedPickName(name)) return 'reserved';
  if (!isValidPickName(name)) return 'invalid';
  if (picks.some((pick) => pick.name === name)) return 'taken';
  return null;
}

/**
 * A Playwright POM-style class, as Playwright's docs write one: a `readonly`
 * field per named pick, set in the constructor from its `page`.
 */
export function renderFixture(picks: SessionPick[]): string {
  const fields = picks.map((p) => `  readonly ${p.name}: Locator;`);
  const assignments = picks.map((p) => `    this.${p.name} = page.${p.locator};`);
  return [
    `import type { ${picks.length > 0 ? 'Locator, ' : ''}Page } from '@playwright/test';`,
    ``,
    `export class PickedElements {`,
    `  readonly page: Page;`,
    ...fields,
    ``,
    `  constructor(page: Page) {`,
    `    this.page = page;`,
    ...assignments,
    `  }`,
    `}`,
  ].join('\n');
}

/** A cell of a Markdown table: a `|` in it would end the cell. */
function tableCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** A table shareable in a PR description or issue — GitHub-flavored Markdown renders it directly. */
export function renderMarkdown(picks: SessionPick[]): string {
  const header = '| Name | Locator | Page |\n|---|---|---|';
  const rows = picks.map((p) => `| ${p.name} | \`${tableCell(p.locator)}\` | ${tableCell(p.pageUrl)} |`);
  return [header, ...rows].join('\n');
}

export function renderJson(picks: SessionPick[]): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), picks }, null, 2);
}
