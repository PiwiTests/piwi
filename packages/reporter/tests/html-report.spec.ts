import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { htmlReportFolder } from '../src/internal/files/html-report.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-html-report-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the html reporter's folder", () => {
  it('is none when no html reporter runs', () => {
    expect(htmlReportFolder([['list'], ['@piwitests/reporter', {}]], root, {})).toBeNull();
    expect(htmlReportFolder(undefined, root, {})).toBeNull();
  });

  it("is its outputFolder, from the config's folder", () => {
    expect(htmlReportFolder([['html', { outputFolder: 'reports/html' }]], root, {})).toBe(
      path.join(root, 'reports', 'html'),
    );
  });

  it('is PLAYWRIGHT_HTML_OUTPUT_DIR, or PLAYWRIGHT_HTML_REPORT, from the working directory, over the option', () => {
    const reporters = [['html', { outputFolder: 'from-option' }]];
    expect(htmlReportFolder(reporters, root, { PLAYWRIGHT_HTML_OUTPUT_DIR: 'from-env' })).toBe(path.resolve('from-env'));
    expect(htmlReportFolder(reporters, root, { PLAYWRIGHT_HTML_REPORT: 'older-env' })).toBe(path.resolve('older-env'));
  });

  it("is playwright-report beside the nearest package.json at or above the config's folder", () => {
    const e2e = path.join(root, 'e2e');
    fs.mkdirSync(e2e);
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    expect(htmlReportFolder([['html']], e2e, {})).toBe(path.join(root, 'playwright-report'));
  });

  it('counts the html reporter PW_TEST_REPORTER adds', () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    expect(htmlReportFolder([['list']], root, { PW_TEST_REPORTER: 'html' })).toBe(path.join(root, 'playwright-report'));
  });
});
