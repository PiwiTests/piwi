import { applyOperatorLimits, operatorLimitsInputSchema } from '#shared/operator-limits';
import { getDatabase } from '../../database';
import { requireOperator } from '../../utils/operator';
import { instanceLimits, updateOperatorLimits } from '../../utils/operator-limits';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Set the instance’s limits',
    description:
      'Sets any of the limits, each in place of its environment variable, for every request and task from the next one: `storageQuotaBytes` (1 MiB at least), `importMaxBytes` (1 MiB to 5 GiB), `submitMaxBytes` (1 MiB to 512 MiB), `retentionDays` (0 to 36,500; 0 keeps every run) and `readOnly`. A whole number (or a boolean for `readOnly`) sets one, `null` clears it back to its variable, and a field left out stays as it is; any other field, or a value out of its bounds, answers 400. A `retentionDays` that keeps fewer days than the nightly sweep keeps now, its variable’s once cleared included, waits 14 days: the sweep keeps the days it kept until then. While one waits, a value that keeps as many days as the waiting one or more keeps that wait, and only a still lower one waits 14 days again. One that keeps as many days as the sweep keeps now or more applies at once. With `readOnly` on, every signed-in user sees a banner, people can still sign in and out, browse and export, and every other write is refused with 409 and `errorCode` `READ_ONLY`, the reporter’s requests and an MCP client’s sign-in included; the scheduled tasks that change data skip, and the operator routes stay open. Answers what `GET /api/operator/limits` answers. Open only to the token of `PIWI_OPERATOR_TOKEN`, as `GET /api/operator/usage` is.',
    security: [{ operatorToken: [] }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              storageQuotaBytes: { type: 'integer', nullable: true, minimum: 1048576 },
              importMaxBytes: { type: 'integer', nullable: true, minimum: 1048576, maximum: 5368709120 },
              submitMaxBytes: { type: 'integer', nullable: true, minimum: 1048576, maximum: 536870912 },
              retentionDays: { type: 'integer', nullable: true, minimum: 0, maximum: 36500 },
              readOnly: { type: 'boolean', nullable: true },
            },
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  requireOperator(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  const parsed = operatorLimitsInputSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid limits', data: parsed.error.issues });
  }
  const db = await getDatabase();
  const now = new Date();
  await updateOperatorLimits(db, (stored) => applyOperatorLimits(stored, parsed.data, process.env, now));
  return { limits: instanceLimits(now) };
});
