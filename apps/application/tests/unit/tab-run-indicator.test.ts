import { describe, test, expect } from 'vitest';
import { FAIL_FLASH_MS, PASS_FLASH_MS } from '../../app/utils/desktop-run-progress';
import {
  finishedRunTabIndicator,
  liveRunTabIndicator,
  runFaviconSvg,
  svgDataUrl,
  tabRunTitle,
} from '../../app/utils/tab-run-indicator';

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 512 512"><rect/></svg>';

describe('liveRunTabIndicator', () => {
  test('a run going well is blue, with its share done and the desktop label', () => {
    expect(liveRunTabIndicator({ done: 3, total: 12, failed: 0 })).toEqual({
      status: 'running',
      fraction: 0.25,
      label: 'Running 3/12…',
    });
  });

  test('a failed test turns the badge to the failed color and the label counts it', () => {
    expect(liveRunTabIndicator({ done: 7, total: 12, failed: 2 })).toEqual({
      status: 'failed',
      fraction: 7 / 12,
      label: 'Running 7/12 · 2 failed',
    });
  });

  test('an unknown suite size has no fraction', () => {
    expect(liveRunTabIndicator({ done: 0, total: 0, failed: 0 })).toEqual({
      status: 'running',
      fraction: null,
      label: 'Running…',
    });
  });
});

describe('finishedRunTabIndicator', () => {
  test('a pass shows the passed color for the desktop pass flash', () => {
    expect(finishedRunTabIndicator('passed')).toEqual({
      indicator: { status: 'passed', fraction: null, label: 'Run passed' },
      durationMs: PASS_FLASH_MS,
    });
  });

  test('interrupted and failed runs show the failed color', () => {
    expect(finishedRunTabIndicator('failed')).toEqual({
      indicator: { status: 'failed', fraction: null, label: 'Run failed' },
      durationMs: FAIL_FLASH_MS,
    });
    expect(finishedRunTabIndicator('interrupted')?.indicator).toEqual({
      status: 'failed',
      fraction: null,
      label: 'Run interrupted',
    });
  });

  test('a cancelled run restores the tab at once', () => {
    expect(finishedRunTabIndicator('cancelled')).toBeNull();
  });
});

describe('tabRunTitle', () => {
  test('leads the title with the progress, in the desktop window title format', () => {
    const indicator = liveRunTabIndicator({ done: 3, total: 12, failed: 0 });
    expect(tabRunTitle('Test run #4 — Piwi Dashboard', indicator)).toBe(
      '▶ Running 3/12… · Test run #4 — Piwi Dashboard',
    );
  });

  test('leaves the title alone with no run to show', () => {
    expect(tabRunTitle('Test run #4 — Piwi Dashboard', null)).toBe('Test run #4 — Piwi Dashboard');
  });
});

describe('runFaviconSvg', () => {
  const color = 'oklch(62.3% 0.214 259.815)';

  test('embeds the logo, cut out under the badge', () => {
    const svg = runFaviconSvg(LOGO, liveRunTabIndicator({ done: 3, total: 12, failed: 0 }), color);
    expect(svg).toContain(`href="${svgDataUrl(LOGO)}"`);
    expect(svg).toContain('mask="url(#cut)"');
  });

  test('draws a pie of the share done over a faint track', () => {
    const svg = runFaviconSvg(LOGO, liveRunTabIndicator({ done: 3, total: 12, failed: 0 }), color);
    expect(svg).toContain(`fill="${color}" fill-opacity="0.3"`);
    // A quarter: from 12 o'clock to 3 o'clock, the short arc.
    expect(svg).toMatch(/<path d="M44 44V26A18 18 0 0 1 62\.00 44\.00Z" fill="oklch/);
  });

  test('takes the long arc past half way', () => {
    const svg = runFaviconSvg(LOGO, liveRunTabIndicator({ done: 9, total: 12, failed: 0 }), color);
    expect(svg).toMatch(/A18 18 0 1 1 /);
  });

  test('no wedge before the first test ends', () => {
    const svg = runFaviconSvg(LOGO, liveRunTabIndicator({ done: 0, total: 12, failed: 0 }), color);
    expect(svg).not.toContain('<path');
  });

  test('a full dot with no fraction, a finished run or a done suite', () => {
    const full = `<circle cx="44" cy="44" r="18" fill="${color}"/>`;
    expect(runFaviconSvg(LOGO, liveRunTabIndicator({ done: 0, total: 0, failed: 0 }), color)).toContain(full);
    expect(runFaviconSvg(LOGO, finishedRunTabIndicator('passed')!.indicator, color)).toContain(full);
    expect(runFaviconSvg(LOGO, liveRunTabIndicator({ done: 12, total: 12, failed: 0 }), color)).toContain(full);
  });

  test('rounds the pie to whole percents, so a near-done run is not drawn as done', () => {
    const svg = runFaviconSvg(LOGO, liveRunTabIndicator({ done: 999, total: 1000, failed: 0 }), color);
    expect(svg).toContain('fill-opacity="0.3"');
    expect(svg).toContain('<path');
  });
});

describe('svgDataUrl', () => {
  test('encodes the markup into a data address', () => {
    expect(svgDataUrl('<svg a="#b"/>')).toBe('data:image/svg+xml,%3Csvg%20a%3D%22%23b%22%2F%3E');
  });
});
