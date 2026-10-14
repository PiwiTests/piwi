import { defineEventHandler } from 'h3';
import * as inventory from '../../services/inventory-service';

/** An unhandled exception: Nitro answers a 500, and the integration adds the error to the request's logs. */
export default defineEventHandler(() => {
  inventory.sync();
  return { ok: true };
});
