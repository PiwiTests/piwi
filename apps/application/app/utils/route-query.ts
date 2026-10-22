type Router = ReturnType<typeof useRouter>;
/** Query keys to set; `undefined` removes a key. */
type QueryPatch = Record<string, string | null | undefined | Array<string | null>>;

/** The query the last `replaceQuery` asked for on a page, until its navigation settles. */
let requested: { path: string; query: QueryPatch } | null = null;

/**
 * Replaces keys of the URL query on top of any query change still in flight on
 * the same page, so two components that update the query in the same tick (a
 * page's tab strip and the list the new tab mounts) keep both changes. `hash`
 * sets the URL's fragment, which is dropped otherwise.
 */
export function replaceQuery(router: Router, patch: QueryPatch, options: { hash?: string } = {}) {
  const current = router.currentRoute.value;
  const base = requested?.path === current.path ? requested.query : current.query;
  const query = { ...base, ...patch };
  const request = { path: current.path, query };
  if (import.meta.client) requested = request;
  return router.replace({ query, hash: options.hash }).finally(() => {
    if (requested === request) requested = null;
  });
}
