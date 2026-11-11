/**
 * The search language of the test lists (`#shared/test-search`) as SQL
 * predicates, for a list the server pages. It follows the in-memory matcher
 * term for term: text fields match anywhere inside the value with `*` as a
 * wildcard, the others match a whole value, case and accents never matter
 * (`foldedContains` / `foldedEquals`), and repeated single-value qualifiers
 * widen.
 *
 * A NULL column compares as an empty value, so an exclusion (`-owner:alice`)
 * keeps the rows with no value, as the in-memory matcher does.
 *
 * `is:` reads a running attempt's state, which no stored column holds: it
 * matches no row, and `-is:` excludes none.
 */
import { not, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { foldedContains, foldedEquals } from '#shared/utils/fold-text-sql';
import {
  freeTextFields,
  testSearchFieldDef,
  TEST_SEARCH_NUMBER_FIELDS,
  type TestSearchField,
  type TestSearchQuery,
} from '#shared/test-search';

/**
 * The column behind each qualifier. `describe` is the describe path with its
 * blocks joined by `\x1f`; `tag` and `lock` are JSON arrays of strings (tags
 * without their `@`); `worker` is the lane from 0 (`parallel_index`), which
 * `worker:` reads from 1, and `shard` the shard from 1 (`shard_index`). A field
 * without a column matches nothing; `is` never has one.
 */
export type TestSearchColumns = Partial<Record<Exclude<TestSearchField, 'is'>, SQLWrapper>>;

const JSON_ARRAY_FIELDS: ReadonlySet<TestSearchField> = new Set(['tag', 'lock']);

/** `value` anywhere in the column, `*` as a wildcard. */
function containsPredicate(column: SQLWrapper, value: string): SQL {
  return foldedContains(sql`COALESCE(${column}, '')`, value, { wildcard: true });
}

/** The column holds exactly `value`. */
function exactPredicate(column: SQLWrapper, value: string): SQL {
  return foldedEquals(sql`COALESCE(${column}, '')`, value);
}

/** The JSON array column has an element equal to `value`: the JSON-encoded element, quotes included. */
function arrayElementPredicate(column: SQLWrapper, value: string): SQL {
  return foldedContains(sql`COALESCE(CAST(${column} AS TEXT), '')`, JSON.stringify(value));
}

/**
 * The integer column equals the number a value names, less `offset`; a value that names no number matches nothing. A
 * NULL column is false, never NULL, so an exclusion keeps it.
 */
function numberPredicate(column: SQLWrapper, value: string, offset: number): SQL | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value) - offset;
  return Number.isSafeInteger(n) ? sql`(${column} IS NOT NULL AND ${column} = ${n})` : null;
}

function fieldPredicate(field: TestSearchField, value: string, columns: TestSearchColumns): SQL | null {
  if (field === 'is') return null;
  const column = columns[field];
  if (!column) return null;
  if (TEST_SEARCH_NUMBER_FIELDS.has(field)) return numberPredicate(column, value, field === 'worker' ? 1 : 0);
  if (JSON_ARRAY_FIELDS.has(field)) return arrayElementPredicate(column, value);
  return testSearchFieldDef(field).match === 'contains'
    ? containsPredicate(column, value)
    : exactPredicate(column, value);
}

/** The conditions a query adds to a WHERE clause, to be combined with AND. */
export function testSearchConditions(query: TestSearchQuery, columns: TestSearchColumns): SQL[] {
  const conditions: SQL[] = [];
  const anyOf = new Map<TestSearchField, SQL[]>();
  const free = freeTextFields(query.fields);
  for (const term of query.terms) {
    let predicate: SQL | null;
    if (term.field === null) {
      const parts = free.map((field) => fieldPredicate(field, term.value, columns)).filter((p): p is SQL => !!p);
      predicate = parts.length > 0 ? or(...parts)! : null;
    } else {
      predicate = fieldPredicate(term.field, term.value, columns);
    }
    if (term.negated) {
      if (predicate) conditions.push(not(predicate));
    } else if (!predicate) {
      conditions.push(sql`1 = 0`);
    } else if (term.field && testSearchFieldDef(term.field).single) {
      const group = anyOf.get(term.field) ?? [];
      group.push(predicate);
      anyOf.set(term.field, group);
    } else {
      conditions.push(predicate);
    }
  }
  for (const group of anyOf.values()) conditions.push(group.length === 1 ? group[0]! : or(...group)!);
  return conditions;
}
