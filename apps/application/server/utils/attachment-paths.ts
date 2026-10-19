/**
 * Where each of one execution's attachments is stored, given their sanitized
 * file names in upload order: `dir/<name>` for the first attachment with a
 * name and `dir/~<n>/<name>` for its n-th, so attachments sharing a name each
 * keep it, as the dashboard shows it, and none overwrites another. A sanitized
 * name never holds `~`, so a repeat's folder never meets an attachment's name.
 */
export function attachmentStoragePaths(dir: string, names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? `${dir}/${name}` : `${dir}/~${n}/${name}`;
  });
}
