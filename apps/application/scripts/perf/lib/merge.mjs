/**
 * Joins the results of a suite split across machines (`run.mjs --shard k/n`)
 * into one. Each shard measured both builds in turn on its own machine, so
 * every row still compares two builds measured side by side. Pages follow
 * shard order, which is the list's order: each shard ran a contiguous run of
 * it. An API call the pages of several shards make is kept from the first
 * shard that measured it, called by the pages of all of them.
 */
export function mergeResults(list) {
  if (list.length === 1 && !list[0].meta.shard) return list[0];
  const shards = [...list].sort((a, b) => (a.meta.shard?.index ?? 0) - (b.meta.shard?.index ?? 0));
  const total = shards[0].meta.shard?.total;
  const indexes = shards.map((r) => r.meta.shard?.index);
  if (
    shards.some((r) => r.meta.shard?.total !== total) ||
    indexes.length !== total ||
    indexes.some((index, i) => index !== i + 1)
  )
    throw new Error(`the results are not the shards 1 to ${total ?? '?'} of one run (got ${indexes.join(', ')})`);
  const names = (r) => r.meta.targets.map((t) => t.name).join(',');
  if (shards.some((r) => names(r) !== names(shards[0]) || r.meta.scale !== shards[0].meta.scale))
    throw new Error('the shards measured different targets or datasets');

  const apis = new Map();
  for (const r of shards) {
    for (const api of r.apis) {
      const kept = apis.get(api.path);
      if (!kept) {
        apis.set(api.path, api);
        continue;
      }
      kept.calledBy = [...new Set([...kept.calledBy, ...api.calledBy])];
      for (const t of Object.values(kept.targets)) t.calledBy = kept.calledBy;
    }
  }

  const first = shards[0].meta;
  return {
    ...shards[0],
    meta: {
      ...first,
      startedAt: shards.map((r) => r.meta.startedAt).sort()[0],
      finishedAt: shards
        .map((r) => r.meta.finishedAt)
        .sort()
        .at(-1),
      shard: null,
      shards: shards.map((r) => ({
        index: r.meta.shard.index,
        machine: r.meta.machine,
        pages: r.pages.map((p) => p.id),
      })),
    },
    pages: shards.flatMap((r) => r.pages),
    apis: [...apis.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}
