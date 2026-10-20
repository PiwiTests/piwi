/**
 * Five-minute caches for the modal's Jira pickers, so opening the create modal a
 * few times does not hammer Jira with the same project / issue-type / assignable
 * lookups. Keyed by connection id and the query, shared across requests.
 */
import { TtlCache } from '../ttl-cache';
import type { TrackerField } from '#shared/integrations/fields';
import type { TransitionSample } from '#shared/integrations/transitions';
import type { TrackerIssueOption } from '#shared/integrations/types';
import type { TrackerIssueType, TrackerProject, TrackerUser } from './types';

const TTL_MS = 5 * 60 * 1000;

export const projectsCache = new TtlCache<TrackerProject[]>(TTL_MS);
export const issueTypesCache = new TtlCache<TrackerIssueType[]>(TTL_MS);
export const assignableCache = new TtlCache<TrackerUser[]>(TTL_MS);
export const createFieldsCache = new TtlCache<TrackerField[]>(TTL_MS);
export const transitionsCache = new TtlCache<TransitionSample>(TTL_MS);
/** Issues come and go faster than projects: an issue filed a minute ago is found. */
export const issuePickerCache = new TtlCache<TrackerIssueOption[]>(60 * 1000);
/** Icons barely change: an hour, and a missing one (null) is remembered too. */
export const iconCache = new TtlCache<{ bytes: Uint8Array; mime: string } | null>(60 * 60 * 1000, 300);
