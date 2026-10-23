import * as path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  chooseProjectNode,
  nodeMajor,
  pathNode,
  projectNode,
  projectNodeEnv,
  type NodeLookup,
} from '../src/recorder/node';

const ELECTRON = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';

function lookup(overrides: Partial<NodeLookup>): NodeLookup {
  return {
    electron: true,
    execPath: ELECTRON,
    platform: 'linux',
    pathVariable: '/usr/local/bin:/usr/bin',
    run: () => 'v22.11.0\n',
    isFile: (file) => file === '/usr/bin/node',
    ...overrides,
  };
}

describe('nodeMajor', () => {
  test('reads the major of `node --version`', () => {
    expect(nodeMajor('v22.11.0\n')).toBe(22);
    expect(nodeMajor('v18.20.4')).toBe(18);
    expect(nodeMajor('')).toBeNull();
    expect(nodeMajor('node: command not found')).toBeNull();
  });
});

describe('pathNode', () => {
  test('the first node of the PATH, checked once with --version', () => {
    const run = vi.fn(() => 'v20.0.0');
    const isFile = vi.fn((file: string) => file === '/usr/bin/node' || file === '/opt/node/bin/node');
    expect(pathNode(lookup({ pathVariable: 'bin:/usr/local/bin:/usr/bin:/opt/node/bin', run, isFile }))).toBe(
      '/usr/bin/node',
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/usr/bin/node', ['--version']);
    expect(isFile).not.toHaveBeenCalledWith(path.posix.join('bin', 'node'));
  });

  test('none when the first node is older than 20, does not run or there is none', () => {
    const isFile = (file: string) => file === '/usr/bin/node' || file === '/opt/node/bin/node';
    const pathVariable = '/usr/bin:/opt/node/bin';
    expect(pathNode(lookup({ pathVariable, isFile, run: () => 'v18.20.4\n' }))).toBeNull();
    expect(pathNode(lookup({ pathVariable, isFile, run: () => null }))).toBeNull();
    expect(pathNode(lookup({ pathVariable: '/usr/local/bin' }))).toBeNull();
    expect(pathNode(lookup({ pathVariable: undefined }))).toBeNull();
  });

  test('node.exe in the folders of a Windows PATH, quoted or not', () => {
    const isFile = (file: string) => file === 'C:\\Program Files\\nodejs\\node.exe';
    expect(
      pathNode(
        lookup({ platform: 'win32', pathVariable: 'C:\\Windows;"C:\\Program Files\\nodejs";C:\\Tools', isFile }),
      ),
    ).toBe('C:\\Program Files\\nodejs\\node.exe');
  });
});

describe('chooseProjectNode', () => {
  test('under Electron, the PATH’s Node', () => {
    expect(chooseProjectNode(lookup({}))).toEqual({ execPath: '/usr/bin/node', runAsNode: false });
  });

  test('under Electron without a Node on the PATH, the Electron, as Node', () => {
    expect(chooseProjectNode(lookup({ run: () => 'v16.0.0' }))).toEqual({ execPath: ELECTRON, runAsNode: true });
  });

  test('under Node, the service’s own runtime, without looking at the PATH', () => {
    const run = vi.fn(() => 'v22.0.0');
    expect(chooseProjectNode(lookup({ electron: false, execPath: '/usr/bin/node20', run }))).toEqual({
      execPath: '/usr/bin/node20',
      runAsNode: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('the service’s Node in these tests, looked up once', () => {
    expect(projectNode()).toEqual({ execPath: process.execPath, runAsNode: false });
    expect(projectNode()).toBe(projectNode());
  });
});

describe('projectNodeEnv', () => {
  test('ELECTRON_RUN_AS_NODE for an Electron only', () => {
    const base = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', FORCE_COLOR: '0' };
    expect(projectNodeEnv({ execPath: '/usr/bin/node', runAsNode: false }, base)).toEqual({
      PATH: '/usr/bin',
      FORCE_COLOR: '0',
    });
    expect(projectNodeEnv({ execPath: ELECTRON, runAsNode: true }, { PATH: '/usr/bin' })).toEqual({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(base.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
