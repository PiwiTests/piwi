import { describe, expect, test } from 'vitest';
import type { GuideAnchor } from '#shared/guide-anchors/index.mjs';
import { boldLabels, escapeGuideHtml, fillGuideText, guideMarkup, plainGuideText } from '../../app/utils/guide/markup';
import { anchorSelector, revealQuery, routeOnPage, stopRoute } from '../../app/utils/guide/stops';

describe('escapeGuideHtml', () => {
  test('escapes every character HTML gives a meaning to', () => {
    expect(escapeGuideHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  test('leaves plain text alone', () => {
    expect(escapeGuideHtml('Next · 3 of 6 — « Visite guidée »')).toBe('Next · 3 of 6 — « Visite guidée »');
  });
});

describe('guideMarkup', () => {
  test('turns each **label** into a <strong>', () => {
    expect(guideMarkup('**Most likely** names the cause, and **Next** is the step.')).toBe(
      '<strong>Most likely</strong> names the cause, and <strong>Next</strong> is the step.',
    );
  });

  test('escapes the text, bold labels included', () => {
    expect(guideMarkup('**A & B** <b>not bold</b>')).toBe('<strong>A &amp; B</strong> &lt;b&gt;not bold&lt;/b&gt;');
    expect(guideMarkup('**<img src=x onerror=alert(1)>**')).toBe('<strong>&lt;img src=x onerror=alert(1)&gt;</strong>');
  });

  test('leaves an unpaired ** as written', () => {
    expect(guideMarkup('2 ** 3')).toBe('2 ** 3');
  });
});

describe('plainGuideText', () => {
  test('drops the bold markers', () => {
    expect(plainGuideText('**Simulate a test run** replays a stream.')).toBe('Simulate a test run replays a stream.');
  });
});

describe('boldLabels', () => {
  test('lists the bold labels in order', () => {
    expect(boldLabels('Pick **Leaky run** in **Simulate a test run**.')).toEqual(['Leaky run', 'Simulate a test run']);
  });

  test('is empty when nothing is bold', () => {
    expect(boldLabels('No label here.')).toEqual([]);
  });
});

describe('fillGuideText', () => {
  test('fills each known placeholder', () => {
    expect(fillGuideText('{count} stops', { count: 6 })).toBe('6 stops');
    expect(fillGuideText('{a} and {a} of {b}', { a: 'x', b: 'y' })).toBe('x and x of y');
  });

  test("leaves unknown placeholders and driver.js's {{current}} / {{total}} as written", () => {
    expect(fillGuideText('{count} {unknown}', { count: 4 })).toBe('4 {unknown}');
    expect(fillGuideText('{{current}} of {{total}}', { count: 4 })).toBe('{{current}} of {{total}}');
  });
});

/** An anchor with only what the stop helpers read. */
function anchor(pages: string[], reveal?: GuideAnchor['reveal']): GuideAnchor {
  return { id: 'some-block', pages, reveal, describes: 'A block.', sample: { route: '/' } };
}

describe('anchorSelector', () => {
  test('names the element by its data-tour attribute', () => {
    expect(anchorSelector('flaky-test-row')).toBe('[data-tour="flaky-test-row"]');
  });
});

describe('revealQuery', () => {
  test('merges the query steps of a reveal, leaving the other steps out', () => {
    expect(revealQuery(anchor(['/projects/[id]'], [{ query: { tab: 'gaps' } }, { unfold: 'x' }]))).toEqual({
      tab: 'gaps',
    });
    expect(revealQuery(anchor(['/'], [{ query: { tab: 'a' } }, { query: { evidence: 'source' } }]))).toEqual({
      tab: 'a',
      evidence: 'source',
    });
  });

  test('is empty without an anchor or a reveal', () => {
    expect(revealQuery(undefined)).toEqual({});
    expect(revealQuery(anchor(['/']))).toEqual({});
  });
});

describe('stopRoute', () => {
  const tabbed = anchor(['/projects/[id]'], [{ query: { tab: 'flaky-tests' } }]);

  test('keeps a route that names every query value of its anchor as written', () => {
    expect(stopRoute('/projects/1?tab=flaky-tests', tabbed)).toBe('/projects/1?tab=flaky-tests');
    expect(stopRoute('/projects/1?tab=performance', tabbed)).toBe('/projects/1?tab=performance');
    expect(stopRoute('/coverage?file=api/Users.cs', anchor(['/coverage']))).toBe('/coverage?file=api/Users.cs');
  });

  test('adds the query values the route leaves out, before its hash', () => {
    expect(stopRoute('/projects/1', tabbed)).toBe('/projects/1?tab=flaky-tests');
    expect(stopRoute('/projects/1?view=list#top', tabbed)).toBe('/projects/1?view=list&tab=flaky-tests#top');
  });

  test('opens the anchor’s main page when it is a fixed path, with its query', () => {
    expect(stopRoute(undefined, anchor(['/settings/notifications']))).toBe('/settings/notifications');
    expect(stopRoute(undefined, anchor(['/analytics', '/analytics/d/[id]'], [{ query: { period: '7d' } }]))).toBe(
      '/analytics?period=7d',
    );
  });

  test('stays on the current page for a page with a parameter, every page, or no anchor', () => {
    expect(stopRoute(undefined, tabbed)).toBeUndefined();
    expect(stopRoute(undefined, anchor(['*']))).toBeUndefined();
    expect(stopRoute(undefined, undefined)).toBeUndefined();
  });

  test('takes the route as written without an anchor', () => {
    expect(stopRoute('/mcp', undefined)).toBe('/mcp');
  });
});

describe('routeOnPage', () => {
  test('matches a fixed page on its path, whatever the query', () => {
    expect(routeOnPage('/', '/')).toBe(true);
    expect(routeOnPage('/?project=1', '/')).toBe(true);
    expect(routeOnPage('/settings/notifications', '/settings/notifications')).toBe(true);
    expect(routeOnPage('/settings/notifications/', '/settings/notifications')).toBe(true);
    expect(routeOnPage('/settings', '/settings/notifications')).toBe(false);
  });

  test('takes a seeded id for each parameter', () => {
    expect(routeOnPage('/projects/1?tab=gaps', '/projects/[id]')).toBe(true);
    expect(routeOnPage('/projects/5/coverage', '/projects/[id]/coverage')).toBe(true);
    expect(routeOnPage('/projects/5/coverage', '/projects/[id]')).toBe(false);
    expect(routeOnPage('/projects/new', '/projects/[id]')).toBe(false);
  });

  test('takes a built-in dashboard key for a dashboard, and no other word', () => {
    expect(routeOnPage('/analytics/d/1', '/analytics/d/[id]')).toBe(true);
    expect(routeOnPage('/analytics/d/engineering', '/analytics/d/[id]')).toBe(true);
    expect(routeOnPage('/analytics/d/gaps-digest?period=7d', '/analytics/d/[id]')).toBe(true);
    expect(routeOnPage('/analytics/d/marketing', '/analytics/d/[id]')).toBe(false);
    expect(routeOnPage('/analytics/d/engineering-2', '/analytics/d/[id]')).toBe(false);
    expect(routeOnPage('/projects/engineering', '/projects/[id]')).toBe(false);
  });

  test('matches every route on every page', () => {
    expect(routeOnPage('/test-runs/14', '*')).toBe(true);
  });
});
