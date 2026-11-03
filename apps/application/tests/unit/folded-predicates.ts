/**
 * The folded text predicates (`foldedContains`, `foldedEquals`) checked against a real database engine: the values a
 * table holds, the queries they are searched with, and the scenarios every engine runs. `fold-text.test.ts` runs them
 * on both SQLite engines, `fold-text-pg.test.ts` on PostgreSQL.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { foldText } from '#shared/utils/fold-text';
import { foldedContains, foldedEquals } from '#shared/utils/fold-text-sql';

/** Text as it is written in tests and test titles, in several languages. */
export const VALUES = [
  'Résumé upload',
  'resume upload',
  'CAFÉ menu',
  'Łódź office',
  'Ærøskøbing',
  'naïve test',
  'Straße',
  'ПРИВЕТ мир',
  'Ελληνικά',
  'plain ascii',
  '100% done',
  'first_name',
  'firstXname',
  'a*b star',
  'a[b] bracket',
  'what? yes',
  'İstanbul',
  'Crème brûlée',
  'Tiếng Việt',
];

const QUERIES = [
  'resume',
  'RÉSUMÉ',
  'café',
  'CAFE',
  'lodz',
  'ŁÓDŹ',
  'skob',
  'naive',
  'NAÏVE',
  'straße',
  'STRASSE',
  'привет',
  'МИР',
  'ελληνικα',
  'ΕΛΛΗΝΙΚΆ',
  '0% d',
  'first_',
  'a*b',
  'a[b]',
  'what?',
  'istanbul',
  'creme brulee',
  'tieng viet',
  'nothing here',
];

export interface Engine {
  name: string;
  postgres: boolean;
  /** The values whose row satisfies `where`, sorted. */
  select(where: SQL): Promise<string[]>;
}

/** Build a predicate as the server would on that engine: the dialect is read from the environment. */
function build(postgres: boolean, predicate: () => SQL): SQL {
  const previous = process.env.PIWI_DATABASE_URL;
  if (postgres) process.env.PIWI_DATABASE_URL = 'postgres://test';
  else delete process.env.PIWI_DATABASE_URL;
  try {
    return predicate();
  } finally {
    if (previous === undefined) delete process.env.PIWI_DATABASE_URL;
    else process.env.PIWI_DATABASE_URL = previous;
  }
}

const value = sql.identifier('value');

/** The scenarios of the folded predicates, on the engine `open` builds. */
export function foldedPredicates(name: string, open: () => Promise<Engine>): void {
  describe(`folded SQL predicates on ${name}`, () => {
    let engine: Engine;
    beforeAll(async () => {
      engine = await open();
    });

    const contains = (query: string, wildcard = false) =>
      engine.select(build(engine.postgres, () => foldedContains(value, query, { wildcard })));
    const equals = (query: string) => engine.select(build(engine.postgres, () => foldedEquals(value, query)));

    test('a value contains a query as foldText reads them', async () => {
      for (const query of QUERIES) {
        const expected = VALUES.filter((v) => foldText(v).includes(foldText(query))).sort();
        expect({ query, rows: await contains(query) }).toEqual({ query, rows: expected });
      }
    });

    test('accents and case are ignored on either side', async () => {
      expect(await contains('resume')).toEqual(['Résumé upload', 'resume upload']);
      expect(await contains('RÉSUMÉ')).toEqual(['Résumé upload', 'resume upload']);
      expect(await contains('lodz')).toEqual(['Łódź office']);
      expect(await contains('МИР')).toEqual(['ПРИВЕТ мир']);
    });

    test('every character of a query is taken literally', async () => {
      expect(await contains('0% d')).toEqual(['100% done']);
      expect(await contains('first_')).toEqual(['first_name']);
      expect(await contains('a*b')).toEqual(['a*b star']);
      expect(await contains('a[b]')).toEqual(['a[b] bracket']);
      expect(await contains('what?')).toEqual(['what? yes']);
    });

    test('a wildcard stands for any characters', async () => {
      expect(await contains('cr*brul', true)).toEqual(['Crème brûlée']);
      expect(await contains('RES*LOAD', true)).toEqual(['Résumé upload', 'resume upload']);
      expect(await contains('load*res', true)).toEqual([]);
    });

    test('equality ignores accents and case and covers the whole value', async () => {
      expect(await equals('cafe menu')).toEqual(['CAFÉ menu']);
      expect(await equals('STRAßE')).toEqual(['Straße']);
      expect(await equals('cafe')).toEqual([]);
      expect(await equals('100% DONE')).toEqual(['100% done']);
      expect(await equals('first_name')).toEqual(['first_name']);
    });
  });
}
