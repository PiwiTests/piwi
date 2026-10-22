import { t } from './i18n.js';
import { pickNameProblem, type PickNameProblem } from './session-export.js';
import { addSessionPick, getSessionPicks } from './session-storage.js';

/**
 * Add to session's one path, for every form that offers it (the DevTools
 * pages' `session-form.ts`, the Pick results): the name checked as the page
 * object needs it, then the pick appended to the session the Session tab
 * lists.
 */

/** What the form says under the name field about `problem`. */
export function pickNameProblemText(problem: PickNameProblem, name: string): string {
  switch (problem) {
    case 'required':
      return t('session_nameRequired');
    case 'reserved':
      return t('session_nameReserved', { name });
    case 'invalid':
      return t('session_nameInvalid');
    case 'taken':
      return t('session_nameTaken', { name });
  }
}

/**
 * Appends `{ name, locator, pageUrl }` to the pick session once `name` passes
 * {@link pickNameProblem}. Resolves with what the form says under the name
 * field, a name it refuses or a storage that fails, or with null once the pick
 * is kept. `pageUrl` is read only for a pick that is kept.
 */
export async function addNamedPick(
  name: string,
  locator: string,
  pageUrl: () => string | Promise<string>,
): Promise<string | null> {
  const unnamed = pickNameProblem(name, []);
  if (unnamed) return pickNameProblemText(unnamed, name);
  try {
    const taken = pickNameProblem(name, await getSessionPicks());
    if (taken) return pickNameProblemText(taken, name);
    await addSessionPick({ name, locator, pageUrl: await pageUrl() });
    return null;
  } catch (err) {
    return t('session_addFailed', { error: err instanceof Error ? err.message : String(err) });
  }
}
