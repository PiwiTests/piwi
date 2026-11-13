import { getTableColumns } from 'drizzle-orm';
import { testRuns } from '../../server/database/schema';

/**
 * Every `test_runs` column a reader may see: all of them but the stream token,
 * which authenticates the reporter's streaming calls, the digests of the run's
 * live view keys, which take its workers' keys back, and the run's reporter,
 * of which a list says only `mine` (`#shared/own-runs`): none leaves the server.
 */
export function publicRunColumns() {
  const {
    streamToken: _streamToken,
    liveViewKeyDigests: _liveViewKeyDigests,
    reporterId: _reporterId,
    ...columns
  } = getTableColumns(testRuns);
  return columns;
}
