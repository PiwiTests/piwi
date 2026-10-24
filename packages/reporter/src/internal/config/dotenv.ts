import * as fs from 'node:fs';
import { parseDotEnv } from '@piwitests/core/dotenv';

/**
 * The variables of a `.env` file, read as `@piwitests/core/dotenv` parses it,
 * or an empty record when the file is absent or unreadable. Never throws.
 */
export function readDotEnv(filePath: string): Record<string, string> {
  try {
    return parseDotEnv(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}
