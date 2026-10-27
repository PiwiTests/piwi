import { describe, expect, test } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GUIDE_ANCHOR_EXEMPTIONS,
  GUIDE_ANCHOR_KINDS,
  GUIDE_AREAS,
  type GuideAreaId,
  type GuideCoverageRule,
} from '#shared/guide-anchors/index.mjs';
import { HELP_TOPICS } from '~/utils/help-content';
import {
  AREA_IDS,
  COMPONENT_AREAS,
  COMPONENT_DIR_AREAS,
  TAB_LISTS,
  TOPIC_AREAS,
  coverageItems,
  describeItem,
  sentenceProblem,
  sidebarDestinations,
  staticHelpTopics,
  tabValues,
  type CoverageItem,
} from './guide-anchor-source';

/**
 * Every block someone could ask about has a guide anchor, as five rules:
 *
 * - `page`: every page of `app/pages` has an anchor of kind `page` listing it;
 * - `tab`: every tab the URL selects (`TAB_LISTS`, read from the code) has an
 *   anchor of kind `tab` on its page whose `query` reveal selects exactly it;
 * - `field`: every field of `SETTINGS_PAGES` has an anchor of kind `field` on
 *   its page whose `help` is the field's topic;
 * - `help`: every help topic a `.vue` file sets statically is the `help` of an
 *   anchor;
 * - `nav`: every sidebar destination carries the `data-tour` of an anchor of
 *   kind `nav`.
 *
 * An item that gets no anchor is listed in its area file's exemptions, with
 * the reason. Each item belongs to one area (`guide-anchor-source.ts`); with
 * `GUIDE_AREA=<area>` set, only that area's items, anchors and exemptions are
 * asserted.
 */

const area = process.env.GUIDE_AREA as GuideAreaId | undefined;
const inArea = (itemArea: GuideAreaId | undefined) => area === undefined || itemArea === area;

const items = coverageItems();
const anchors = GUIDE_AREAS.filter(({ id }) => inArea(id)).flatMap(({ anchors }) => anchors);
const allAnchors = GUIDE_AREAS.flatMap(({ anchors }) => anchors);
const exempted = new Set(GUIDE_ANCHOR_EXEMPTIONS.map(({ rule, key }) => `${rule} ${key}`));

/** The items of `rule` in the area under test that no anchor covers and no exemption names. */
function uncovered(rule: GuideCoverageRule): CoverageItem[] {
  return items.filter(
    (item) =>
      item.rule === rule &&
      inArea(item.area) &&
      !exempted.has(`${rule} ${item.key}`) &&
      !allAnchors.some((anchor) => item.covers(anchor)),
  );
}

describe('GUIDE_AREA', () => {
  test('names an area of the registry when set', () => {
    if (area !== undefined) expect(AREA_IDS, `GUIDE_AREA=${area}`).toContain(area);
  });
});

describe('the coverage rules read the source', () => {
  test.each(TAB_LISTS.map((list) => [`${list.page} in ${list.file}`, list] as const))(
    'the tab list of %s is found',
    (_, list) => {
      expect(tabValues(list).length, `no values after "${list.marker}" in ${list.file}`).toBeGreaterThan(1);
    },
  );

  test('the sidebar’s destinations are found', () => {
    const destinations = sidebarDestinations().map(({ to }) => to);
    expect(destinations).toContain('/');
    expect(destinations).toContain('/projects/[id]');
  });

  test('the static help topics are found', () => {
    const topics = staticHelpTopics();
    expect(topics.get('case.network'), 'a :help literal').toBeDefined();
    expect(topics.get('ide.open'), 'a HelpHint topic').toBeDefined();
    expect(topics.get('cluster.activity'), 'a help prop default').toBeDefined();
  });

  test('every item has an area', () => {
    expect(
      items.filter((item) => item.area === undefined).map(describeItem),
      'items of no area: give each file a directory area or an entry in COMPONENT_AREAS',
    ).toEqual([]);
  });

  test('every area override names a file, a directory and a topic that exist', () => {
    const appDir = fileURLToPath(new URL('../../app', import.meta.url));
    expect(Object.keys(COMPONENT_AREAS).filter((path) => !existsSync(`${appDir}/${path}`))).toEqual([]);
    expect(Object.keys(COMPONENT_DIR_AREAS).filter((dir) => !existsSync(`${appDir}/components/${dir}`))).toEqual([]);
    expect(Object.keys(TOPIC_AREAS).filter((topic) => !staticHelpTopics().has(topic))).toEqual([]);
  });
});

describe(`guide anchor coverage${area ? ` of the ${area} area` : ''}`, () => {
  test.each([
    ['page', 'pages with no anchor of kind page listing them'],
    ['tab', 'tabs with no anchor of kind tab whose query reveal selects them'],
    ['field', 'settings fields with no anchor of kind field on their page carrying their help'],
    ['help', 'help topics set on a block that no anchor carries as its help'],
    ['nav', 'sidebar destinations whose item carries no data-tour of an anchor of kind nav'],
  ] as const)('rule %s', (rule, message) => {
    expect(uncovered(rule).map(describeItem), message).toEqual([]);
  });

  test('every anchor’s kind is one of GUIDE_ANCHOR_KINDS', () => {
    expect(anchors.filter((anchor) => !GUIDE_ANCHOR_KINDS.includes(anchor.kind)).map(({ id }) => id)).toEqual([]);
  });

  test('every anchor’s help is a key of HELP_TOPICS', () => {
    expect(
      anchors.filter((anchor) => anchor.help !== undefined && !(anchor.help in HELP_TOPICS)).map(({ id }) => id),
    ).toEqual([]);
  });

  test('every exemption names an item its rule reports, once, with a reason', () => {
    const problems = GUIDE_ANCHOR_EXEMPTIONS.flatMap(({ rule, key, reason }, index) => {
      const item = items.find((candidate) => candidate.rule === rule && candidate.key === key);
      if (item && !inArea(item.area)) return [];
      const named = `${rule} ${key}`;
      if (!item) return [`${named}: the rule reports no such item`];
      if (allAnchors.some((anchor) => item.covers(anchor))) return [`${named}: an anchor covers it`];
      if (GUIDE_ANCHOR_EXEMPTIONS.findIndex((other) => `${other.rule} ${other.key}` === named) !== index) {
        return [`${named}: exempted twice`];
      }
      const problem = sentenceProblem(reason);
      return problem ? [`${named}: its reason is not one sentence (${problem})`] : [];
    });
    expect(problems).toEqual([]);
  });
});
