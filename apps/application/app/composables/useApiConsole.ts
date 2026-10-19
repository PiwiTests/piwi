const API_TOKEN_KEY = 'piwi-api-token';

/** Remove a console token left in localStorage, where a bearer token never belongs. */
function dropPersistedToken() {
  if (!import.meta.client) return;
  try {
    localStorage.removeItem(API_TOKEN_KEY);
  } catch {
    // Storage blocked: nothing persisted to remove.
  }
}

/**
 * Shared state for the `/docs` "Try it out" console.
 *
 * The bearer token is entered once and reused across every operation's console
 * for the rest of the browser tab's session: it lives in sessionStorage, so it
 * survives a reload but not the tab, and signing out clears it. It is only ever
 * sent to the same-origin API when the user clicks Send — never to a third party.
 */
export function useApiConsole() {
  dropPersistedToken();
  const token = useSessionStorage(API_TOKEN_KEY, '');
  return { token };
}

/** Forget the console's bearer token; signing out calls it. */
export function clearApiConsoleToken() {
  dropPersistedToken();
  useSessionStorage(API_TOKEN_KEY, '').value = '';
}
