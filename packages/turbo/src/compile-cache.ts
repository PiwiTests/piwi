import module from 'node:module';
import { resolve } from 'node:path';

/**
 * Turns on Node's compile cache in `directory` for this process from here on, and for the Node processes it starts,
 * through `NODE_COMPILE_CACHE`. Skipped when coverage is collected or a compile cache is already set or disabled.
 */
export function enableCompileCache(directory: string): void {
  if (process.env.NODE_COMPILE_CACHE || process.env.NODE_DISABLE_COMPILE_CACHE || process.env.NODE_V8_COVERAGE) return;
  const path = resolve(directory);
  module.enableCompileCache?.(path);
  process.env.NODE_COMPILE_CACHE = path;
}
