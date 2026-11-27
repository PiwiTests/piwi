import { operatorNoticeInputSchema, type OperatorNotice } from '#shared/operator-notice';
import { getDatabase } from '../../database';
import { requireOperator } from '../../utils/operator';
import { writeOperatorNotice } from '../../utils/operator-notice';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Show a notice to the instance’s users',
    description:
      'Sets the one banner every signed-in user sees at the top of each page, replacing any other: `level` (`info`, `warning`, or `critical`, which cannot be dismissed), `text` (plain text, one line of 500 characters at most), an optional `link` (`url`, http or https, and an optional `label`), an optional `expiresAt` (an ISO 8601 date with its offset, later than now) after which nobody sees it, and `audience` (`everyone`, the default, or `administrators`). A user sees it at their next page load, and a dismissed notice shows again once replaced. Answers the stored notice. Open only to the token of `PIWI_OPERATOR_TOKEN`, as `GET /api/operator/usage` is.',
    security: [{ operatorToken: [] }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              level: { type: 'string', enum: ['info', 'warning', 'critical'] },
              text: { type: 'string', maxLength: 500 },
              link: {
                type: 'object',
                nullable: true,
                properties: { url: { type: 'string', format: 'uri' }, label: { type: 'string', maxLength: 80 } },
                required: ['url'],
              },
              expiresAt: { type: 'string', format: 'date-time', nullable: true },
              audience: { type: 'string', enum: ['everyone', 'administrators'] },
            },
            required: ['level', 'text'],
          },
        },
      },
    },
  },
});

export default eventHandler(async (event) => {
  requireOperator(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  const parsed = operatorNoticeInputSchema.safeParse(await readBody(event));
  if (!parsed.success) {
    throw apiError({ statusCode: 400, message: 'Invalid notice', data: parsed.error.issues });
  }
  const now = new Date();
  const { level, text, link, expiresAt, audience } = parsed.data;
  if (expiresAt && Date.parse(expiresAt) <= now.getTime()) {
    throw apiError({ statusCode: 400, message: 'expiresAt is not later than now' });
  }
  const notice: OperatorNotice = {
    level,
    text,
    link: link ? { url: link.url, label: link.label ?? null } : null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    audience,
    setAt: now.toISOString(),
  };
  await writeOperatorNotice(await getDatabase(), notice);
  return { notice };
});
