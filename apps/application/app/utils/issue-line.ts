import type { IssueFilingFailure } from '#shared/handlers/known-issues';

/**
 * Whether a failure page shows the cluster's ticket, and in which form: the
 * cluster page's Issue line, the end of the execution page's Cluster line. One
 * rule for both pages: a tracked cluster always shows its issue; an untracked
 * one offers to file or link only while it is open and not snoozed, and only to
 * a viewer who can do one of the two; a filing waiting on the tracker shows as
 * such.
 */
export interface IssueLineFacts {
  hasKnownIssue: boolean;
  filingQueued: boolean;
  /** The cluster's triage status (`open`, `resolved`, `ignored`). */
  clusterStatus: string | null | undefined;
  snoozed: boolean;
  canFile: boolean;
  canLink: boolean;
}

export type IssueLineForm = 'tracked' | 'queued' | 'untracked' | null;

export function issueLineForm(facts: IssueLineFacts): IssueLineForm {
  if (facts.hasKnownIssue) return 'tracked';
  if (facts.filingQueued) return 'queued';
  const wantsTicket = (facts.clusterStatus ?? 'open') === 'open' && !facts.snoozed;
  if (wantsTicket && (facts.canFile || facts.canLink)) return 'untracked';
  return null;
}

/** A sentence ends with a period unless it already ends in punctuation or a closing quote. */
function endSentence(text: string): string {
  return /[.!?”"]$/.test(text) ? text : `${text}.`;
}

/**
 * The Issue line's sentence for a filing that failed for good, so filing again
 * is not a blind retry. It says how long ago when given (`ago`, such as "3 days
 * ago"), quotes Jira's own explanation when Jira gave one (the error then reads
 * "Jira request failed (400 Bad Request): <explanation>"), and gives the
 * recorded reason otherwise.
 */
export function filingFailureSentence(error: string | null | undefined, ago?: string | null): string {
  const failed = ago ? `The last filing failed ${ago}` : 'The last filing failed';
  const text = error?.trim();
  if (!text) return `${failed}.`;
  const answered = /^Jira request failed \((\d{3}[^)]*)\)(?::\s*([\s\S]+))?$/.exec(text);
  if (answered?.[2]) return `${failed}: Jira answered “${endSentence(answered[2].trim())}”`;
  if (answered) return `${failed}: Jira answered ${answered[1]}.`;
  return endSentence(`${failed}: ${text}`);
}

/**
 * The Issue line's sentence for a filing a rule left to a person, because an
 * open issue already carries the failure's labels: it names that issue, so
 * linking it is the obvious next move. It says how long ago when given.
 */
export function filingSkippedSentence(existingKey: string, ago?: string | null): string {
  const skipped = ago ? `Automatic filing skipped ${ago}` : 'Automatic filing skipped';
  return `${skipped}: ${existingKey} is already open with this failure's labels.`;
}

/**
 * The Issue line's sentence about who filed the tracked issue and when: a
 * person's name, or "automatically" for a rule. It is null when the issue was
 * linked rather than filed, so nobody is named for something they did not file.
 */
export function filedBySentence(
  filer: { filedBy?: string | null; automatic?: boolean | null },
  ago?: string | null,
): string | null {
  if (!filer.filedBy && !filer.automatic) return null;
  const who = filer.filedBy ? `Filed by ${filer.filedBy}` : 'Filed automatically';
  return ago ? `${who}, ${ago}.` : `${who}.`;
}

/**
 * Whether the Issue line offers to link the open issue a rule found carrying
 * the failure's labels: the cluster's newest filing names it and the viewer
 * may link. It holds beside a Done issue too, where filing a new one is the
 * other move.
 */
export function offersFoundIssueLink(failure: IssueFilingFailure | null | undefined, canLink: boolean): boolean {
  return canLink && !!failure?.existingKey;
}

/** The issue key link's tooltip: the key, the issue's summary, and that the link opens the tracker. */
export function issueKeyTitle(key: string, summary: string | null | undefined, tracker: string | null): string {
  const opens = `Opens in ${tracker ?? 'the tracker'}.`;
  const text = summary?.trim();
  return text ? `${key}: ${endSentence(text)} ${opens}` : `${key}. ${opens}`;
}
