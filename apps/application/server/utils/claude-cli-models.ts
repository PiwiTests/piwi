import type { ModelInfo } from '~~/types/api';

/**
 * Models offered by the `claude-cli` provider's picker.
 *
 * The `claude` CLI accepts a family alias (always the latest of that family) or
 * a full pinned model id, and resolves whichever the signed-in account grants —
 * so the picker lists them all and the field also accepts a free-typed value.
 * Pricing is the per-million-token list rate the CLI reports as `total_cost_usd`
 * (reported even for subscription accounts that are not billed per token). The
 * CLI takes the prompt as text, so no model lists the image modality.
 */
const M = 1_000_000;

function model(id: string, label: string, contextLength: number, prompt: string, completion: string): ModelInfo {
  return { id, label, contextLength, pricing: { prompt, completion }, modalities: ['thinking'] };
}

export const CLAUDE_CLI_MODELS: ModelInfo[] = [
  // Family aliases — always resolve to the latest model in the family.
  { id: 'opus', label: 'Opus — latest', modalities: ['thinking'] },
  { id: 'sonnet', label: 'Sonnet — latest', modalities: ['thinking'] },
  { id: 'haiku', label: 'Haiku — latest', modalities: ['thinking'] },
  { id: 'fable', label: 'Fable — latest', modalities: ['thinking'] },

  // Pinned versions, newest first within each family.
  model('claude-fable-5-1', 'Fable 5.1', M, '10', '50'),
  model('claude-fable-5', 'Fable 5', M, '10', '50'),
  model('claude-opus-5', 'Opus 5', M, '5', '25'),
  model('claude-opus-4-8', 'Opus 4.8', M, '5', '25'),
  model('claude-opus-4-7', 'Opus 4.7', M, '5', '25'),
  model('claude-opus-4-6', 'Opus 4.6', M, '5', '25'),
  model('claude-sonnet-5', 'Sonnet 5', M, '2', '10'),
  model('claude-sonnet-4-6', 'Sonnet 4.6', M, '3', '15'),
  model('claude-haiku-4-5', 'Haiku 4.5', 200_000, '1', '5'),
];
