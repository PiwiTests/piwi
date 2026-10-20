import type { TrackerField, TrackerFieldKind, TrackerFieldOption } from '#shared/integrations/fields';

/** One field of Jira's create metadata (`GET /rest/api/3/issue/createmeta/{project}/issuetypes/{type}`). */
export interface JiraCreateMetaField {
  fieldId?: string;
  key?: string;
  name?: string;
  required?: boolean;
  hasDefaultValue?: boolean;
  schema?: { type?: string; items?: string; system?: string; custom?: string };
  /** What an edit can do with the field (`set`, `add`, …); a field with none of them cannot be set. */
  operations?: string[];
  allowedValues?: Array<JiraAllowedValue & { children?: JiraAllowedValue[] }>;
}

interface JiraAllowedValue {
  id?: string | number;
  value?: string;
  name?: string;
}

const TEXTAREA = 'com.atlassian.jira.plugin.system.customfieldtypes:textarea';
/** Jira Software's epic link: typed `any`, it takes the epic's key as a bare string. */
const EPIC_LINK = 'com.pyxis.greenhopper.jira:gh-epic-link';

/**
 * Custom types Jira lists on a screen but a create cannot set: the board rank
 * and the development summary are refused or ignored.
 */
const UNSETTABLE_CUSTOM_TYPES = new Set([
  'com.pyxis.greenhopper.jira:gh-lexo-rank',
  'com.atlassian.jira.plugins.jira-development-integration-plugin:devsummary',
  'com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf',
]);

/** Rich-text system fields: REST v3 takes them as documents, like the description. */
const RICH_TEXT_SYSTEM_FIELDS = new Set(['description', 'environment']);

/** How a Jira field's value is shaped, from its create-metadata schema. */
export function jiraFieldKind(schema: JiraCreateMetaField['schema']): TrackerFieldKind {
  if (schema?.custom === EPIC_LINK) return 'issue-key';
  const type = schema?.type;
  switch (type) {
    case 'string':
      return RICH_TEXT_SYSTEM_FIELDS.has(schema?.system ?? '') || schema?.custom === TEXTAREA ? 'text' : 'string';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'user':
      return 'user';
    case 'option':
    case 'priority':
    case 'resolution':
    case 'version':
    case 'component':
    case 'securitylevel':
    case 'project':
      return 'option';
    case 'option-with-child':
      return 'option-cascade';
    case 'issuelink':
      return 'issue';
    case 'group':
      return 'group';
    case 'array':
      if (schema?.items === 'option' || schema?.items === 'component' || schema?.items === 'version') {
        return 'option-array';
      }
      if (schema?.items === 'user') return 'user-array';
      if (schema?.items === 'group') return 'group-array';
      if (schema?.items === 'string') return 'string-array';
      return 'raw';
    default:
      return 'raw';
  }
}

/** The short type name a raw field is shown with: the custom type's last segment, else the schema type. */
function typeName(schema: JiraCreateMetaField['schema']): string {
  const custom = schema?.custom;
  if (custom) return custom.split(':').pop() ?? custom;
  return schema?.system ?? schema?.type ?? 'unknown';
}

const optionLabel = (v: JiraAllowedValue) => v.value ?? v.name ?? String(v.id);

/**
 * The listed values, each followed by the ones under it for a cascading select
 * ("Hardware", then "Hardware › Laptop").
 */
function toOptions(values: JiraCreateMetaField['allowedValues']): TrackerFieldOption[] | null {
  if (!Array.isArray(values)) return null;
  const options: TrackerFieldOption[] = [];
  for (const v of values) {
    if (!v || v.id == null) continue;
    const id = String(v.id);
    options.push({ id, label: optionLabel(v) });
    for (const child of v.children ?? []) {
      if (child?.id == null) continue;
      options.push({ id: String(child.id), label: `${optionLabel(v)} › ${optionLabel(child)}`, parentId: id });
    }
  }
  return options.length ? options : null;
}

/**
 * Whether a create cannot usefully set an optional field: one whose operations
 * leave out setting it, the board rank and the development summary (refused or
 * ignored on create), a system field Jira types `any`, and an issue restriction,
 * which is not a default a project sets. Every other field, custom ones typed
 * `any` included (an epic link, a plan's parent link), can be added on demand.
 */
function unsettableOnCreate(raw: JiraCreateMetaField): boolean {
  if (raw.required === true) return false;
  if (Array.isArray(raw.operations) && !raw.operations.some((op) => op === 'set' || op === 'add')) return true;
  if (UNSETTABLE_CUSTOM_TYPES.has(raw.schema?.custom ?? '')) return true;
  if (raw.schema?.type === 'any' && !raw.schema.custom) return true;
  return raw.schema?.system === 'issuerestriction';
}

/**
 * A create-metadata field as a {@link TrackerField}, or null when it has no id
 * or is an optional field a create cannot usefully set.
 */
export function jiraFieldToTrackerField(raw: JiraCreateMetaField): TrackerField | null {
  const id = raw.fieldId ?? raw.key;
  if (!id || unsettableOnCreate(raw)) return null;
  const options = toOptions(raw.allowedValues);
  let kind = jiraFieldKind(raw.schema);
  const listed = kind === 'option' || kind === 'option-array' || kind === 'option-cascade';
  // A pick-list Jira lists no values for can only be typed by hand.
  if (listed && !options) kind = 'raw';
  return {
    id,
    name: raw.name ?? id,
    required: raw.required === true,
    hasDefault: raw.hasDefaultValue === true,
    kind,
    options: listed && options ? options : null,
    typeName: typeName(raw.schema),
  };
}
