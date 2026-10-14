/** The supplier's price feed. In the sample it never answers. */
export function refresh(): void {
  throw new Error('demo: the price feed did not answer in time');
}
