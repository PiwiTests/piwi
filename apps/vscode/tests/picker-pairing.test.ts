import { describe, expect, test } from 'vitest';
import {
  PICKER_HEARD_EVERY_MS,
  heardAgain,
  pairingPrompt,
  pickerRows,
  pickerViewKind,
  readPickerPaired,
  type PickerRow,
  type PickerViewState,
} from '../src/picker-pairing';

const NOW = Date.parse('2026-11-19T15:00:00Z');
const none: PickerViewState = { waiting: [], paired: null, heard: null, port: 7247, savedPort: null };
const request = {
  id: '0123456789abcdef',
  code: 'BCDF-GHJK',
  client: 'Chrome on macOS',
  createdAt: NOW - 10_000,
  expiresAt: NOW + 290_000,
};

/** The last row: where the window listens. */
const lastRow = (rows: PickerRow[]) => rows[rows.length - 1];

describe('the Piwi Picker view', () => {
  test('welcomes a window never paired, with no row', () => {
    expect(pickerViewKind(none)).toBe('unpaired');
    expect(pickerRows(none, NOW)).toEqual([]);
  });

  test('lists a request waiting first, with its code, for Allow and Deny', () => {
    const rows = pickerRows({ ...none, waiting: [request] }, NOW);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        label: 'Chrome on macOS asks to pair',
        description: 'code BCDF-GHJK',
        contextValue: 'piwi.pairingRequest',
        requestId: request.id,
      }),
    );
    expect(rows.map((r) => r.key)).toEqual([`request:${request.id}`, 'listening']);
  });

  test('says who it is paired with, since when, when it was last heard from, and where it listens', () => {
    const state = {
      ...none,
      paired: { at: Date.parse('2026-11-03T10:00:00Z'), client: 'Firefox on Linux' },
      heard: NOW - 120_000,
    };
    expect(pickerViewKind(state)).toBe('paired');
    expect(pickerRows(state, NOW).map((r) => [r.label, r.description])).toEqual([
      ['Paired with Piwi Picker in Firefox on Linux', 'since Nov 3'],
      ['Last heard 2 min ago', ''],
      ['Listening on 127.0.0.1:7247', ''],
    ]);
  });

  test('counts a Piwi Picker paired with the address once it is heard from', () => {
    const rows = pickerRows({ ...none, heard: NOW - 5_000 }, NOW);
    expect(rows.map((r) => r.label)).toEqual([
      'Paired with Piwi Picker',
      'Last heard 5 s ago',
      'Listening on 127.0.0.1:7247',
    ]);
  });

  test('says when Piwi Picker does not look where the window listens, or another window holds the port', () => {
    const paired = { at: NOW, client: null };
    expect(lastRow(pickerRows({ ...none, paired, port: 53124 }, NOW))).toEqual(
      expect.objectContaining({ label: 'Listening on 127.0.0.1:53124', description: 'not where Piwi Picker looks' }),
    );
    expect(lastRow(pickerRows({ ...none, paired, port: null, savedPort: 7247 }, NOW))?.label).toBe(
      'Another window listens on 127.0.0.1:7247',
    );
    expect(lastRow(pickerRows({ ...none, paired, port: null }, NOW))?.label).toBe('Not listening');
  });

  test('names the date of a pairing of another year with its year', () => {
    const state = { ...none, paired: { at: Date.parse('2025-12-30T10:00:00Z'), client: 'Edge on Windows' } };
    expect(pickerRows(state, NOW)[0]?.description).toBe('since Dec 30, 2025');
  });
});

describe('what is kept', () => {
  test('reads the pairing kept, and nothing else', () => {
    expect(readPickerPaired({ at: 5, client: 'Chrome' })).toEqual({ at: 5, client: 'Chrome' });
    expect(readPickerPaired({ at: 5 })).toEqual({ at: 5, client: null });
    expect(readPickerPaired({ client: 'Chrome' })).toBeNull();
    expect(readPickerPaired(undefined)).toBeNull();
  });

  test('writes when Piwi Picker was last heard from once a minute at most', () => {
    expect(heardAgain(undefined, NOW)).toBe(true);
    expect(heardAgain(NOW - 1000, NOW)).toBe(false);
    expect(heardAgain(NOW - PICKER_HEARD_EVERY_MS, NOW)).toBe(true);
  });
});

test('the notification names the browser and the code to compare', () => {
  expect(pairingPrompt(request)).toBe(
    'Piwi Picker in Chrome on macOS asks to pair with this editor, to send it the locators you pick and follow its runs. Allow it only if Piwi Picker shows the code BCDF-GHJK.',
  );
});
