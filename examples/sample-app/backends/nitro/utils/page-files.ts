import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineEventHandler, setResponseHeader, type H3Event } from 'h3';
import { useRuntimeConfig } from 'nitropack/runtime';

/** Answers with a file of the shared `web/pages` folder, the one nitro.config.ts names. */
export async function servePage(event: H3Event, file: string): Promise<string> {
  setResponseHeader(event, 'Content-Type', 'text/html; charset=utf-8');
  return readFile(join(useRuntimeConfig(event).pages, file), 'utf8');
}

/** The handler of a page's route: it serves the page's file. */
export const page = (file: string) => defineEventHandler((event) => servePage(event, file));
