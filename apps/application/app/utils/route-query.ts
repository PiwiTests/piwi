type Router = ReturnType<typeof useRouter>;
/** Query keys to set; `undefined` removes a key. */
type QueryPatch = Record<string, string | null | undefined | Array<string | null>>;

/** The query the last `replaceQuery` asked for, until its navigation settles. */
let requested: QueryPatch | null = null;

/**
 * Replaces keys of the URL query on top of any query change still in flight,
 * so two components that update the query in the same tick (a page's tab strip
 * and the list the new tab mounts) keep both changes.
 */
export function replaceQuery(router: Router, patch: QueryPatch) {
  const query = { ...(requested ?? router.currentRoute.value.query), ...patch };
  if (import.meta.client) requested = query;
  return router.replace({ query }).finally(() => {
    if (requested === query) requested = null;
  });
}
