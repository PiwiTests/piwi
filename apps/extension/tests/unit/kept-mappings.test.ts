import { beforeEach, describe, expect, it } from 'vitest';
import {
  KEPT_MAPPINGS_KEY,
  dropKeptMappings,
  keepMappings,
  keptFor,
  readKeptMappings,
} from '../../src/options/kept-mappings';
import { memoryLocalStorage } from './memory-secret-area';

const INSTANCE = 'https://piwi.example.com';
const LINES = [
  { urlPattern: 'https://staging.shop.test/**', projectId: 1, projectLabel: 'Shop', branch: 'develop' },
  { urlPattern: 'https://admin.shop.test/**', projectId: 2, projectLabel: 'Admin' },
];

let local: ReturnType<typeof memoryLocalStorage>;

beforeEach(() => {
  local = memoryLocalStorage();
  (globalThis as any).chrome = { storage: { local: local.local } };
});

describe('the lines of this browser across Disconnect', () => {
  it('come back for the same instance, whatever path its address takes', async () => {
    expect(await keepMappings(`${INSTANCE}/`, LINES)).toBe(2);
    expect(local.store[KEPT_MAPPINGS_KEY]).toEqual({ origin: INSTANCE, projectMappings: LINES });
    expect(await readKeptMappings(`${INSTANCE}/dashboard`)).toEqual(LINES);
    // Given back once, as the connection is kept.
    await dropKeptMappings();
    expect(local.store[KEPT_MAPPINGS_KEY]).toBeUndefined();
    expect(await readKeptMappings(INSTANCE)).toEqual([]);
  });

  it('stay while a connection is made and dropped before it is kept', async () => {
    await keepMappings(INSTANCE, LINES);
    expect(await readKeptMappings(INSTANCE)).toEqual(LINES);
    expect(await readKeptMappings(INSTANCE)).toEqual(LINES);
    expect(local.store[KEPT_MAPPINGS_KEY]).toEqual({ origin: INSTANCE, projectMappings: LINES });
  });

  it('are not given to a connection to another instance, whose projects they do not name', async () => {
    await keepMappings(INSTANCE, LINES);
    expect(await readKeptMappings('https://other.example.com')).toEqual([]);
    await dropKeptMappings();
    expect(await readKeptMappings(INSTANCE)).toEqual([]);
  });

  it('keep nothing when there is no line, and replace what an earlier Disconnect kept', async () => {
    await keepMappings(INSTANCE, LINES);
    expect(await keepMappings('https://other.example.com', [])).toBe(0);
    expect(local.store[KEPT_MAPPINGS_KEY]).toBeUndefined();
    expect(await keepMappings('not an address', LINES)).toBe(0);
  });

  it('read back only well-formed lines', () => {
    expect(keptFor(null, INSTANCE)).toEqual([]);
    expect(keptFor({ origin: INSTANCE, projectMappings: 'lines' }, INSTANCE)).toEqual([]);
    expect(
      keptFor({ origin: INSTANCE, projectMappings: [LINES[1], { urlPattern: '', projectId: 3 }] }, INSTANCE),
    ).toEqual([LINES[1]]);
  });
});
