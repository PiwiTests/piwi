import { changelogPage } from '#shared/changelog';
import { requireAuth } from '../utils/auth';
import { bundledChangelog } from '../utils/bundled-assets';

defineRouteMeta({
  openAPI: {
    tags: ['System'],
    summary: 'Get the changelog shipped with this build',
    description:
      'The releases of the changelog shipped inside this build, newest first, one page at a time: each with its `version` (a span such as `0.4.0 – 0.4.4` for a grouped entry), the lowest and highest version it covers (`from`, `to`), its `date` as the changelog writes it, its release page `url`, its narrative `intro` and its `entries` per kind (`highlights`, `breaking`, `features`, `fixes`, `performance`, `other`) as Markdown without their commit links. `runningVersion` is the version of this build and `total` the number of releases the changelog lists, 0 when the build has none. Pass `nextCursor` as `cursor` to read the older releases. Readable by any signed-in user.',
    parameters: [
      {
        name: 'cursor',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'The `nextCursor` of the previous page: the highest version of its last release.',
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        description: 'Releases returned at most.',
      },
    ],
    'x-required-permission': 'signed-in',
  },
});

export default eventHandler(async (event) => {
  await requireAuth(event);
  const query = getQuery(event);
  return changelogPage(await bundledChangelog(), {
    runningVersion: String(useRuntimeConfig(event).public.appVersion ?? ''),
    cursor: query.cursor,
    limit: query.limit,
  });
});
