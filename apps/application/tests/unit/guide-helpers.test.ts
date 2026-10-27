import { describe, expect, test } from 'vitest';
import { GUIDE_ANCHOR_BY_ID, type GuideAnchor } from '#shared/guide-anchors/index.mjs';
import { boldLabels, escapeGuideHtml, fillGuideText, guideMarkup, plainGuideText } from '../../app/utils/guide/markup';
import { changedQuery, guidePath, linkMatch, segmentLabel } from '../../app/utils/guide/path';
import { anchorSelector, opensLayer, revealQuery, routeOnPage, stopRoute } from '../../app/utils/guide/stops';

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

describe('opensLayer', () => {
  test('holds for an anchor whose reveal opens what it sits in, after any other step', () => {
    expect(opensLayer(anchor(['/test-runs/[id]'], [{ open: 'run-details' }]))).toBe(true);
    expect(opensLayer(anchor(['/projects/[id]'], [{ query: { tab: 'runs' } }, { open: 'project-markers' }]))).toBe(
      true,
    );
  });

  test('holds for the anchors of the run’s Details popover and the project’s bell', () => {
    for (const id of ['run-retention', 'run-shards', 'project-subscriptions']) {
      expect(opensLayer(GUIDE_ANCHOR_BY_ID.get(id)), id).toBe(true);
    }
  });

  test('does not hold for a tab, a folded section, an anchor with no reveal, or no anchor', () => {
    expect(opensLayer(anchor(['/projects/[id]'], [{ query: { tab: 'gaps' } }]))).toBe(false);
    expect(opensLayer(anchor(['/test-runs/[id]'], [{ unfold: 'run-toolbox' }]))).toBe(false);
    expect(opensLayer(anchor(['/']))).toBe(false);
    expect(opensLayer(undefined)).toBe(false);
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

describe('segmentLabel', () => {
  test('keeps one line of text', () => {
    expect(segmentLabel('  Flaky tests\n  12 ')).toBe('Flaky tests 12');
  });

  test('cuts a long label with an ellipsis', () => {
    const label = segmentLabel('should complete checkout with credit card and a gift voucher');
    expect(label).toHaveLength(40);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('guidePath', () => {
  const seg = (label: string, opened = false) => ({ label, opened });

  test('puts the page’s crumbs first, its last one opened when the guide opened the page', () => {
    expect(guidePath(['Home', 'Projects', 'e2e-checkout'], [seg('Flaky tests', true)], true)).toEqual([
      seg('Projects'),
      seg('e2e-checkout', true),
      seg('Flaky tests', true),
    ]);
    expect(guidePath(['Projects', 'e2e-checkout'], [seg('Flaky tests')], false)).toEqual([
      seg('Projects'),
      seg('e2e-checkout'),
      seg('Flaky tests'),
    ]);
  });

  test('keeps the Home root alone, and drops empty labels and a label repeating the one before', () => {
    expect(guidePath(['Home'], [], false)).toEqual([seg('Home')]);
    expect(guidePath(['Settings', ' '], [seg('Settings'), seg('AI')], false)).toEqual([seg('Settings'), seg('AI')]);
  });

  test('folds the first segments into … past four', () => {
    expect(
      guidePath(['Home', 'Projects', 'e2e-checkout', 'Run #12', 'should pay'], [seg('Source', true)], true).map(
        (s) => s.label,
      ),
    ).toEqual(['…', 'Run #12', 'should pay', 'Source']);
  });
});

describe('linkMatch', () => {
  const at = (path: string) => `http://localhost:3000${path}`;

  test('leads to the route when the path and every query value match', () => {
    expect(linkMatch(at('/projects/1?tab=flaky-tests'), at('/projects/1?tab=flaky-tests'))).toBe('route');
    expect(linkMatch(at('/settings/ai/'), at('/settings/ai'))).toBe('route');
  });

  test('leads to the page when the link names no query value, or only some of them', () => {
    expect(linkMatch(at('/projects/1'), at('/projects/1?tab=flaky-tests'))).toBe('page');
    expect(linkMatch(at('/projects/1?tab=runs'), at('/projects/1?tab=runs&page=2'))).toBe('page');
  });

  test('leads elsewhere with another path, another value, or another origin', () => {
    expect(linkMatch(at('/projects/2'), at('/projects/1'))).toBeNull();
    expect(linkMatch(at('/projects/1?tab=runs'), at('/projects/1?tab=flaky-tests'))).toBeNull();
    expect(linkMatch('https://docs.example.com/projects/1', at('/projects/1'))).toBeNull();
  });
});

describe('changedQuery', () => {
  test('lists the values the move selects', () => {
    expect(changedQuery('/projects/1?tab=runs', '/projects/1?tab=flaky-tests')).toEqual([['tab', 'flaky-tests']]);
    expect(changedQuery('/projects/1?tab=runs&q=x', '/projects/1?tab=runs&q=x')).toEqual([]);
  });

  test('lists every value of a page the guide opens', () => {
    expect(changedQuery(null, '/test-run-cases/711?evidence=source')).toEqual([['evidence', 'source']]);
  });
});
