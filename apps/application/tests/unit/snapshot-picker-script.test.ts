import { describe, test, expect } from 'vitest';
import {
  deriveHighlightHints,
  stripNetworkReferences,
  snapshotPickerScriptTag,
  buildPickerDocument,
  buildReadonlyDocument,
} from '../../app/utils/snapshot-picker-script';
import type { RankedLocator } from '#shared/locator-healing.types';

const ranked = (args: Record<string, unknown>): RankedLocator => ({
  locator: 'x',
  method: 'getByRole',
  args,
  score: 50,
});

describe('deriveHighlightHints', () => {
  test('takes the failing name first, then element-match, then ARIA candidates, deduped', () => {
    const hints = deriveHighlightHints({
      failingLocator: { method: 'getByRole', args: { role: 'button', name: 'Pay now' } },
      fromElementMatch: [ranked({ role: 'button', name: 'Pay now' }), ranked({ text: 'Checkout' })],
      fromAriaSnapshot: [ranked({ name: 'Submit' })],
    });
    expect(hints.map((h) => h.text)).toEqual(['Pay now', 'Checkout', 'Submit']);
  });

  test('reads text/label/placeholder/alt/title, skips too-short/too-long, caps at 6', () => {
    expect(deriveHighlightHints({ failingLocator: { method: 'getByText', args: { text: 'Open' } } })[0]!.text).toBe(
      'Open',
    );
    expect(deriveHighlightHints({ failingLocator: { method: 'getByLabel', args: { label: 'Email' } } })[0]!.text).toBe(
      'Email',
    );
    // 1-char and >80-char names are ignored
    expect(deriveHighlightHints({ failingLocator: { method: 'getByText', args: { text: 'x' } } })).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => ranked({ name: `Item ${i}` }));
    expect(deriveHighlightHints({ fromElementMatch: many })).toHaveLength(6);
  });

  test('returns nothing when there are no named candidates', () => {
    expect(deriveHighlightHints({ failingLocator: { method: 'locator', args: { selector: '.x' } } })).toEqual([]);
    expect(deriveHighlightHints({})).toEqual([]);
  });
});

describe('stripNetworkReferences', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  test('removes <base>, every leftover <link> and <meta http-equiv>', () => {
    expect(stripNetworkReferences('<head><base href="https://tested.app/"><title>x</title></head>')).toBe(
      '<head><title>x</title></head>',
    );
    expect(stripNetworkReferences('<BASE target="_blank">keep')).toBe('keep');
    expect(
      stripNetworkReferences(
        '<head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/login">' +
          '<link rel="stylesheet" crossorigin="" href="/dist/assets/index.css"><link rel="icon" href="/favicon.ico"></head>',
      ),
    ).toBe('<head><meta charset="utf-8"></head>');
    expect(stripNetworkReferences('<p>no references here</p>')).toBe('<p>no references here</p>');
  });

  test('empties nested frames, plugins and script sources', () => {
    expect(stripNetworkReferences('<iframe src="/snapshot/frame@x" title="Map"></iframe>')).toBe(
      '<iframe  title="Map"></iframe>',
    );
    expect(stripNetworkReferences('<iframe srcdoc="<p>hi</p>"></iframe>')).toBe('<iframe ></iframe>');
    expect(stripNetworkReferences('<object data="/doc.pdf"></object><embed src="/a.swf">')).toBe(
      '<object ></object><embed >',
    );
    expect(stripNetworkReferences(`<script src="${PNG}"></script>`)).toBe('<script ></script>');
  });

  test('keeps data: media, drops media that would fetch — a masked data: URI is malformed', () => {
    const out = stripNetworkReferences(
      `<img class="logo" src="/dist/assets/logo.png" alt="Logo"><img src="${PNG}" alt="inline">` +
        '<img src="data:[masked]" alt="QR"><img srcset="/a.png 1x, /b.png 2x" src="https://cdn.example/a.png">' +
        '<video poster="/p.jpg"><source src="/v.mp4"></video><table background="/bg.gif"></table>',
    );
    expect(out).toBe(
      `<img class="logo"  alt="Logo"><img src="${PNG}" alt="inline">` +
        '<img  alt="QR"><img  >' +
        '<video ><source ></video><table ></table>',
    );
  });

  test('keeps in-document and link references, drops external SVG references', () => {
    const out = stripNetworkReferences(
      '<svg><use href="#icon"/><use xlink:href="/sprite.svg#icon"/><image href="/i.png"/>' +
        '<a href="/next">n</a></svg><a href="/logout">Déconnexion</a><map><area href="/x"></map>',
    );
    expect(out).toBe(
      '<svg><use href="#icon"/><use /><image /><a href="/next">n</a></svg>' +
        '<a href="/logout">Déconnexion</a><map><area href="/x"></map>',
    );
  });

  test('rewrites CSS that would fetch — in <style> bodies and style attributes — keeping inline refs', () => {
    const out = stripNetworkReferences(
      '<style media="screen">@import url("/theme.css"); @import \'/print.css\' print;' +
        `.a{background:url(/bg.png)}.b{background:url("${PNG}")}.c{filter:url(#blur)}` +
        '.d::after{content:"<img src=/x.png>"}</style>' +
        '<div style="background-image:url(&quot;/hero.jpg&quot;);color:red">x</div>' +
        `<div style="background:url(&quot;${PNG}&quot;)">y</div>`,
    );
    expect(out).toBe(
      '<style media="screen"> ' +
        `.a{background:none}.b{background:url("${PNG}")}.c{filter:url(#blur)}` +
        '.d::after{content:"<img src=/x.png>"}</style>' +
        '<div style="background-image:none;color:red">x</div>' +
        `<div style="background:url(&quot;${PNG}&quot;)">y</div>`,
    );
  });

  test('a quoted ">" never ends a tag, and a truncated <style> at the end is still CSS', () => {
    expect(stripNetworkReferences('<img alt="a > b" src="/x.png"><p>ok</p>')).toBe('<img alt="a > b" ><p>ok</p>');
    expect(stripNetworkReferences('<p>x</p><style>.a{background:url(/bg.png)}')).toBe(
      '<p>x</p><style>.a{background:none}',
    );
  });
});

describe('snapshotPickerScriptTag / buildPickerDocument', () => {
  test('produces a runnable script tag carrying the config', () => {
    const tag = snapshotPickerScriptTag({ probedAttrs: ['id', 'data-testid'] });
    expect(tag.startsWith('<script>')).toBe(true);
    expect(tag.endsWith('</script>')).toBe(true);
    // The probe is installed on a well-known global for the shared core
    // overlay (postMessage transport) to find, ahead of the overlay itself.
    expect(tag).toContain('globalThis.__piwiProbe');
    expect(tag).toContain('"transport":"postMessage"');
    expect(tag).toContain('["id","data-testid"]');
  });

  test('the serialized function body never closes the script tag early', () => {
    const tag = snapshotPickerScriptTag({ probedAttrs: [] });
    // Exactly one closing tag — the real one at the end.
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
  });

  test('wraps init so a startup failure is reported to the host instead of hanging', () => {
    const tag = snapshotPickerScriptTag({ probedAttrs: [] });
    // Init runs in a try/catch behind error listeners that post `piwiError` to
    // the host, so a throw during setup shows an error rather than an endless
    // "Initializing…" spinner.
    expect(tag).toContain("type:'piwiError'");
    expect(tag).toContain('try{');
    expect(tag).toContain('addEventListener');
    // The wrapping must not introduce a second closing tag.
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
  });

  test('the serialized picker swallows page interaction and re-arms the block after a pick', () => {
    const tag = snapshotPickerScriptTag({ probedAttrs: [] });
    // A representative slice of the events a dead snapshot must ignore so a
    // click never navigates a link, submits a form, or activates a control.
    for (const evt of ['submit', 'contextmenu', 'auxclick', 'dragstart', 'keypress', 'touchstart']) {
      expect(tag).toContain(evt);
    }
    // The iframe stays inert through the review step (a pick doesn't re-enable it).
    expect(tag).toContain('Analyzing element');
  });

  test('buildPickerDocument strips network references and appends the script after the HTML', () => {
    const doc = buildPickerDocument(
      '<body><base href="http://x/"><link rel="modulepreload" href="/a.js"><button>Go</button></body>',
      { probedAttrs: [] },
    );
    expect(doc).not.toContain('<base');
    expect(doc).not.toContain('<link');
    expect(doc.indexOf('<button>Go</button>')).toBeLessThan(doc.indexOf('<script>'));
  });

  test('puts the recorded page state back before anything installs over it', () => {
    const tag = snapshotPickerScriptTag({ probedAttrs: [] });
    expect(tag).toContain('data-piwi-modal');
    expect(tag.indexOf('data-piwi-modal')).toBeLessThan(tag.indexOf('globalThis.__piwiProbe'));
    const doc = buildReadonlyDocument('<p>x</p>');
    expect(doc).toContain('data-piwi-scroll-top');
    expect(doc.indexOf('data-piwi-scroll-top')).toBeLessThan(doc.indexOf('.closest('));
    expect(doc.match(/<\/script>/g)).toHaveLength(1);
  });

  test('marks the appended script with the CSP nonce when one is given', () => {
    expect(snapshotPickerScriptTag({ probedAttrs: [] }, 'n0nce').startsWith('<script nonce="n0nce">')).toBe(true);
    expect(buildPickerDocument('<p>x</p>', { probedAttrs: [] }, 'n0nce')).toContain('<script nonce="n0nce">');
    expect(buildReadonlyDocument('<p>x</p>', 'n0nce')).toContain('<script nonce="n0nce">');
    expect(buildReadonlyDocument('<link href="/a.css"><p>x</p>')).toMatch(/^<p>x<\/p><script>/);
  });
});
