/**
 * The fields of a tracker's create screen, in a neutral shape the binding form,
 * the create modal and the server share: which ones the tracker requires, how a
 * value is typed, and the values a project sets for them. The Jira client maps
 * its create metadata onto this; everything here is pure and loads unchanged in
 * the app, the server and the demo.
 *
 * A value is stored as the tracker API takes it (`{ id: "10020" }` for an
 * option, `[{ accountId }]` for users) with a label to show it back, so the
 * server sends it without knowing the field and the form redisplays it without
 * asking the tracker again.
 */

/** How a field's value is entered and shaped. */
export type TrackerFieldKind =
  /** One of the listed values — `{ id }`. Single selects, radios, priority, a version or component picker. */
  | 'option'
  /** Several listed values — `[{ id }]`. Multi selects, checkboxes, components, versions. */
  | 'option-array'
  /** A listed value and, under it, one of its own: `{ id, child: { id } }`. A cascading select. */
  | 'option-cascade'
  /** One line of text. */
  | 'string'
  /** Rich text: entered as plain text, sent as a document. */
  | 'text'
  | 'number'
  /** `YYYY-MM-DD`. */
  | 'date'
  /** An ISO timestamp. */
  | 'datetime'
  /** A person — `{ accountId }`. */
  | 'user'
  /** Several people — `[{ accountId }]`. */
  | 'user-array'
  /** Free-form tags — `["a", "b"]`. */
  | 'string-array'
  /** Another issue, by key — `{ key }`. The parent. */
  | 'issue'
  /** Another issue, as its bare key — `"PROJ-12"`. An epic link. */
  | 'issue-key'
  /** A group, by name — `{ name }`. */
  | 'group'
  /** Several groups — `[{ name }]`. */
  | 'group-array'
  /** Anything else (a team, a sprint, a cascading select): the API value, typed by hand. */
  | 'raw';

export interface TrackerFieldOption {
  id: string;
  label: string;
  /** For a cascading select's second level: the listed value it sits under. */
  parentId?: string;
}

export interface TrackerField {
  /** The tracker's field id, e.g. `customfield_10042` or `components`. */
  id: string;
  /** The field's display name on the tracker, e.g. "Team". */
  name: string;
  required: boolean;
  /** The tracker fills the field when a create omits it. */
  hasDefault: boolean;
  kind: TrackerFieldKind;
  /** The values the tracker lists for the field, when it lists them. */
  options: TrackerFieldOption[] | null;
  /** The tracker's own type name, shown next to a raw field so its value can be looked up. */
  typeName: string;
}

/** A value for one field: what the tracker API takes, and how to show it. */
export interface FieldValue {
  value: unknown;
  label: string;
}

/** Field values keyed by field id. */
export type FieldValues = Record<string, FieldValue>;

/**
 * Fields Piwi fills itself, or through its own settings (the binding's default
 * assignee and labels): never asked for in the fields section and never
 * defaulted there.
 */
export const MANAGED_FIELDS: ReadonlySet<string> = new Set([
  'project',
  'issuetype',
  'summary',
  'description',
  'labels',
  'assignee',
  'reporter',
  'attachment',
  'issuelinks',
]);

/**
 * Fields a workflow transition never takes from Piwi: the project and issue
 * type, attachments and links, and the comment (a transition adds one through
 * its own update, not as a field). Everything else on a transition screen, the
 * assignee included, can carry a value from the project settings.
 */
export const TRANSITION_SKIPPED_FIELDS: ReadonlySet<string> = new Set([
  'project',
  'issuetype',
  'attachment',
  'issuelinks',
  'comment',
]);

/** The most field defaults a binding keeps. */
export const MAX_FIELD_VALUES = 50;
const MAX_VALUE_JSON = 4000;
const FIELD_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** Whether a value counts as set: not null, not an empty string, array or object. */
export function hasFieldValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/**
 * The fields a person can set: every field but the skipped ones — by default
 * {@link MANAGED_FIELDS}, the ones Piwi fills itself on a create.
 */
export function settableFields(
  fields: readonly TrackerField[],
  skipped: ReadonlySet<string> = MANAGED_FIELDS,
): TrackerField[] {
  return fields.filter((f) => !skipped.has(f.id));
}

/** The required fields the tracker does not fill and Piwi does not skip: the ones to ask for. */
export function requiredFieldsToFill(
  fields: readonly TrackerField[],
  skipped: ReadonlySet<string> = MANAGED_FIELDS,
): TrackerField[] {
  return settableFields(fields, skipped).filter((f) => f.required && !f.hasDefault);
}

/** What the create request itself provides, beyond the field values. */
export interface ProvidedByRequest {
  /** An assignee is set (the binding default, a route or the modal). */
  assignee?: boolean;
  /** An owner route sets a component. */
  components?: boolean;
}

/**
 * The required fields a create (or a transition, with its skipped set) would
 * still leave empty: required, not filled by the tracker, and not provided by
 * the values or the request. A create's assignee counts here too when the
 * tracker requires one — the modal asks for it in its own picker.
 */
export function missingRequiredFields(
  fields: readonly TrackerField[],
  values: FieldValues,
  provided: ProvidedByRequest = {},
  skipped: ReadonlySet<string> = MANAGED_FIELDS,
): TrackerField[] {
  return fields.filter((f) => {
    if (!f.required || f.hasDefault) return false;
    if (skipped.has(f.id)) return f.id === 'assignee' && !provided.assignee;
    if (f.id === 'components' && provided.components) return false;
    return !hasFieldValue(values[f.id]?.value);
  });
}

/**
 * The API values to send for a screen: the set values whose field is on it, so
 * a project default for a field another issue type does not have is left out
 * rather than refused. Without the screen (the tracker could not be asked), every
 * set value is sent.
 */
export function fieldPayload(
  values: FieldValues,
  fields: readonly TrackerField[] | null,
  skipped: ReadonlySet<string> = MANAGED_FIELDS,
): Record<string, unknown> {
  const onScreen = fields ? new Set(fields.map((f) => f.id)) : null;
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(values)) {
    if (skipped.has(id) || !hasFieldValue(entry?.value)) continue;
    if (onScreen && !onScreen.has(id)) continue;
    out[id] = entry.value;
  }
  return out;
}

/** A field list read the way a person says it: "Team", "Team and Severity", "Team, Severity and Squad". */
export function joinFieldNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The sentence a refused create carries when required fields are still empty. */
export function missingFieldsMessage(missing: readonly Pick<TrackerField, 'name'>[]): string {
  const names = joinFieldNames(missing.map((f) => f.name));
  return `Jira requires ${names} for this issue type. Fill ${missing.length === 1 ? 'it' : 'them'} in, or set a default in the project's issue tracker settings.`;
}

/** The sentence a refused transition carries when fields its screen requires have no value. */
export function missingTransitionFieldsMessage(
  missing: readonly Pick<TrackerField, 'name'>[],
  issueKey: string,
  status: string,
): string {
  const names = joinFieldNames(missing.map((f) => f.name));
  return `Jira requires ${names} to move ${issueKey} to ${status}. Set ${missing.length === 1 ? 'it' : 'them'} under that transition in the project's issue tracker settings.`;
}

/** The most listed values a hint names before trailing off. */
const HINT_OPTIONS = 10;

/**
 * What a field takes, in a few words, for a caller filling it without the form:
 * the listed values for a pick-list, else the kind of value.
 */
export function fieldValueHint(field: Pick<TrackerField, 'kind' | 'options' | 'typeName'>): string {
  const listed = (field.options ?? []).map((o) => o.label);
  const names = listed.slice(0, HINT_OPTIONS).join(', ') + (listed.length > HINT_OPTIONS ? ', …' : '');
  switch (field.kind) {
    case 'option':
      return listed.length ? `one of ${names}` : 'one listed value';
    case 'option-array':
      return listed.length ? `any of ${names}` : 'listed values';
    case 'option-cascade':
      return listed.length ? `one of ${names}` : 'one listed value';
    case 'user':
      return "a person's account id";
    case 'user-array':
      return 'account ids';
    case 'string-array':
      return 'a list of values';
    case 'number':
      return 'a number';
    case 'date':
      return 'a date, YYYY-MM-DD';
    case 'datetime':
      return 'an ISO date and time';
    case 'issue':
    case 'issue-key':
      return 'an issue key';
    case 'group':
      return 'a group name';
    case 'group-array':
      return 'group names';
    case 'raw':
      return `Jira's API value (type ${field.typeName})`;
    default:
      return 'text';
  }
}

/**
 * A value given loosely — an agent's `fields` argument — in the shape the
 * tracker API takes for the field: a listed value by its name or id, people by
 * account id, groups by name, plain text as a document, an issue by key, a
 * number from its digits. A value already in the API's shape passes through.
 */
export function coerceFieldValue(field: Pick<TrackerField, 'kind' | 'options'>, raw: unknown): unknown {
  const option = (v: unknown) => {
    if (typeof v !== 'string' && typeof v !== 'number') return v;
    const wanted = String(v).trim().toLowerCase();
    const hit = field.options?.find((o) => o.id === String(v).trim() || o.label.toLowerCase() === wanted);
    return hit ? { id: hit.id } : v;
  };
  const list = (v: unknown) => (Array.isArray(v) ? v : [v]);
  const name = (v: unknown) => (typeof v === 'string' ? { name: v.trim() } : v);
  switch (field.kind) {
    case 'option':
      return option(raw);
    case 'option-array':
      return list(raw).map(option);
    case 'option-cascade': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return raw;
      const wanted = String(raw).trim().toLowerCase();
      const hit = field.options?.find((o) => o.id === String(raw).trim() || o.label.toLowerCase() === wanted);
      return hit ? cascadeValue(hit) : raw;
    }
    case 'group':
      return name(raw);
    case 'group-array':
      return list(raw).map(name);
    case 'user':
      return typeof raw === 'string' ? { accountId: raw.trim() } : raw;
    case 'user-array':
      return list(raw).map((v) => (typeof v === 'string' ? { accountId: v.trim() } : v));
    case 'string-array':
      return list(raw);
    case 'text':
      return typeof raw === 'string' ? textToDocument(raw) : raw;
    case 'number': {
      const n = typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : raw;
    }
    case 'issue':
      return typeof raw === 'string' ? { key: raw.trim().toUpperCase() } : raw;
    case 'issue-key':
      return typeof raw === 'string' ? raw.trim().toUpperCase() : raw;
    default:
      return raw;
  }
}

/** The API value of a cascading select's listed value: `{ id }` at the first level, `{ id, child: { id } }` under it. */
export function cascadeValue(option: TrackerFieldOption): Record<string, unknown> {
  return option.parentId ? { id: option.parentId, child: { id: option.id } } : { id: option.id };
}

/**
 * A field Jira refused a create over that its create screen does not list (a
 * workflow validator can require one): the parent is an issue, anything else is
 * typed as the API value, so the dialog can still ask for it.
 */
export function fieldForProblem(problem: { id: string; name: string }): TrackerField {
  const isParent = problem.id === 'parent';
  return {
    id: problem.id,
    // A field off the screen is named by its id: the parent at least reads as Jira shows it.
    name: isParent && problem.name === problem.id ? 'Parent' : problem.name,
    required: true,
    hasDefault: false,
    kind: isParent ? 'issue' : 'raw',
    options: null,
    typeName: isParent ? 'parent' : 'unknown',
  };
}

/**
 * Normalize untrusted field values (a settings body, a stored blob): valid field
 * ids only, none of the skipped fields (by default the ones Piwi fills on a
 * create), a JSON-serializable value of bounded size, a label, and at most
 * {@link MAX_FIELD_VALUES} entries. Empty values are dropped.
 */
export function normalizeFieldValues(raw: unknown, skipped: ReadonlySet<string> = MANAGED_FIELDS): FieldValues {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: FieldValues = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_FIELD_VALUES) break;
    if (!FIELD_ID.test(id) || skipped.has(id)) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { value, label } = entry as { value?: unknown; label?: unknown };
    if (!hasFieldValue(value)) continue;
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      continue;
    }
    if (json === undefined || json.length > MAX_VALUE_JSON) continue;
    const text = typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : json.slice(0, 200);
    out[id] = { value: JSON.parse(json), label: text };
  }
  return out;
}

/** Plain text as a rich-text document: one paragraph per line. */
export function textToDocument(text: string): Record<string, unknown> {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph', content: [] },
    ),
  };
}

/**
 * The value a raw field's text stands for: parsed as JSON when it is JSON (a
 * number, an object), else the text itself (a team id).
 */
export function parseRawFieldValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
