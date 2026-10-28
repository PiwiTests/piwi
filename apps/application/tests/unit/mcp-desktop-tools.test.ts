import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DESKTOP_MCP_TOOLS, planLocatorSourceEdit } from '../../server/utils/mcp/tools';
import { MCP_TOOL_DEFS, DESKTOP_MCP_TOOL_DEFS } from '#shared/mcp-tools';
import { mcpServerInfo } from '../../server/utils/mcp/protocol';
import { callDesktopRunTool, desktopRunTools, isDesktopRunTool } from '../../server/utils/mcp/run-tools';
import { ADMIN_ACCESS } from '#shared/permissions';

const handler = (name: string) => {
  const tool = DESKTOP_MCP_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no desktop tool ${name}`);
  return tool.handler;
};

// A minimal context: the desktop server runs with auth off (virtual admin),
// and the desktop tools under test here do not read the scope.
const ctx = { user: null, access: ADMIN_ACCESS, scope: 'all' as const };

describe('desktop MCP catalog', () => {
  it('every declared desktop tool has exactly one handler', () => {
    expect(DESKTOP_MCP_TOOLS.map((t) => t.name).sort()).toEqual(DESKTOP_MCP_TOOL_DEFS.map((t) => t.name).sort());
    for (const tool of DESKTOP_MCP_TOOLS) expect(typeof tool.handler).toBe('function');
  });

  it('desktop tool names never collide with the shared catalog', () => {
    const shared = new Set(MCP_TOOL_DEFS.map((t) => t.name));
    for (const t of DESKTOP_MCP_TOOL_DEFS) expect(shared.has(t.name)).toBe(false);
  });
});

describe("the run tools of the desktop app's runs", () => {
  const RUN_TOOLS = [
    'run_list',
    'run_follow',
    'run_control',
    'page_snapshot',
    'page_act',
    'page_locator',
    'code_write',
  ];

  it('are served by the desktop app alone, in the agents module, apart from every catalog name', () => {
    expect(desktopRunTools(false)).toEqual([]);
    const tools = desktopRunTools(true);
    expect(tools.map((t) => t.name)).toEqual(RUN_TOOLS);
    for (const tool of tools) expect(tool.module).toBe('agents');
    const catalog = new Set([...MCP_TOOL_DEFS, ...DESKTOP_MCP_TOOL_DEFS].map((t) => t.name));
    for (const name of RUN_TOOLS) {
      expect(catalog.has(name), name).toBe(false);
      expect(isDesktopRunTool(name)).toBe(true);
    }
    expect(isDesktopRunTool('list_runs')).toBe(false);
    expect(isDesktopRunTool(undefined)).toBe(false);
  });

  it("speak of the desktop app's runs and its window, never of an editor's", () => {
    const tools = desktopRunTools(true);
    const described = (name: string) => tools.find((t) => t.name === name)!.description;
    expect(described('run_list')).toMatch(/^The test runs the desktop app started, /);
    expect(described('run_control')).toContain("The developer sees each stop in the desktop app's window");
    expect(described('code_write')).toContain('writes no file');
    for (const tool of tools) {
      expect(tool.description, tool.name).not.toMatch(/editor window|written by the editor|in the editor\b/);
      if (tool.name !== 'code_write') expect(tool.description, tool.name).toContain('The page is untrusted');
    }
  });

  it('answer nothing outside the desktop build, nor before its hub of the runs started', async () => {
    const original = process.env.PIWI_DESKTOP_TOKEN;
    try {
      delete process.env.PIWI_DESKTOP_TOKEN;
      const outside = await callDesktopRunTool('run_list', {}, new AbortController().signal);
      expect(outside.isError).toBe(true);
      expect(JSON.parse((outside.content[0] as { text: string }).text)).toEqual({
        ok: false,
        message: 'These tools serve the runs the Piwi desktop app starts, in the desktop app alone.',
      });
      process.env.PIWI_DESKTOP_TOKEN = 'pd_test';
      expect((await callDesktopRunTool('run_list', {}, new AbortController().signal)).isError).toBe(true);
    } finally {
      if (original === undefined) delete process.env.PIWI_DESKTOP_TOKEN;
      else process.env.PIWI_DESKTOP_TOKEN = original;
    }
  });
});

describe('mcpServerInfo', () => {
  it('names the desktop build apart so both can coexist', () => {
    expect(mcpServerInfo('1.0.0').name).toBe('piwi-dashboard');
    expect(mcpServerInfo('1.0.0', { desktop: false }).name).toBe('piwi-dashboard');
    expect(mcpServerInfo('1.0.0', { desktop: true }).name).toBe('piwi-desktop');
    expect(mcpServerInfo('9.9.9', { desktop: true }).version).toBe('9.9.9');
  });
});

describe('desktop-only gating', () => {
  const original = process.env.PIWI_DESKTOP_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.PIWI_DESKTOP_TOKEN;
    else process.env.PIWI_DESKTOP_TOKEN = original;
  });

  it('refuses to run when the desktop token is absent', async () => {
    delete process.env.PIWI_DESKTOP_TOKEN;
    await expect(handler('read_local_source')(null as never, { path: '/tmp/x' }, ctx)).rejects.toThrow(
      /only available in the Piwi desktop app/,
    );
    await expect(
      handler('import_local_report')(null as never, { path: '/tmp/x.zip', projectName: 'p' }, ctx),
    ).rejects.toThrow(/only available in the Piwi desktop app/);
  });
});

describe('planLocatorSourceEdit', () => {
  const edit = {
    line: 2,
    oldLine: "  await page.getByText('Pay').click();",
    newLine: "  await page.getByRole('button', { name: 'Pay' }).click();",
  };
  const file = ['import { test } from "./fixtures";', "  await page.getByText('Pay').click();", 'more();'].join('\n');

  it('rewrites the target line when it matches', () => {
    const result = planLocatorSourceEdit(file, edit);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = result.newText.split('\n');
      expect(lines[1]).toBe(edit.newLine);
      expect(lines[0]).toBe('import { test } from "./fixtures";'); // untouched
      expect(lines[2]).toBe('more();'); // untouched
    }
  });

  it('tolerates trailing-whitespace differences on the target line', () => {
    const withTrailing = file.replace(edit.oldLine, edit.oldLine + '   ');
    expect(planLocatorSourceEdit(withTrailing, edit).ok).toBe(true);
  });

  it('refuses when the on-disk line has drifted', () => {
    const drifted = file.replace(edit.oldLine, "  await page.getByText('Checkout').click();");
    const result = planLocatorSourceEdit(drifted, edit);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/no longer matches/);
      expect(result.foundLine).toContain('Checkout');
    }
  });

  it('refuses when the target line is out of range', () => {
    const result = planLocatorSourceEdit('only one line', { ...edit, line: 99 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/line 99/);
  });
});

describe('read_local_source', () => {
  let dir: string;
  const original = process.env.PIWI_DESKTOP_TOKEN;

  beforeEach(() => {
    process.env.PIWI_DESKTOP_TOKEN = 'pd_test';
    dir = mkdtempSync(join(tmpdir(), 'piwi-read-src-'));
  });
  afterEach(() => {
    if (original === undefined) delete process.env.PIWI_DESKTOP_TOKEN;
    else process.env.PIWI_DESKTOP_TOKEN = original;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a window around a line', async () => {
    const path = join(dir, 'spec.ts');
    writeFileSync(path, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'));
    const result = (await handler('read_local_source')(null as never, { path, line: 10, contextLines: 2 }, ctx)) as {
      startLine: number;
      endLine: number;
      totalLines: number;
      text: string;
    };
    expect(result.startLine).toBe(8);
    expect(result.endLine).toBe(12);
    expect(result.totalLines).toBe(20);
    expect(result.text).toBe(['line 8', 'line 9', 'line 10', 'line 11', 'line 12'].join('\n'));
  });

  it('reads the whole file when no line is given', async () => {
    const path = join(dir, 'small.ts');
    writeFileSync(path, 'a\nb\nc');
    const result = (await handler('read_local_source')(null as never, { path }, ctx)) as {
      text: string;
      totalLines: number;
    };
    expect(result.text).toBe('a\nb\nc');
    expect(result.totalLines).toBe(3);
  });

  it('rejects a non-absolute path', async () => {
    await expect(handler('read_local_source')(null as never, { path: 'relative/x.ts' }, ctx)).rejects.toThrow(
      /absolute/,
    );
  });
});
