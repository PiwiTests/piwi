// Counts each request that receives a run's results or files, or ends a run, until it closes (`runRequests`).
import { isRunRequest, runRequests } from '../utils/instance-activity';

export default eventHandler((event) => {
  if (!isRunRequest(event.method, event.path)) return;
  const node = event.runtime?.node;
  node?.res?.once('close', runRequests.open());
});
