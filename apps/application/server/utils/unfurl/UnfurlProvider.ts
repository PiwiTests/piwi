import type { LinkProvider } from '#shared/link-detect';

export interface UnfurlResult {
  title: string | null;
  statusText: string | null;
  statusColor: string | null;
}

export const UNFURL_TIMEOUT_MS = 3000;
export const MAX_RESPONSE_BYTES = 512_000;
export const MAX_REDIRECTS = 5;

export abstract class UnfurlProvider {
  abstract readonly provider: LinkProvider;

  abstract unfurl(url: string, key: string | null): Promise<UnfurlResult>;
}
