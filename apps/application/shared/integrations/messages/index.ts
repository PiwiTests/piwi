/**
 * The message catalog and the `t()` a ticket's copy goes through. Kept free of
 * runtime dependencies so the builders and the policy comments
 * (`policy-comments.ts`, `server/utils/integrations/policies.ts`) call
 * `t(locale, key, params)` the same way.
 */
import { en, type MessageKey, type MessageValue } from './en';
import { fr } from './fr';

export type { MessageKey } from './en';

export const SUPPORTED_LOCALES = ['en', 'fr'] as const;
export type IssueLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: IssueLocale = 'en';

const CATALOGS: Record<IssueLocale, Record<string, MessageValue>> = { en, fr };

/** Narrow an arbitrary value to a supported locale, else null. */
export function toIssueLocale(value: unknown): IssueLocale | null {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
    ? (value as IssueLocale)
    : null;
}

/** The CLDR plural category for a count in a locale (fr: 0 and 1 are `one`). */
export function selectPlural(locale: IssueLocale, count: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(locale).select(count);
}

type Params = Record<string, string | number>;

function interpolate(locale: IssueLocale, template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value == null) return '';
    return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : String(value);
  });
}

/**
 * Translate a key for a locale. A plural value is selected by `params.count`;
 * `{name}` placeholders interpolate from `params`, numbers through the locale's
 * `Intl.NumberFormat`. Falls back to English, then to the raw key.
 */
export function t(locale: IssueLocale, key: MessageKey, params: Params = {}): string {
  const value: MessageValue | undefined = CATALOGS[locale]?.[key] ?? CATALOGS.en[key];
  if (value == null) return key;
  if (typeof value === 'string') return interpolate(locale, value, params);
  const category = params.count != null ? selectPlural(locale, Number(params.count)) : 'other';
  const form = value[category] ?? value.other;
  return interpolate(locale, form, params);
}

/** A localized medium date in UTC, or null for empty input. */
export function formatDate(locale: IssueLocale, value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' }).format(d);
}

/** A localized integer. */
export function formatNumber(locale: IssueLocale, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}
