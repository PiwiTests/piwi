import { getDatabase } from '../../database';
import { refreshGatePullRequests } from '../../utils/gate-overrides';
import { readOnlyNow } from '../../utils/operator-limits';

export default defineTask<unknown>({
  meta: {
    name: 'gate:sweep',
    description:
      'Read the final state of pull requests a gate failed on: count the merges that overrode the gate, and the caught clusters that failed again on the default branch. Skipped while the instance is read-only',
  },
  async run() {
    const db = await getDatabase();
    if (await readOnlyNow(db)) return { result: { skipped: 'read-only' } };
    const sweep = await refreshGatePullRequests(db);
    if (sweep.merged > 0 || sweep.closed > 0 || sweep.overrides > 0 || sweep.escapes > 0) {
      console.info(
        `[gate:sweep] checked=${sweep.checked} merged=${sweep.merged} closed=${sweep.closed} overrides=${sweep.overrides} escapes=${sweep.escapes}`,
      );
    }
    return { result: sweep };
  },
});
