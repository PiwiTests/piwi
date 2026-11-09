import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { richCopyLink, trackedIssueHtml } from '../../app/utils/rich-copy-html';

describe('richCopyLink', () => {
  test('links an http(s) URL, escaped in the attribute and the text', () => {
    expect(richCopyLink('https://jira.example.com/browse/QA-1?a=1&b="2"', 'QA-1 <b>')).toBe(
      '<a href="https://jira.example.com/browse/QA-1?a=1&amp;b=&quot;2&quot;">QA-1 &lt;b&gt;</a>',
    );
    expect(richCopyLink("http://x.example/'quoted'", 'x')).toBe('<a href="http://x.example/&#39;quoted&#39;">x</a>');
  });

  test('renders the text alone for any other URL', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '/relative', '', null]) {
      expect(richCopyLink(href, 'QA-1 & co')).toBe('QA-1 &amp; co');
    }
  });
});

describe('trackedIssueHtml', () => {
  test('escapes the key and the status, and links only an http(s) URL', () => {
    expect(trackedIssueHtml({ key: 'QA-1', url: 'https://t.example/QA-1', status: 'In <Progress>' })).toBe(
      '<p>Tracked in <a href="https://t.example/QA-1">QA-1</a> (In &lt;Progress&gt;)</p>',
    );
    expect(trackedIssueHtml({ key: '"QA-2"', url: 'javascript:void(0)', status: null })).toBe(
      '<p>Tracked in &quot;QA-2&quot;</p>',
    );
  });

  test('keeps a quote in the URL inside the attribute', () => {
    const html = trackedIssueHtml({ key: 'QA-3', url: 'https://t.example/" onclick="x', status: null });
    expect(html).toBe('<p>Tracked in <a href="https://t.example/&quot; onclick=&quot;x">QA-3</a></p>');
  });
});

describe('copied HTML in the app', () => {
  test('every page that copies rich HTML builds its links with richCopyLink', () => {
    const pagesDir = join(__dirname, '../../app/pages');
    const files = readdirSync(pagesDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.vue'));
    const copying = files.filter((f) => readFileSync(join(pagesDir, f), 'utf8').includes('copyRich('));
    expect(copying.length).toBeGreaterThan(0);
    for (const file of copying) {
      const rawLinks = readFileSync(join(pagesDir, file), 'utf8')
        .split('\n')
        .filter((line) => line.includes('<a href="${'));
      expect(rawLinks, file).toEqual([]);
    }
  });
});
