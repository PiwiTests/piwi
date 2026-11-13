import { getAppSetting } from '../app-settings';
import {
  DEFAULT_PR_FEEDBACK,
  PR_FEEDBACK_KEY,
  resolvePrFeedbackSettings,
  type PrFeedbackSettings,
} from '#shared/pr-feedback';
import type { DbClient } from '../../database';

/** Read the resolved settings, falling back to the (disabled) defaults. */
export async function getPrFeedbackSettings(db: DbClient): Promise<PrFeedbackSettings> {
  const stored = await getAppSetting<Partial<PrFeedbackSettings>>(db, PR_FEEDBACK_KEY);
  return stored ? resolvePrFeedbackSettings(stored) : { ...DEFAULT_PR_FEEDBACK };
}
