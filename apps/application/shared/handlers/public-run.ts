import { getTableColumns } from 'drizzle-orm';
import { testRuns } from '../../server/database/schema';

/**
 * Every `test_runs` column a reader may see: all of them but the stream token,
 * which authenticates the reporter's streaming calls and never leaves the server.
 */
export function publicRunColumns() {
  const { streamToken: _streamToken, ...columns } = getTableColumns(testRuns);
  return columns;
}
