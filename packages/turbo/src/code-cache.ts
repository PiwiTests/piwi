// Loaded with `--require` by `piwi-turbo` and the Node processes it starts: compiles Playwright's own modules with a
// V8 code cache written as the process exits, so a cache holds the functions compiled while the process ran as well as
// the top-level code. One cache file per module and per role (the runner and its command, a worker, a loader).
import Module from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import vm from 'node:vm';
import { CODE_CACHE_DIR, DISCARD_CODE_CACHE, RUNNER_PID } from './startup-env';

const PLAYWRIGHT_MODULE = /[\\/]node_modules[\\/](playwright|playwright-core|@playwright[\\/]test)[\\/]/;

interface ModuleInternals {
  exports: unknown;
  require(id: string): unknown;
  _compile(content: string, filename: string): unknown;
}

interface ModuleStatics {
  prototype: ModuleInternals;
  wrap(content: string): string;
  _resolveFilename(request: string, parent: ModuleInternals, isMain: boolean, options?: unknown): string;
  _resolveLookupPaths(request: string, parent: ModuleInternals): string[] | null;
  _extensions: unknown;
  _cache: unknown;
}

/** Whether `filename` is one of Playwright's modules this hook compiles. */
export function isCachedModule(filename: string, content: string): boolean {
  return PLAYWRIGHT_MODULE.test(filename) && filename.endsWith('.js') && !content.startsWith('#!');
}

/** The cache file name of a module: its path, size and modification time, and the process's role. */
export function cacheKey(filename: string, size: number, mtimeMs: number, role: string): string {
  return createHash('sha1').update([filename, size, mtimeMs, role].join('\0')).digest('hex');
}

function role(): string {
  if (process.env[RUNNER_PID] === String(process.pid)) return `runner ${process.argv[2] ?? ''}`;
  return basename(process.argv[1] ?? '');
}

/** The `require` a module's code receives, built as Node builds it. */
function makeRequire(statics: ModuleStatics, parent: ModuleInternals) {
  return Object.assign((id: string) => parent.require(id), {
    resolve: Object.assign(
      (request: string, options?: unknown) => statics._resolveFilename(request, parent, false, options),
      { paths: (request: string) => statics._resolveLookupPaths(request, parent) },
    ),
    main: process.mainModule,
    extensions: statics._extensions,
    cache: statics._cache,
  });
}

/**
 * Node warns once per process that `USE_MAIN_CONTEXT_DEFAULT_LOADER` is experimental, as the first `import()` of code
 * compiled with it runs. One such `import()` here, with that warning filtered out, so a run prints what
 * `playwright test` prints.
 */
function takeLoaderWarning(): void {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (
      String(typeof warning === 'string' ? warning : warning.message).startsWith('vm.USE_MAIN_CONTEXT_DEFAULT_LOADER')
    )
      return;
    return Reflect.apply(emitWarning, this, [warning, ...rest]);
  } as typeof process.emitWarning;
  try {
    new vm.Script('import("node:path").catch(() => {})', {
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }).runInThisContext();
  } finally {
    process.emitWarning = emitWarning;
  }
}

function install(directory: string): void {
  takeLoaderWarning();
  const statics = Module as unknown as ModuleStatics;
  const compile = statics.prototype._compile;
  const written: Array<{ script: vm.Script; file: string }> = [];
  let processRole: string | undefined;

  statics.prototype._compile = function (this: ModuleInternals, content: string, filename: string) {
    if (!isCachedModule(filename, content)) return compile.call(this, content, filename);
    const { size, mtimeMs } = statSync(filename);
    processRole ??= role();
    const file = join(directory, `${cacheKey(filename, size, mtimeMs, processRole)}.bin`);
    let cachedData: Buffer | undefined;
    try {
      cachedData = readFileSync(file);
    } catch {}
    const script = new vm.Script(statics.wrap(content), {
      filename,
      cachedData,
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    if (!cachedData || script.cachedDataRejected) written.push({ script, file });
    const wrapper = script.runInThisContext({ displayErrors: true }) as (...args: unknown[]) => unknown;
    return wrapper.call(this.exports, this.exports, makeRequire(statics, this), this, filename, dirname(filename));
  };

  process.on('exit', () => {
    if ((globalThis as { [DISCARD_CODE_CACHE]?: boolean })[DISCARD_CODE_CACHE]) return;
    for (const { script, file } of written) {
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(temporary, script.createCachedData());
        renameSync(temporary, file);
      } catch {
        rmSync(temporary, { force: true });
      }
    }
  });
}

const directory = process.env[CODE_CACHE_DIR];
const installed = Symbol.for('piwi-turbo.code-cache');
const globals = globalThis as { [installed]?: boolean };
if (directory && !process.env.NODE_V8_COVERAGE && !globals[installed]) {
  globals[installed] = true;
  install(directory);
}
