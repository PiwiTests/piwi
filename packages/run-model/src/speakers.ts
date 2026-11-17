/**
 * The run model's words in every language of Piwi Picker, for a surface without Picker's catalogs (Piwi Runner's
 * window): English from `RUN_WORDS_EN`, the others from `words/<code>.json`, which `scripts/words.mjs` writes from
 * Picker's catalogs. A language's words load when a surface first asks for them.
 */
import { RUN_WORDS_EN, englishRunSpeaker, type RunSpeaker, type RunWordKey } from './words';

/** The languages the run model's words are in, by Picker's catalogs' codes. */
export const RUN_WORD_LANGUAGES = ['en', 'de', 'es', 'fr', 'pt_BR'] as const;

export type RunWordLanguage = (typeof RUN_WORD_LANGUAGES)[number];

type Words = Readonly<Record<string, string>>;

const LOADERS: Record<Exclude<RunWordLanguage, 'en'>, () => Promise<{ default: Words }>> = {
  de: () => import('./words/de.json', { with: { type: 'json' } }),
  es: () => import('./words/es.json', { with: { type: 'json' } }),
  fr: () => import('./words/fr.json', { with: { type: 'json' } }),
  pt_BR: () => import('./words/pt_BR.json', { with: { type: 'json' } }),
};

/** Whether `code` names a language the run model's words are in. */
export function isRunWordLanguage(code: unknown): code is RunWordLanguage {
  return typeof code === 'string' && (RUN_WORD_LANGUAGES as readonly string[]).includes(code);
}

/**
 * Says `words` as the language `tag` (a BCP 47 tag) writes: each `$name$` takes the value of `name`, an absent one
 * empty, a counted message picks its plural form by the language's rules, else `_other`; a key `words` lacks is said
 * in English.
 */
export function runSpeakerOf(tag: string, words: Words): RunSpeaker {
  const plural = new Intl.PluralRules(tag);
  const number = new Intl.NumberFormat(tag);
  const list = new Intl.ListFormat(tag, { type: 'conjunction' });
  const message = (key: string): string => words[key] ?? (RUN_WORDS_EN as Readonly<Record<string, string>>)[key] ?? '';
  const speaker: RunSpeaker = {
    say(key, args = {}) {
      const values = new Map(Object.entries(args).map(([name, value]) => [name.toLowerCase(), value]));
      return message(key).replace(
        /\$([A-Za-z0-9_@]+)\$/g,
        (_whole, name: string) => values.get(name.toLowerCase()) ?? '',
      );
    },
    count(key, count, args = {}) {
      const form = `${key}_${plural.select(count)}`;
      const chosen = form in words || form in RUN_WORDS_EN ? form : `${key}_other`;
      return speaker.say(chosen as RunWordKey, { ...args, count: number.format(count) });
    },
    number: (value) => number.format(value),
    list: (items) => list.format(items),
  };
  return speaker;
}

/** The run model's words in `language`, loaded the first time it is asked for. */
export async function loadRunSpeaker(language: RunWordLanguage): Promise<RunSpeaker> {
  if (language === 'en') return englishRunSpeaker;
  const words = (await LOADERS[language]()).default;
  return runSpeakerOf(language.replace(/_/g, '-'), words);
}
