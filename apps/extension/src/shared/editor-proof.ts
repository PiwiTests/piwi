/**
 * Whether the program at the paired editor's endpoint holds the pairing's token, asked before the token goes there
 * (Send to editor's post, the run hubs' `…/live`): a request carrying a challenge alone (`EDITOR_CHALLENGE_HEADER`)
 * is answered, refused or not, with the proof only the token's holder computes for the port it was asked on
 * (`editorTokenProof`, `@piwitests/core/editor-send`). Another program that took the port holds no token; one that
 * relays the challenge to the editor on another port gets a proof for that port. Only the background worker asks.
 */
import {
  EDITOR_CHALLENGE_HEADER,
  EDITOR_PROOF_HEADER,
  editorTokenProof,
  newEditorChallenge,
} from '@piwitests/core/editor-send';

/**
 * What the endpoint answered: the proof (`proven`), none or a wrong one (`unproven`), a 404 without one, as an editor
 * older than the proof answers (`outdated`), or nothing (`unreachable`). Only `proven` lets the token go.
 */
export type EditorProof = 'proven' | 'unproven' | 'outdated' | 'unreachable';

/** How long the endpoint may take to answer the challenge. */
const PROOF_TIMEOUT_MS = 5000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Asks `url` for the proof that it holds `token`, with a new challenge each time. */
export async function proveEditor(
  url: string,
  token: string,
  fetcher: Fetch = (input, init) => fetch(input, init),
): Promise<EditorProof> {
  const challenge = newEditorChallenge();
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { [EDITOR_CHALLENGE_HEADER]: challenge },
      redirect: 'error',
      signal: AbortSignal.timeout(PROOF_TIMEOUT_MS),
    });
  } catch {
    return 'unreachable';
  }
  const proof = response.headers.get(EDITOR_PROOF_HEADER);
  if (!proof) return response.status === 404 ? 'outdated' : 'unproven';
  const expected = await editorTokenProof(token, Number(new URL(url).port || 80), challenge);
  return sameText(proof, expected) ? 'proven' : 'unproven';
}

/** Whether two texts are the same, taking as long whatever character differs. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differ = 0;
  for (let i = 0; i < a.length; i++) differ |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differ === 0;
}
