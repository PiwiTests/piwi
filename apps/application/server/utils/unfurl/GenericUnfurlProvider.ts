import { safeFetch } from '../safe-fetch';
import {
  UnfurlProvider,
  type UnfurlResult,
  UNFURL_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_REDIRECTS,
} from './UnfurlProvider';

const EMPTY: UnfurlResult = { title: null, statusText: null, statusColor: null };

/**
 * Reads a page's title (`og:title`, else `<title>`) through `safeFetch`, so the
 * URL and every redirect hop must resolve to public addresses only.
 */
export class GenericUnfurlProvider extends UnfurlProvider {
  readonly provider = 'generic' as const;

  async unfurl(url: string, _key: string | null): Promise<UnfurlResult> {
    try {
      const response = await safeFetch(
        url,
        {
          headers: {
            'User-Agent': 'Piwi-Dashboard/1.0 (+https://piwi.dashboard)',
            Accept: 'text/html,application/xhtml+xml',
          },
        },
        MAX_REDIRECTS,
        UNFURL_TIMEOUT_MS,
      );
      if (response.status >= 300 && response.status < 400) return EMPTY;

      const reader = response.body?.getReader();
      if (!reader) return EMPTY;

      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          break;
        }
      }

      const decoder = new TextDecoder();
      const html = chunks.map((c) => decoder.decode(c, { stream: false })).join('');

      const titleMatch =
        html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
        html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i) ||
        html.match(/<title>([^<]*)<\/title>/i);
      const title = titleMatch ? (titleMatch[1]?.trim() ?? null) : null;

      return { title, statusText: null, statusColor: null };
    } catch {
      return EMPTY;
    }
  }
}
