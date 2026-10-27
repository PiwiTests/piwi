import { describe, it, expect } from 'vitest';
import { html, joinHtml, raw, toHtmlString } from '../../shared/export/html';

/** Collapse formatter-inserted whitespace so assertions survive `oxfmt`. */
function tight(value: { value: string } | string): string {
  return toHtmlString(value as never)
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .trim();
}

/**
 * The point of the tagged template is that escaping is the default, so a future
 * edit cannot introduce a hole by forgetting a call.
 */
describe('html tagged template', () => {
  it('escapes interpolated values', () => {
    expect(toHtmlString(html`<p>${'<script>alert(1)</script>'}</p>`)).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('escapes values interpolated into an attribute', () => {
    expect(tight(html`<img alt="${'" onerror="alert(1)'}" />`)).toBe('<img alt="&quot; onerror=&quot;alert(1)" />');
  });

  it('passes through only what is explicitly marked raw', () => {
    expect(toHtmlString(html`<div>${raw('<b>ok</b>')}</div>`)).toBe('<div><b>ok</b></div>');
  });

  it('escapes a nested fragment exactly once', () => {
    const inner = html`<p>${'a & b'}</p>`;
    expect(toHtmlString(html`<div>${inner}</div>`)).toBe('<div><p>a &amp; b</p></div>');
  });

  it('renders arrays by concatenating each escaped item', () => {
    expect(
      tight(
        html`<ul>
          ${['a<', 'b>'].map((t) => html`<li>${t}</li>`)}
        </ul>`,
      ),
    ).toBe('<ul><li>a&lt;</li><li>b&gt;</li></ul>');
  });

  it('renders null, undefined and false as nothing', () => {
    expect(toHtmlString(html`<p>${null}${undefined}${false}</p>`)).toBe('<p></p>');
  });

  it('renders the number zero rather than swallowing it', () => {
    expect(toHtmlString(html`<p>${0}</p>`)).toBe('<p>0</p>');
  });

  it('joins fragments and drops blank ones', () => {
    expect(toHtmlString(joinHtml([html`<a></a>`, '', raw('   '), html`<b></b>`], '-'))).toBe('<a></a>-<b></b>');
  });
});
