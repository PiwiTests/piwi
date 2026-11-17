/**
 * The transitions a project's issues offer, so the binding form can show where
 * the fix and reopen transitions lead and which fields their screens ask for.
 * Jira reports transitions per issue — they follow the issue's workflow and
 * status — so they are read from one sample issue in the state the policy starts
 * from: open for the fix transition, done for the reopen one. The sample is the
 * most recently updated issue Piwi filed in the project, else one of the bound
 * issue type. A sample is cached five minutes like the other pickers.
 */
import type { DbClient } from '../../database';
import type { TrackerTransitionOption, TransitionSample } from '#shared/integrations/transitions';
import { createTracker, nullWhenRefused } from './connections';
import { transitionsCache } from './picker-cache';
import type { TrackerTransition } from './types';

/** The state a sample issue is in: open (the fix transition starts there) or done (the reopen one). */
export type TransitionSampleFrom = 'open' | 'done';

/** A JQL value: a bare number stays an id, anything else is quoted. */
function jqlValue(value: string): string {
  return /^\d+$/.test(value) ? value : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The queries for a sample issue, most specific first: Piwi's own issues, then the bound issue type. */
export function sampleIssueQueries(
  projectKey: string,
  from: TransitionSampleFrom,
  issueType?: string | null,
): string[] {
  const state = from === 'done' ? 'statusCategory = Done' : 'statusCategory != Done';
  const project = `project = ${jqlValue(projectKey)}`;
  const queries = [`${project} AND labels = piwi AND ${state} ORDER BY updated DESC`];
  if (issueType) queries.push(`${project} AND issuetype = ${jqlValue(issueType)} AND ${state} ORDER BY updated DESC`);
  return queries;
}

function toOption(t: TrackerTransition): TrackerTransitionOption {
  return {
    id: t.id,
    name: t.name,
    toStatus: t.toStatus ?? null,
    toStatusCategory: t.toStatusCategory ?? null,
    fields: t.fields ?? [],
  };
}

/**
 * The transitions a sample issue offers, or null when the connection cannot be
 * used (no credentials). A project with no issue in that state yet gives a sample
 * with no issue. A tracker error propagates.
 */
export async function getTransitionSample(
  db: DbClient,
  connectionId: number,
  projectKey: string,
  from: TransitionSampleFrom,
  issueType?: string | null,
): Promise<TransitionSample | null> {
  const cacheKey = `${connectionId}:${projectKey}:${issueType ?? ''}:${from}`;
  const cached = transitionsCache.get(cacheKey);
  if (cached) return cached;

  const tracker = await nullWhenRefused(createTracker(db, connectionId));
  if (!tracker) return null;

  for (const jql of sampleIssueQueries(projectKey, from, issueType)) {
    const [issue] = await tracker.search({ jql, limit: 1 });
    if (!issue) continue;
    const transitions = await tracker.listTransitions(issue.key);
    const sample = { issue: { key: issue.key, status: issue.status }, transitions: transitions.map(toOption) };
    transitionsCache.set(cacheKey, sample);
    return sample;
  }
  // Not cached: the form reads a sample as soon as the project has one.
  return { issue: null, transitions: [] };
}
