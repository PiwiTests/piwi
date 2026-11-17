/**
 * The words of the layer, and of a host that keeps its own catalog the same way: messages read from a catalog by key,
 * in the shape of Piwi Picker's `messages.json` (`apps/extension/i18n/README.md`). A message's `$name$` takes the
 * value of `name`, `$$` writes a dollar sign, and a counted message has one key per plural form (`<base>_one`,
 * `<base>_other`, …), picked with the language's plural rules.
 *
 * The layer says its words through `RUN_UI_WORDS`, which a host provides once to the whole app: the language on screen,
 * the layer's catalog in that language and the run model's words (`RunSpeaker`). Without it, the layer speaks English
 * (`ENGLISH_RUN_UI_WORDS`), which is what the dashboard shows.
 */
import type { InjectionKey } from 'vue';
import {
  englishRunSpeaker,
  type RunCountKey,
  type RunSpeaker,
  type RunWordArgs,
  type RunWordKey,
} from '@piwitests/run-model/words';
import { RUN_WORD_LANGUAGES, type RunWordLanguage } from '@piwitests/run-model/speakers';
import englishCatalog from '../../locales/en.json';

/** A message as a catalog holds it. */
export interface RunUiCatalogEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

/** A catalog: its messages by key. */
export type RunUiRawCatalog = Readonly<Record<string, RunUiCatalogEntry>>;

type PlaceholderName<C, K extends keyof C> = C[K] extends { placeholders: infer P } ? keyof P & string : never;

/** The values a message of the catalog `C` takes: none for a message without placeholders. */
export type RunUiMessageArgs<C, K extends keyof C> = [PlaceholderName<C, K>] extends [never]
  ? []
  : [args: Record<PlaceholderName<C, K>, string | number>];

/** A counted message of the catalog `C`: its key without the plural form. */
export type RunUiPluralKey<C> = { [K in keyof C & string]: K extends `${infer Base}_other` ? Base : never }[keyof C &
  string];

type PluralArgs<C, B extends string> = `${B}_other` extends keyof C
  ? [Exclude<PlaceholderName<C, `${B}_other`>, 'count'>] extends [never]
    ? []
    : [args: Record<Exclude<PlaceholderName<C, `${B}_other`>, 'count'>, string | number>]
  : never;

/** How a surface reads a catalog `C`: a message by its key, and a counted one. */
export interface RunUiTranslator<C> {
  /** The message of `key`, its placeholders filled from `args`. */
  t<K extends keyof C & string>(key: K, ...args: RunUiMessageArgs<C, K>): string;
  /**
   * The counted message `base` in the plural form the language gives `count`, its `$count$` the number formatted, its
   * other placeholders filled from `args`. A form the catalog lacks falls back to `_other`.
   */
  tn<B extends RunUiPluralKey<C>>(base: B, count: number, ...args: PluralArgs<C, B>): string;
}

/** The text of `entry` with each `$name$` replaced by its value in `args` (an absent one stays) and `$$` by `$`. */
export function fillRunUiMessage(
  entry: RunUiCatalogEntry,
  args: Readonly<Record<string, string | number>> = {},
): string {
  const values = new Map(Object.entries(args).map(([name, value]) => [name.toLowerCase(), String(value)]));
  return entry.message.replace(/\$\$|\$([A-Za-z0-9_@]+)\$/g, (whole, name: string | undefined) =>
    name === undefined ? '$' : (values.get(name.toLowerCase()) ?? whole),
  );
}

/** A locale `Intl` takes, from a language tag: English for a tag it refuses. */
export function runUiLocale(language: string): string {
  try {
    return Intl.getCanonicalLocales(language)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/**
 * Reads the catalog `read()` gives, in its language, and falls back key by key to `fallback`, the English catalog. Each
 * call reads `read()` again, so a host whose `read` follows a reactive language re-renders what it says.
 */
export function runUiTranslator<C extends object>(
  read: () => { language: string; catalog: RunUiRawCatalog },
  fallback: C,
): RunUiTranslator<C> {
  const english = fallback as unknown as RunUiRawCatalog;
  const entry = (catalog: RunUiRawCatalog, key: string): RunUiCatalogEntry | undefined =>
    Object.prototype.hasOwnProperty.call(catalog, key)
      ? catalog[key]
      : Object.prototype.hasOwnProperty.call(english, key)
        ? english[key]
        : undefined;
  const say = (key: string, args?: Readonly<Record<string, string | number>>) => {
    const found = entry(read().catalog, key);
    return found ? fillRunUiMessage(found, args) : key;
  };
  return {
    t: (key, ...args) => say(key, args[0] as Readonly<Record<string, string | number>> | undefined),
    tn: (base, count, ...args) => {
      const { language, catalog } = read();
      const locale = runUiLocale(language);
      const category = new Intl.PluralRules(locale).select(count);
      const key = Object.prototype.hasOwnProperty.call(catalog, `${base}_${category}`)
        ? `${base}_${category}`
        : `${base}_other`;
      const values = {
        ...(args[0] as Record<string, string | number> | undefined),
        count: new Intl.NumberFormat(locale).format(count),
      };
      return say(key, values);
    },
  };
}

/** The languages of the layer's catalogs, by their codes: the run model's words', Piwi Picker's. */
export const RUN_UI_LANGUAGES = RUN_WORD_LANGUAGES;

export type RunUiLanguage = RunWordLanguage;

const RUN_UI_CATALOG_LOADERS: Record<Exclude<RunUiLanguage, 'en'>, () => Promise<{ default: RunUiRawCatalog }>> = {
  de: () => import('../../locales/de.json'),
  es: () => import('../../locales/es.json'),
  fr: () => import('../../locales/fr.json'),
  pt_BR: () => import('../../locales/pt_BR.json'),
};

/** The layer's catalog in `language`, loaded the first time a host asks for it. */
export async function loadRunUiCatalog(language: RunUiLanguage): Promise<RunUiRawCatalog> {
  return language === 'en' ? englishCatalog : (await RUN_UI_CATALOG_LOADERS[language]()).default;
}

/** The layer's English catalog, the source of its keys and the fallback of every other language. */
export const RUN_UI_ENGLISH_CATALOG = englishCatalog;

/** The layer's catalog, as its English source types it. */
export type RunUiCatalog = typeof englishCatalog;

/** A key of the layer's catalog. */
export type RunUiKey = keyof RunUiCatalog & string;

/** A key of the layer's catalog whose message has no placeholder. */
export type RunUiPlainKey = { [K in RunUiKey]: RunUiCatalog[K] extends { placeholders: object } ? never : K }[RunUiKey];

/** How the layer says its words in the language on screen. */
export interface RunUiWords extends RunUiTranslator<RunUiCatalog> {
  /** The language on screen, as a BCP 47 tag: `en`, `fr`, `pt-BR`. */
  readonly language: string;
  /** The run model's words, in that language. */
  readonly run: RunSpeaker;
  /** A run model's message, in that language. */
  say(key: RunWordKey, args?: RunWordArgs): string;
  /** A run model's counted message, in that language. */
  count(key: RunCountKey, count: number, args?: RunWordArgs): string;
  /** A number as the language writes it: `1,500` in English. */
  number(value: number): string;
  /** Names listed in a sentence, as the language lists them: `A, B, and C` in English. */
  list(items: readonly string[]): string;
  /** A time of day as the language writes it; the browser's own format for a host that provides no words. */
  time(date: Date): string;
}

/**
 * The layer's words from what `read()` gives: the language, its catalog of the layer, its run speaker, and the locale of
 * its times (the browser's when absent). Each call reads `read()` again, so a host whose `read` follows a reactive
 * language re-renders what the layer says.
 */
export function runUiWords(
  read: () => { language: string; catalog: RunUiRawCatalog; run: RunSpeaker; timeLocale?: string },
): RunUiWords {
  const translator = runUiTranslator(read, englishCatalog);
  return {
    get language() {
      return read().language;
    },
    get run() {
      return read().run;
    },
    t: translator.t,
    tn: translator.tn,
    say: (key, args) => read().run.say(key, args),
    count: (key, count, args) => read().run.count(key, count, args),
    number: (value) => read().run.number(value),
    list: (items) => read().run.list(items),
    time: (date) => date.toLocaleTimeString(read().timeLocale),
  };
}

/** The layer's words in English, times in the browser's format: what it says when its host provides none. */
export const ENGLISH_RUN_UI_WORDS: RunUiWords = runUiWords(() => ({
  language: 'en',
  catalog: englishCatalog,
  run: englishRunSpeaker,
}));

/** Where a host provides the layer's words (`nuxtApp.vueApp.provide`), once to the whole app. */
export const RUN_UI_WORDS: InjectionKey<RunUiWords> = Symbol('run-ui-words');
