import type { RunSpeaker, RunWordArgs, RunWordKey } from '@piwitests/run-model/words';
import { formatList, t, type MessageKey } from './i18n.js';

/**
 * The run model's words (`@piwitests/run-model/words`) as the Runs window says them: from the catalogs, in the
 * interface language, names listed by its rules.
 */

/** A run word is a key of the catalogs. */
const catalogKey = (key: RunWordKey): MessageKey => key;

const message = t as (key: MessageKey, args?: RunWordArgs) => string;

export const runsSpeaker: RunSpeaker = {
  say: (key, args) => message(catalogKey(key), args),
  list: formatList,
};
