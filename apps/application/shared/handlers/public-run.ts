import { getTableColumns } from 'drizzle-orm';
import { testRuns } from '../../server/database/schema';

/**
 * Every `test_runs` column a reader may see: all of them but the stream token,
 * which authenticates the reporter's streaming calls, and the digests of the
 * run's live view keys, which take its workers' keys back: neither leaves the
 * server.
 */
export function publicRunColumns() {
  const { streamToken: _streamToken, liveViewKeyDigests: _liveViewKeyDigests, ...columns } = getTableColumns(testRuns);
  return columns;
}
