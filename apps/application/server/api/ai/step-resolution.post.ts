import { z } from 'zod';
import { requireAuth } from '../../utils/auth';
import { checkRateLimit, rateLimitClientIp, rateLimitedError } from '../../utils/rate-limit';
import { getDatabase } from '../../database';
import { resolveAiConfig } from '../../utils/ai-provider';
import { resolveStep } from '../../utils/ai-step-resolver';
import type { StepResolutionRequest } from '#shared/ai-step-resolution';

defineRouteMeta({
  openAPI: {
    tags: ['AI'],
    summary: 'Resolve one AI-step iteration (authoring)',
    description:
      'Given a natural-language template, the current page ARIA snapshot and the actions taken so far, returns one step decision (an element + action, or done + postcondition) for the Piwi reporter to compile into a committed artifact. Requires `run:submit` on at least one project (Maintainer, Project admin or Uploader) and a configured AI provider (see Settings → AI). The reporter calls this only in resolve/heal mode; normal test runs never hit it. Every field is bounded (a 4,000-character template, at most 200 history items and 200 observed responses, a screenshot of at most 5,000,000 base64 characters), and a caller makes at most 300 calls in five minutes (429 past that).',
    'x-required-permission': 'run:submit',
  },
});

/** The longest a single field may be: one iteration never needs more. */
const MAX_TEMPLATE_CHARS = 4_000;
const MAX_SNAPSHOT_CHARS = 1_000_000;
const MAX_TEXT_CHARS = 4_000;
const MAX_ITEMS = 200;
/** A base64 screenshot of about 3.7 MB. */
const MAX_SCREENSHOT_CHARS = 5_000_000;
/** Calls one caller may make per window: a 20-step flow takes about 40. */
const RATE_LIMIT = { limit: 300, windowMs: 5 * 60_000 };

const elementSchema = z.object({
  role: z.string().min(1).max(100),
  name: z.string().max(MAX_TEXT_CHARS).optional(),
  level: z.number().optional(),
  ref: z.string().max(100).optional(),
});

const requestSchema = z.object({
  kind: z.enum(['locator', 'run', 'wait']),
  template: z.string().min(1).max(MAX_TEMPLATE_CHARS),
  paramNames: z.array(z.string().max(200)).max(MAX_ITEMS).default([]),
  ariaSnapshot: z.string().max(MAX_SNAPSHOT_CHARS).default(''),
  history: z
    .array(
      z.object({
        action: z.string().max(100),
        element: elementSchema.optional(),
        value: z.string().max(MAX_TEXT_CHARS).optional(),
      }),
    )
    .max(MAX_ITEMS)
    .default([]),
  observedResponses: z.array(z.string().max(MAX_TEXT_CHARS)).max(MAX_ITEMS).optional(),
  screenshot: z
    .object({ mediaType: z.enum(['image/png', 'image/jpeg']), data: z.string().max(MAX_SCREENSHOT_CHARS) })
    .optional(),
});

export default eventHandler(async (event) => {
  const user = await requireAuth(event);
  // With authentication off every caller is user 0, so the source address tells callers apart.
  const rateKey = `ai-step:${user.id || rateLimitClientIp(event)}`;
  if (!checkRateLimit(rateKey, RATE_LIMIT.limit, RATE_LIMIT.windowMs)) {
    throw rateLimitedError(event, [rateKey], 'Too many AI step resolutions. Please wait a few minutes.');
  }

  const validation = requestSchema.safeParse(await readBody(event));
  if (!validation.success) {
    throw apiError({ statusCode: 400, message: 'Invalid request body', data: validation.error.issues });
  }

  const db = await getDatabase();
  const config = await resolveAiConfig(db);
  // Planning/grounding reuses the research role (cheaper tier) with a diagnosis
  // fallback — the same ladder the test-function extractor uses.
  const role = config?.roles.research ?? config?.roles.diagnosis;
  if (!role) {
    throw apiError({
      statusCode: 503,
      errorCode: 'AI_NOT_CONFIGURED',
      message: 'AI is not configured for this instance — set it up in Settings → AI to author AI steps.',
    });
  }

  try {
    const result = await resolveStep(role, validation.data as StepResolutionRequest);
    return result.decision;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resolve the step';
    throw apiError({ statusCode: 422, message });
  }
});
