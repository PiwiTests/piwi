import { DESKTOP_CHALLENGE_HEADER, DESKTOP_PROOF_HEADER, desktopTokenProof } from '@piwitests/core/desktop-proof';

/** The desktop app's `/api/health` answer to Piwi Picker's challenge, as the app holding `token` gives it. */
export async function desktopHealth(url: string, init: RequestInit | undefined, token: string): Promise<Response> {
  const challenge = new Headers(init?.headers).get(DESKTOP_CHALLENGE_HEADER) ?? '';
  const port = Number(new URL(url).port || 80);
  return new Response(JSON.stringify({ status: 'ok', database: 'ok' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      [DESKTOP_PROOF_HEADER]: await desktopTokenProof(token, port, challenge),
    },
  });
}
