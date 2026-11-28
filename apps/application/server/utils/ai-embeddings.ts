/**
 * Embeddings provider call for semantic failure clustering.
 *
 * Anthropic has no first-party embeddings API, so the `embedding` role must be
 * an OpenAI-compatible endpoint (OpenAI, Voyage, or a local server such as
 * Ollama / LM Studio). We hit the standard `POST {baseUrl}/embeddings` shape.
 */

import type { ResolvedAiRole } from '~~/types/api';
import { assertAiKey } from './ai-credentials';
import { connectionFetch } from './connection-fetch';

export async function embedTexts(role: ResolvedAiRole, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  assertAiKey(role);
  const baseUrl = (role.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('embedding role requires an OpenAI-compatible base URL');

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (role.apiKey) headers['authorization'] = `Bearer ${role.apiKey}`;

  const res = await connectionFetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: role.model, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`embeddings provider returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
  const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return rows.map((r) => r.embedding);
}
