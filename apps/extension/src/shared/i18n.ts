import type englishCatalog from '../../public/_locales/en/messages.json';
import { LANGUAGES, type Language } from './languages.js';

export { LANGUAGES, type Language };

/**
 * Every text the extension shows comes from here, out of the catalogs in
 * `public/_locales/<code>/messages.json`.
 *
 * By default the browser picks the catalog (`chrome.i18n.getMessage`, which
 * follows the browser's language and falls back per key to English). The
 * Language setting in Options overrides it: the background worker copies the
 * chosen catalog into `chrome.storage.local` under {@link LANGUAGE_KEY}, each
 * page or script reads it once through {@link initI18n}, and
 * {@link substitutePlaceholders} fills it in with the browser's own rules.
 *
 * Placeholders are passed by name. A message's placeholders are numbered
 * `$1`, `$2`, … in the alphabetical order of their names (the catalog check
 * enforces it), which is how a named argument reaches its position in
 * `chrome.i18n.getMessage`.
 */

type Catalog = typeof englishCatalog;

export type MessageKey = keyof Catalog & string;

type PlaceholderName<K extends MessageKey> = Catalog[K] extends { placeholders: infer P } ? keyof P & string : never;

export type MessageArgs<K extends MessageKey> = [PlaceholderName<K>] extends [never]
  ? []
  : [args: Record<PlaceholderName<K>, string | number>];

/** A counted message: `<base>_one`, `<base>_other`, … in the catalog. */
export type PluralKey = { [K in MessageKey]: K extends `${infer Base}_other` ? Base : never }[MessageKey];

type PluralArgs<B extends PluralKey> = [Exclude<PlaceholderName<`${B}_other` & MessageKey>, 'count'>] extends [never]
  ? []
  : [args: Record<Exclude<PlaceholderName<`${B}_other` & MessageKey>, 'count'>, string | number>];

/** A message as the catalogs hold it. */
export interface CatalogEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

export type RawCatalog = Record<string, CatalogEntry>;

/** The Options override in `chrome.storage.local`: the chosen language and its catalog, read from the package. */
export const LANGUAGE_KEY = 'piwiLanguage';

export interface LanguageChoice {
  code: Language;
  messages: RawCatalog;
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** `pt_BR` → `pt-BR`: the directory name as a BCP 47 tag. */
export function languageTag(code: string): string {
  return code.replace(/_/g, '-');
}

let override: { code: Language; entries: Map<string, CatalogEntry> } | null = null;

function toOverride(value: unknown): typeof override {
  const choice = value as Partial<LanguageChoice> | null | undefined;
  if (!choice || !isLanguage(choice.code) || !choice.messages || typeof choice.messages !== 'object') return null;
  // Message names are case-insensitive, as in the browser.
  const entries = new Map<string, CatalogEntry>();
  for (const [name, entry] of Object.entries(choice.messages)) {
    if (entry && typeof entry.message === 'string') entries.set(name.toLowerCase(), entry);
  }
  return { code: choice.code, entries };
}

/**
 * Reads the Options override, once per page or script, before its first
 * text. Without one, or where storage is unreachable, the browser's catalog
 * applies.
 */
export async function initI18n(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(LANGUAGE_KEY);
    override = toOverride(stored[LANGUAGE_KEY]);
  } catch {
    override = null;
  }
}

/** The language chosen in Options, or null to follow the browser. */
export function chosenLanguage(): Language | null {
  return override?.code ?? null;
}

/**
 * Fills a message in the way `chrome.i18n.getMessage` does: each `$name$`
 * becomes its placeholder's content, then `$1`…`$9` become the
 * substitutions and `$$` a single `$`. Substituted values are never read
 * again, so a `$` in a page text stays as it is.
 */
export function substitutePlaceholders(entry: CatalogEntry, substitutions: readonly string[]): string {
  const placeholders = new Map<string, string>();
  for (const [name, value] of Object.entries(entry.placeholders ?? {}))
    placeholders.set(name.toLowerCase(), value.content);
  const expanded = entry.message.replace(
    /\$([A-Za-z0-9_@]+)\$/g,
    (whole, name: string) => placeholders.get(name.toLowerCase()) ?? whole,
  );
  return expanded.replace(/\$(\$+|[1-9])/g, (_whole, rest: string) =>
    rest.startsWith('$') ? rest : (substitutions[Number(rest) - 1] ?? ''),
  );
}

function byName(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The message `key` with `args` in place, from the override when one is set. */
function lookup(key: string, args: Record<string, string | number> = {}): string {
  const substitutions = Object.keys(args)
    .sort(byName)
    .map((name) => String(args[name]));
  const entry = override?.entries.get(key.toLowerCase());
  if (entry) return substitutePlaceholders(entry, substitutions);
  try {
    return chrome.i18n.getMessage(key, substitutions);
  } catch {
    return '';
  }
}

/** The text of `key`, with its placeholders filled from `args`. */
export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string {
  return lookup(key, args[0]);
}

/**
 * The language of the texts on screen, as a BCP 47 tag: the Options choice,
 * else the browser's language when its catalog is the one shown, else the
 * language of the catalog the browser fell back to.
 */
export function uiLanguage(): string {
  if (override) return languageTag(override.code);
  let served = 'en';
  let browser = '';
  try {
    served = languageTag(chrome.i18n.getMessage('common_languageTag') || 'en');
    browser = chrome.i18n.getUILanguage();
  } catch {
    // No `chrome.i18n` here: English.
  }
  const primary = (tag: string) => tag.split('-')[0]!.toLowerCase();
  return browser && primary(browser) === primary(served) ? browser : served;
}

function safeLocale(): string {
  const tag = uiLanguage();
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/** A number in the interface language's format: `1,234` in English, `1 234` in French. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(safeLocale()).format(value);
}

/**
 * The counted message `base`: picks `<base>_one`, `<base>_other`, … with the
 * interface language's plural rules, and fills `$count$` with the formatted
 * count. A category the shown catalog lacks falls back to `_other`.
 */
export function tn<B extends PluralKey>(base: B, count: number, ...args: PluralArgs<B>): string {
  const locale = safeLocale();
  const values = { ...args[0], count: new Intl.NumberFormat(locale).format(count) };
  const category = new Intl.PluralRules(locale).select(count);
  return lookup(`${base}_${category}`, values) || lookup(`${base}_other`, values);
}

const SLOT_OPEN = '';
const SLOT_CLOSE = '';

/**
 * The message `key` with some placeholders filled by nodes (a `<kbd>`, a
 * `<code>`, a link): a list to hand to `append` or `replaceChildren`, so the
 * text goes in as text and the nodes as themselves.
 */
function lookupNodes(key: string, slots: Record<string, Node | string>): Array<Node | string> {
  const nodes: Node[] = [];
  const args: Record<string, string> = {};
  for (const [name, value] of Object.entries(slots)) {
    if (typeof value === 'string') {
      args[name] = value;
    } else {
      args[name] = `${SLOT_OPEN}${nodes.length}${SLOT_CLOSE}`;
      nodes.push(value);
    }
  }
  const used = new Set<number>();
  const parts: Array<Node | string> = [];
  const pattern = new RegExp(`${SLOT_OPEN}(\\d+)${SLOT_CLOSE}`, 'g');
  const text = lookup(key, args);
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const index = Number(match[1]);
    const node = nodes[index]!;
    parts.push(used.has(index) ? node.cloneNode(true) : node);
    used.add(index);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Like {@link t}, where a placeholder may also be a node. */
export function tNodes<K extends MessageKey>(
  key: K,
  slots: Record<PlaceholderName<K>, Node | string | number>,
): Array<Node | string> {
  const values: Record<string, Node | string> = {};
  for (const [name, value] of Object.entries(slots as Record<string, Node | string | number>)) {
    values[name] = typeof value === 'number' ? String(value) : value;
  }
  return lookupNodes(key, values);
}

/** Like {@link tn}, where a placeholder other than `$count$` may also be a node. */
export function tnNodes<B extends PluralKey>(
  base: B,
  count: number,
  slots: Record<Exclude<PlaceholderName<`${B}_other` & MessageKey>, 'count'>, Node | string | number>,
): Array<Node | string> {
  const values: Record<string, Node | string> = { count: new Intl.NumberFormat(safeLocale()).format(count) };
  for (const [name, value] of Object.entries(slots as Record<string, Node | string | number>)) {
    values[name] = typeof value === 'number' ? String(value) : value;
  }
  const category = new Intl.PluralRules(safeLocale()).select(count);
  const key = lookup(`${base}_${category}`) ? `${base}_${category}` : `${base}_other`;
  return lookupNodes(key, values);
}

const ATTRIBUTES = [
  ['data-i18n-title', 'title'],
  ['data-i18n-placeholder', 'placeholder'],
  ['data-i18n-aria-label', 'aria-label'],
] as const;

/**
 * Translates an HTML page in place: an element's `data-i18n` key replaces
 * its text, and `data-i18n-title`, `-placeholder` and `-aria-label` set
 * those attributes. Children marked `data-i18n-slot="name"` fill the
 * placeholder of that name, so a `<kbd>` or `<code>` keeps its markup.
 * Also sets `<html lang>`. Safe to run again after a language change.
 */
export function localizeDocument(doc: Document = document): void {
  doc.documentElement.lang = uiLanguage();
  for (const element of doc.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset.i18n!;
    const slots: Record<string, Node> = {};
    for (const child of element.querySelectorAll<HTMLElement>(':scope > [data-i18n-slot]')) {
      slots[child.dataset.i18nSlot!] = child;
    }
    if (Object.keys(slots).length > 0) element.replaceChildren(...lookupNodes(key, slots));
    else element.textContent = lookup(key);
  }
  for (const [data, attribute] of ATTRIBUTES) {
    for (const element of doc.querySelectorAll<HTMLElement>(`[${data}]`)) {
      element.setAttribute(attribute, lookup(element.getAttribute(data)!));
    }
  }
}

/** A language's name in that language, capitalized: `Français`, `English`, `Português (Brasil)`. */
export function languageName(code: string): string {
  const tag = languageTag(code);
  let name = tag;
  try {
    name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
  } catch {
    // An engine without display names: the code will do.
  }
  return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
}

/** The language of the catalog the browser shows, before any Options choice. */
export function browserCatalogLanguage(): string {
  try {
    return chrome.i18n.getMessage('common_languageTag') || 'en';
  } catch {
    return 'en';
  }
}
