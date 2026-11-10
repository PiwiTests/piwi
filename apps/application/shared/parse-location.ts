/**
 * Parse a Playwright test location string (`filePath:line:column`) into parts.
 *
 * Handles Windows paths (e.g. `C:\path\file.ts:10:5`) by reading the line and
 * column from the rightmost numeric `:`-separated segments. When no trailing
 * `:line:column` is present, `filePath` is returned unchanged with null
 * line/column.
 *
 * Lives in `shared/` so the server, the demo router, and the browser (the
 * "open in editor" affordance) all parse locations the same way.
 */
export function parseLocation(location: string): { filePath: string; line: number | null; column: number | null } {
  let filePath = location;
  let line: number | null = null;
  let column: number | null = null;

  const lastColon = location.lastIndexOf(':');
  if (lastColon > 0) {
    const lastPart = location.slice(lastColon + 1);
    if (/^\d+$/.test(lastPart)) {
      const beforeLast = location.slice(0, lastColon);
      const secondLastColon = beforeLast.lastIndexOf(':');
      if (secondLastColon > 0) {
        const middlePart = beforeLast.slice(secondLastColon + 1);
        if (/^\d+$/.test(middlePart)) {
          column = parseInt(lastPart, 10);
          line = parseInt(middlePart, 10);
          filePath = beforeLast.slice(0, secondLastColon);
        } else {
          line = parseInt(lastPart, 10);
          filePath = beforeLast;
        }
      } else {
        line = parseInt(lastPart, 10);
        filePath = beforeLast;
      }
    }
  }

  return { filePath, line, column };
}
