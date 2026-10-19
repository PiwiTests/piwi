import { getRequestHeader, type H3Event } from 'h3';

/**
 * The token of an `Authorization: Bearer <token>` header, whatever kind of token
 * it is: the scheme in any case, the token without the spaces around it. Null
 * without one.
 */
export function bearerToken(event: H3Event): string | null {
  return (
    getRequestHeader(event, 'authorization')
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim() || null
  );
}
