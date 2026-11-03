/**
 * Whether a hostname names a machine only a local network can reach: loopback,
 * `0.0.0.0/8`, the private and link-local IPv4 ranges, a single-label name, or a `.local` /
 * `.internal` / `.localhost` name. A best-effort reading of the text for form
 * hints; the server's SSRF guard resolves the name and has the final word.
 */
export function looksPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '::1' || host === 'localhost') return true;
  if (['.localhost', '.local', '.internal'].some((suffix) => host.endsWith(suffix))) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return !host.includes('.') && !host.includes(':');
}
