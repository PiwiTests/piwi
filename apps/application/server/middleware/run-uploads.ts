// Counts each request receiving a run's results or files until its response closes (`runUploads`).
import { receivesRunUpload, runUploads } from '../utils/instance-activity';

export default defineEventHandler((event) => {
  if (!receivesRunUpload(event.method, event.path)) return;
  event.node.res.once('close', runUploads.open());
});
