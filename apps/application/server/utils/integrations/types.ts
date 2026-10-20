import type { IssueDocument } from '#shared/integrations/document';
import type { TrackerIssueOption } from '#shared/integrations/types';
import type { TrackerField } from '#shared/integrations/fields';

/** Tracker providers that have a server-side client. */
export type TrackerProviderName = 'jira';

/** A normalized status category, shared across trackers. */
export type TrackerStatusCategory = 'new' | 'indeterminate' | 'done';

export interface TrackerUser {
  id: string;
  displayName: string;
  email?: string | null;
}

export interface TrackerProject {
  id: string;
  key: string;
  name: string;
  /** The project's avatar, as a path on the tracker's site served through the connection. */
  icon?: string | null;
}

export interface TrackerIssueType {
  id: string;
  name: string;
  /** The issue type's icon, as a path on the tracker's site served through the connection. */
  icon?: string | null;
}

export interface TrackerTransition {
  id: string;
  name: string;
  toStatus?: string | null;
  toStatusCategory?: TrackerStatusCategory | null;
  /** The fields the transition's screen asks for; empty when it has no screen. */
  fields?: TrackerField[];
}

export interface TrackerIssue {
  /** The tracker's stable id (Jira issue id) — survives a key change on move. */
  id: string | null;
  key: string;
  url: string;
  title: string | null;
  /** The status name shown to a reader, e.g. "In Progress". */
  status: string | null;
  statusCategory: TrackerStatusCategory | null;
  /** Badge color token resolved from the category (info / warning / success). */
  statusColor: string | null;
  assignee: TrackerUser | null;
}

export interface CreateIssueInput {
  projectKey: string;
  issueType: string;
  title: string;
  body: IssueDocument;
  labels?: string[];
  assigneeId?: string | null;
  priority?: string | null;
  componentId?: string | null;
  /** Extra field values, as the tracker API takes them, keyed by field id. */
  fields?: Record<string, unknown>;
}

/** The title and description an update replaces; a field left out stays as it is. */
export interface UpdateIssueInput {
  title?: string;
  body?: IssueDocument;
}

/** An issue's title and description as plain text, as the tracker stores them. */
export interface IssueText {
  title: string | null;
  description: string;
}

export interface TrackerSearch {
  /** Free text matched against summary/description. */
  text?: string;
  /** Labels the issue must carry. */
  labels?: string[];
  /** A raw provider query (JQL for Jira), taking precedence when set. */
  jql?: string;
  limit?: number;
}

/**
 * The neutral interface every tracker client implements. A client carries a base
 * URL, a credential and a flavor across many calls, so it is a class — the
 * registry stays data, only the per-product client is stateful.
 */
export interface IssueTracker {
  readonly provider: TrackerProviderName;
  whoAmI(): Promise<{ id: string; displayName: string }>;
  listProjects(): Promise<TrackerProject[]>;
  listIssueTypes(projectKey: string): Promise<TrackerIssueType[]>;
  /** The fields of the create screen for a project and issue type (id or name). */
  listCreateFields?(projectKey: string, issueType: string): Promise<TrackerField[]>;
  searchAssignable(projectKey: string, query: string): Promise<TrackerUser[]>;
  /** Issues matching a key or words of a summary, the project's first, for a field that points at an issue. */
  pickIssues?(query: string, projectKey?: string | null): Promise<TrackerIssueOption[]>;
  /** An icon the tracker serves behind its sign-in (an issue type's, a project's), by its path on the site. */
  fetchIcon?(path: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
  createIssue(input: CreateIssueInput): Promise<TrackerIssue>;
  getIssue(key: string): Promise<TrackerIssue | null>;
  addComment(key: string, body: IssueDocument): Promise<void>;
  /** Replace an issue's title and/or description. A tracker without it keeps what Piwi first wrote. */
  updateIssue?(key: string, input: UpdateIssueInput): Promise<void>;
  /** The issue's title and description as plain text; null when the issue is gone. */
  readIssueText?(key: string): Promise<IssueText | null>;
  /** The transitions an issue offers from its current status, with their screens' fields. */
  listTransitions(key: string): Promise<TrackerTransition[]>;
  /** Move an issue through a transition, with values for its screen's fields. */
  transition(key: string, transitionId: string, fields?: Record<string, unknown>): Promise<void>;
  search(query: TrackerSearch): Promise<TrackerIssue[]>;
  attach?(key: string, file: { name: string; bytes: Uint8Array; mime: string }): Promise<void>;
  issueUrl(key: string): string;
  parseIssueUrl(url: string): { key: string } | null;
  /**
   * Provider config discovered while making calls (e.g. a Jira cloud id resolved
   * for a scoped token), for the connection layer to persist. Null until a call
   * has needed it.
   */
  detectedConfig?(): Record<string, unknown> | null;
}

/** The credential shape a tracker client is constructed with. */
export interface TrackerCredentials {
  email: string;
  apiToken: string;
}

/** Map a Jira `statusCategory.key` onto the unfurl badge color tokens. */
export function statusColorForCategory(category: TrackerStatusCategory | null): string | null {
  switch (category) {
    case 'done':
      return 'success';
    case 'indeterminate':
      return 'warning';
    case 'new':
      return 'info';
    default:
      return null;
  }
}

/**
 * How a ticket moved since the last sync saw it: into Done, out of Done
 * (reopened), or neither. Policies act on a move, not on a state, so a record
 * changed by other means is not pulled back on every sync. A move needs two
 * known categories: the first sync of a link only records where the ticket
 * stands, and a category the tracker does not report or that is not one of
 * the three known ones reads as no move.
 */
export function ticketMove(
  previous: string | null | undefined,
  current: string | null | undefined,
): 'done' | 'reopened' | null {
  const from = toStatusCategory(previous);
  const to = toStatusCategory(current);
  if (!from || !to || from === to) return null;
  if (to === 'done') return 'done';
  if (from === 'done') return 'reopened';
  return null;
}

/** Narrow an arbitrary string to a known status category, else null. */
export function toStatusCategory(key: string | null | undefined): TrackerStatusCategory | null {
  return key === 'new' || key === 'indeterminate' || key === 'done' ? key : null;
}
