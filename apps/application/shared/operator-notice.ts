import { z } from 'zod';

/**
 * The notice whoever runs the instance sets through `PUT /api/operator/notice`: one banner at a time, shown to every
 * signed-in user or to administrators only, until it is cleared or its end passes. Plain text and one optional link,
 * never HTML.
 */

/** How loudly the banner speaks: a critical notice cannot be dismissed. */
export const NOTICE_LEVELS = ['info', 'warning', 'critical'] as const;
/** Who sees the banner: every signed-in user, or the instance's administrators. */
export const NOTICE_AUDIENCES = ['everyone', 'administrators'] as const;
export const NOTICE_TEXT_MAX = 500;
export const NOTICE_LINK_LABEL_MAX = 80;
export const NOTICE_URL_MAX = 2000;

export type NoticeLevel = (typeof NOTICE_LEVELS)[number];
export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];

/** Control (`Cc`), format (`Cf`), lone surrogate (`Cs`), and line and paragraph separator characters, none of them. */
const PLAIN_LINE = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]*$/u;

/**
 * Whether `value` is one line of plain text: well-formed Unicode with no control character, no line or paragraph
 * separator and no format character, which reorders or hides text (bidirectional marks and controls, zero-width
 * characters, the byte order mark, tag characters), so what a banner says is what it shows.
 */
export function isPlainLine(value: string): boolean {
  return PLAIN_LINE.test(value);
}

/** An http or https address with no user name or password in it, which would hide the host it leads to. */
function isPlainWebAddress(value: string): boolean {
  if (!isPlainLine(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
}

const linkSchema = z
  .object({
    url: z
      .string()
      .trim()
      .max(NOTICE_URL_MAX)
      .refine(isPlainWebAddress, { message: 'an http:// or https:// address, with no user name or password' }),
    label: z
      .string()
      .trim()
      .min(1)
      .max(NOTICE_LINK_LABEL_MAX)
      .refine(isPlainLine, { message: 'one line of plain text' })
      .optional(),
  })
  .strict();

/** What the operator sends. `expiresAt` must be later than the time it is set; the route checks that. */
export const operatorNoticeInputSchema = z
  .object({
    level: z.enum(NOTICE_LEVELS),
    text: z.string().trim().min(1).max(NOTICE_TEXT_MAX).refine(isPlainLine, { message: 'one line of plain text' }),
    link: linkSchema.nullable().optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    audience: z.enum(NOTICE_AUDIENCES).default('everyone'),
  })
  .strict();

/** The notice as stored and answered: `setAt` names this one, so a dismissed notice shows again once replaced. */
export type OperatorNotice = {
  level: NoticeLevel;
  text: string;
  link: { url: string; label: string | null } | null;
  expiresAt: string | null;
  audience: NoticeAudience;
  setAt: string;
};

const storedSchema = z.object({
  level: z.enum(NOTICE_LEVELS),
  text: z.string().min(1).max(NOTICE_TEXT_MAX),
  link: z.object({ url: z.string(), label: z.string().nullable() }).nullable(),
  expiresAt: z.string().nullable(),
  audience: z.enum(NOTICE_AUDIENCES),
  setAt: z.string(),
});

/** A stored value read back as a notice, or null when it is not one. */
export function storedNotice(value: unknown): OperatorNotice | null {
  const parsed = storedSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether two notices say the same thing to the same people, whatever their end and whenever they were set. */
export function sameNotice(a: OperatorNotice, b: OperatorNotice): boolean {
  return (
    a.level === b.level &&
    a.text === b.text &&
    a.audience === b.audience &&
    a.link?.url === b.link?.url &&
    a.link?.label === b.link?.label
  );
}

/** The notice a caller sees now: none once it has ended, and none for a member when it is for administrators. */
export function visibleNotice(
  notice: OperatorNotice | null,
  viewer: { administrator: boolean; now: Date },
): OperatorNotice | null {
  if (!notice) return null;
  if (notice.expiresAt && Date.parse(notice.expiresAt) <= viewer.now.getTime()) return null;
  if (notice.audience === 'administrators' && !viewer.administrator) return null;
  return notice;
}
