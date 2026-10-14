import { setTimeout as delay } from 'node:timers/promises';
import { defineEventHandler } from 'h3';

export default defineEventHandler(async () => {
  await delay(800);
  return { ok: true };
});
