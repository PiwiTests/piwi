/**
 * The AI narrative of a scheduled quality report: the diagnosis model asked,
 * through the provider layer, for three paragraphs grounded in the bundle
 * JSON (`shared/reports/narrative.ts`). Any failure (no provider, an error, an
 * answer that is not three paragraphs or cites a number the bundle lacks)
 * answers null, and the report keeps its rule-based verdict.
 */
import type { DbClient } from '../../database';
import { callAiProvider, resolveAiConfig, resolveAiRole } from '../ai-provider';
import {
  NARRATIVE_JSON_SCHEMA,
  narrativePrompt,
  parseNarrative,
  type GeneratedNarrative,
} from '#shared/reports/narrative';
import type { ReportBundle } from '#shared/reports/types';

export async function generateReportNarrative(db: DbClient, bundle: ReportBundle): Promise<GeneratedNarrative | null> {
  try {
    const config = await resolveAiConfig(db, { open: true });
    const role = config ? resolveAiRole(config, 'diagnosis') : null;
    if (!role) return null;
    const { system, user } = narrativePrompt(bundle);
    const res = await callAiProvider(role, {
      system,
      user,
      jsonSchema: NARRATIVE_JSON_SCHEMA as unknown as object,
      maxTokens: 1500,
      effort: 'low',
    });
    const paragraphs = parseNarrative(res.text, bundle);
    if (!paragraphs) {
      console.warn('[reports] The AI narrative was refused: not three paragraphs, or a number the report lacks');
      return null;
    }
    return { paragraphs, model: res.model || role.model };
  } catch (error) {
    console.warn('[reports] The AI narrative failed:', error instanceof Error ? error.message : error);
    return null;
  }
}
