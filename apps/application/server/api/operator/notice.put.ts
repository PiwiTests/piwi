import { operatorNoticeInputSchema, sameNotice, type OperatorNotice } from '#shared/operator-notice';
import { getDatabase } from '../../database';
import { requireOperator } from '../../utils/operator';
import { readOperatorNotice, writeOperatorNotice } from '../../utils/operator-notice';

defineRouteMeta({
  openAPI: {
    tags: ['Operator'],
    summary: 'Show a notice to the instance’s users',
    description:
      'Sets the one banner every signed-in user sees at the top of each page, replacing any other: `level` (`info`, `warning`, or `critical`, which cannot be dismissed), `text` (one line of plain text, 500 characters at most: no control, separator, bidirectional or zero-width character), an optional `link` (`url`, http or https with no user name or password, 2000 characters at most, and an optional `label` of 80), an optional `expiresAt` (an ISO 8601 date with its offset, later than now) after which nobody sees it, and `audience` (`everyone`, the default, or `administrators`). A user sees it at their next page load. A dismissed notice shows again once replaced by a different one; the same notice set again before it ends keeps its `setAt` and stays dismissed. Answers the stored notice. Open only to the token of `PIWI_OPERATOR_TOKEN`, as `GET /api/operator/usage` is.',
    security: [{ operatorToken: [] }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              level: { type: 'string', enum: ['info', 'warning', 'critical'] },
              text: { type: 'string' },
              link: {
                type: 'object',
                nullable: true,
                properties: { url: { type: 'string', format: 'uri' }, label: { type: 'string' } },
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
  const end = expiresAt ? new Date(expiresAt) : null;
  if (end && end.getTime() <= now.getTime()) {
    throw apiError({ statusCode: 400, message: 'expiresAt is not later than now' });
  }
  if (end && end.getUTCFullYear() > 9999) {
    throw apiError({ statusCode: 400, message: 'expiresAt is after the year 9999' });
  }
  const db = await getDatabase();
  const notice: OperatorNotice = {
    level,
    text,
    link: link ? { url: link.url, label: link.label ?? null } : null,
    expiresAt: end ? end.toISOString() : null,
    audience,
    setAt: now.toISOString(),
  };
  // The same notice set again while it shows keeps its `setAt`, so a browser that dismissed it is not shown it again.
  // Once it has ended, the same text is a new notice: last week's dismissal does not hide this week's.
  const current = await readOperatorNotice(db);
  const showing = current && (!current.expiresAt || Date.parse(current.expiresAt) > now.getTime());
  if (current && showing && sameNotice(current, notice)) notice.setAt = current.setAt;
  await writeOperatorNotice(db, notice);
  return { notice };
});
