/**
 * The last Where a person sent a run to, kept per browser and per project, which the run dialog picks first when it
 * opens. A Where is `app:<target id>` for one of the person's apps, or `ci:<action id>` for a CI action.
 */
const RUN_WHERE_KEY = 'piwi-run-where';

function readAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RUN_WHERE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The Where last sent to in this project, from this browser; null when none, or storage cannot be read. */
export function keptRunWhere(projectId: number): string | null {
  const kept = readAll()[String(projectId)];
  return typeof kept === 'string' && /^(app|ci):./.test(kept) ? kept : null;
}

/** Keep the Where just sent to, for this project, in this browser. */
export function keepRunWhere(projectId: number, where: string): void {
  try {
    localStorage.setItem(RUN_WHERE_KEY, JSON.stringify({ ...readAll(), [String(projectId)]: where }));
  } catch {
    // Storage blocked: the dialog picks the place's default next time.
  }
}
