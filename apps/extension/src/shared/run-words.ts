import type { RunCountKey, RunSpeaker, RunWordArgs, RunWordKey } from '@piwitests/run-model/words';
import { formatList, formatNumber, t, tn, type MessageKey, type PluralKey } from './i18n.js';

/**
 * The run model's words (`@piwitests/run-model/words`) as the Runs window says them: from the catalogs, in the
 * interface language, names listed by its rules.
 */

/** A run word is a key of the catalogs, and a counted one a plural key of theirs. */
const catalogKey = (key: RunWordKey): MessageKey => key;
const pluralKey = (key: RunCountKey): PluralKey => key;

const message = t as (key: MessageKey, args?: RunWordArgs) => string;
const counted = tn as (key: PluralKey, count: number, args?: RunWordArgs) => string;

export const runsSpeaker: RunSpeaker = {
  say: (key, args) => message(catalogKey(key), args),
  count: (key, count, args) => counted(pluralKey(key), count, args),
  number: formatNumber,
  list: formatList,
};
