// The API description lists every route an instance serves and names its version: with authentication on, only a
// caller signed in by a session or an API key reads `/_openapi.json`. The in-app API reference fetches it signed in.
import { apiError } from '../utils/api-error';
import { isAuthEnabled, optionalCaller } from '../utils/auth';

const DESCRIPTION_PATH = '/_openapi.json';

/** The path read loosely (decoded, without its query, repeated or trailing slashes, in lower case), so every spelling
 * the router serves the description under is checked. */
function routedPath(raw: string): string {
  let path = raw.split('?')[0] ?? '';
  try {
    path = decodeURIComponent(path);
  } catch {
    // a malformed escape stays as it is
  }
  return path
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export default defineEventHandler(async (event) => {
  if (!isAuthEnabled(event)) return;
  if (routedPath(event.path) !== DESCRIPTION_PATH) return;
  if (await optionalCaller(event)) return;
  throw apiError({ statusCode: 401, message: 'Sign in to read the API description' });
});
