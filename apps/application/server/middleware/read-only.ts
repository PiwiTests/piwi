// Holds the operator's limits fresh for the request's readers, then refuses a write (409 `READ_ONLY`) while the
// instance is read-only: which requests, `readOnlyRefuses`. The built assets read no limit.
import { isReadOnly, loadOperatorLimits, readOnlyError } from '../utils/operator-limits';
import { readOnlyRefuses } from '../utils/read-only-routes';

export default defineEventHandler(async (event) => {
  if (event.path.startsWith('/_nuxt/')) return;
  await loadOperatorLimits();
  if (isReadOnly() && readOnlyRefuses(event.method, event.path)) throw readOnlyError();
});
