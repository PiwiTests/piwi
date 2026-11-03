/** Replace every character outside `[A-Za-z0-9._-]` with an underscore, so an
 * uploaded name is safe to use as a storage path segment. */
export function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Return `name` when it is a single, traversal-free path segment that is safe
 * to append to a storage prefix, or `null` when it is not (empty, `.`/`..`, or
 * containing a path separator or NUL). The name is preserved exactly — content
 * that references a resource by name (e.g. Playwright trace `resources/src@…`
 * entries) must still resolve — so containment, not rewriting, is the guard. */
export function safeStorageSegment(name: string): string | null {
  if (!name || name === '.' || name === '..') return null;
  if (/[/\\]/.test(name) || name.includes(String.fromCharCode(0))) return null;
  return name;
}

/** Whether a stored file's relative path could leave the storage root: absolute, or with a `..` segment
 * under either separator. A name that merely holds two dots (`step-2..json`) is no way out. */
export function escapesStorageRoot(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || path.split(/[\\/]/).includes('..');
}
