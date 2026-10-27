import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The request being served, shared by the plugin (logs, spans, probes) and the
 * coverage runtime. It lives on a global so both read the same store even when
 * the server bundle holds two copies of this module: the plugin can load from
 * `node_modules` while the coverage runtime is bundled, or the reverse.
 */
const SCOPE_KEY = Symbol.for('piwitests.requestScope');

const globals = globalThis as Record<symbol, unknown>;

export const requestScope = (globals[SCOPE_KEY] ??= new AsyncLocalStorage<object>()) as AsyncLocalStorage<object>;
