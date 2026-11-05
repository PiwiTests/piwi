import { attachmentFileName } from './sanitize-filename';

/**
 * Where each of one execution's attachments is stored, given their file names
 * in upload order, each as `attachmentFileName` makes it: `dir/<name>` for the
 * first attachment with a name and `dir/~<n>/<name>` for its n-th, so
 * attachments sharing a name each keep it, as the dashboard shows it, and none
 * overwrites another. Such a name never holds `~`, so a repeat's folder never
 * meets an attachment's name, and is never dots alone (`.`, `..`).
 */
export function attachmentStoragePaths(dir: string, uploadedNames: string[]): string[] {
  const seen = new Map<string, number>();
  return uploadedNames.map((uploaded) => {
    const name = attachmentFileName(uploaded);
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? `${dir}/${name}` : `${dir}/~${n}/${name}`;
  });
}
