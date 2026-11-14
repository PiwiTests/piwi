import { describe, expect, test } from 'vitest';
import {
  PROJECT_COVERAGE_VIEWS,
  PROJECT_FAILURE_VIEWS,
  PROJECT_MENU_PAGES,
  PROJECT_TABS,
  RUN_TABS,
  type ProjectTabValue,
} from '#shared/app-places';
import type { CapabilityId } from '#shared/capabilities';
import { projectTabHidden } from '../../app/utils/project-tabs';
import { SETUP_CAPABILITIES } from '../../app/utils/setup-capabilities';

/** The tabs a project shows when it hides `hidden`. */
function shownTabs(hidden: CapabilityId[]): ProjectTabValue[] {
  return PROJECT_TABS.filter((tab) => !projectTabHidden(tab.value, (id) => hidden.includes(id))).map(
    (tab) => tab.value,
  );
}

describe('the places registry', () => {
  const lists = {
    PROJECT_TABS,
    RUN_TABS,
    PROJECT_FAILURE_VIEWS,
    PROJECT_COVERAGE_VIEWS,
    PROJECT_MENU_PAGES: PROJECT_MENU_PAGES.map((page) => ({ value: page.path, label: page.label })),
  };

  test.each(Object.entries(lists))('%s names each place once', (_name, places) => {
    const values = places.map((place) => place.value);
    const labels = places.map((place) => place.label);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('every icon is a full name, which the client bundle needs to hold it', () => {
    for (const place of [...PROJECT_TABS, ...RUN_TABS, ...PROJECT_MENU_PAGES]) {
      expect(place.icon).toMatch(/^i-lucide-[a-z0-9-]+$/);
    }
  });

  test('a tab lists the views of its switch', () => {
    const views = Object.fromEntries(
      PROJECT_TABS.map((tab) => [tab.value, 'views' in tab ? tab.views.map((view) => view.label) : null]),
    );
    expect(views.failures).toEqual(['Clusters', 'Flaky', 'Quarantine']);
    expect(views.coverage).toEqual(['Gaps', 'Map', 'Code']);
  });
});

describe('projectTabHidden', () => {
  test('a project that declined nothing shows every tab', () => {
    expect(shownTabs([])).toEqual(PROJECT_TABS.map((tab) => tab.value));
  });

  test('the Flake Lab tab follows its capability', () => {
    expect(shownTabs(['flake-lab'])).not.toContain('flake-lab');
  });

  test('the Coverage tab stays while the Test Map or coverage is on', () => {
    expect(shownTabs(['test-map'])).toContain('coverage');
    expect(shownTabs(['coverage'])).toContain('coverage');
    expect(shownTabs(['test-map', 'coverage'])).not.toContain('coverage');
  });

  test('no other capability hides a tab', () => {
    expect(shownTabs(['quarantine', 'markers', 'bug-reports', 'quality-reports'])).toHaveLength(PROJECT_TABS.length);
  });
});

describe('the capability copy', () => {
  test('a project tab it names is a tab of the project page', () => {
    const labels: string[] = PROJECT_TABS.map((tab) => tab.label);
    const named = SETUP_CAPABILITIES.flatMap((capability) =>
      [...capability.how.matchAll(/project['’]s ([A-Z][A-Za-z ]*?) tab\b/g)].map((match) => match[1]!),
    );
    expect(named.length).toBeGreaterThan(0);
    for (const label of named) expect(labels, `no project tab is labeled "${label}"`).toContain(label);
  });
});
