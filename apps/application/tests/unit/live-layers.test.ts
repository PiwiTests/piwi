import { describe, expect, test } from 'vitest';
import type { LaneThumb, PageEvent } from '@piwitests/core/live-layers';
import {
  addLaneEvent,
  addLaneThumb,
  emptyLaneEvents,
  laneEventLabel,
  laneEventParts,
  laneTextLines,
  laneTextMatches,
  laneTextTarget,
  laneTextTargets,
  markedParts,
  type LaneEvents,
} from '../../app/utils/live-layers';

/**
 * What the lane panel holds of a worker's layers: the page's events newest first and capped, a pending request on one
 * line, a backend's log under its request whichever came first, and the counts of what is not shown; the filmstrip one
 * image per call, in its calls' order, whatever the worker sends again; and the page's text searched with case and
 * accents ignored, the lines naming the element the shown call targets marked.
 */

const AT = 1_800_000_000_000;

function told(events: PageEvent[], max?: number): LaneEvents {
  return events.reduce((list, event, i) => addLaneEvent(list, event, AT + i, max), emptyLaneEvents());
}

const kinds = (list: LaneEvents) => list.shown.map((line) => line.event.kind);

describe('the page’s events', () => {
  test('are listed newest first, the oldest let go past the cap, and the worker’s dropped ones counted', () => {
    const list = told(
      [
        { kind: 'console', text: 'TypeError: price is undefined' },
        { kind: 'page-error', text: 'Uncaught ReferenceError: cart is not defined' },
        { kind: 'dropped', count: 7 },
        { kind: 'request-failed', method: 'GET', url: 'https://shop.test/api/cart', status: 500, failure: null },
      ],
      2,
    );
    expect(kinds(list)).toEqual(['request-failed', 'page-error']);
    expect(list.dropped).toBe(7);
    expect(list.letGo).toBe(1);
    expect(new Set(list.shown.map((line) => line.key)).size).toBe(2);
  });

  test('show a pending request on one line, its time growing until it ends', () => {
    const pending = (ms: number, done = false): PageEvent => ({
      kind: 'request-pending',
      id: 4,
      method: 'POST',
      url: 'https://shop.test/api/checkout',
      ms,
      done,
    });
    const list = told([
      pending(5_000),
      { kind: 'console', text: 'Still waiting' },
      pending(10_000),
      pending(17_200, true),
    ]);
    expect(kinds(list)).toEqual(['console', 'request-pending']);
    expect(list.shown[1]!.event).toMatchObject({ ms: 17_200, done: true });
    expect(laneEventLabel(list.shown[1]!.event)).toBe('Slow request');
    expect(laneEventParts(list.shown[1]!.event)).toEqual({
      code: 'POST https://shop.test/api/checkout',
      note: 'Answered after',
      ms: 17_200,
      logged: null,
    });
  });

  test('put what a backend logged under its request, whichever came first', () => {
    const failed: PageEvent = {
      kind: 'request-failed',
      method: 'POST',
      url: 'https://shop.test/api/orders',
      status: 500,
      failure: null,
    };
    const logged = (text: string): PageEvent => ({
      kind: 'backend',
      method: 'POST',
      url: 'https://shop.test/api/orders',
      status: 500,
      level: 'error',
      text,
    });
    const after = told([failed, { kind: 'console', text: 'Order failed' }, logged('NullReferenceException')]);
    expect(kinds(after)).toEqual(['console', 'request-failed']);
    expect(after.shown[1]!.backend).toEqual([{ level: 'error', text: 'NullReferenceException' }]);
    const before = told([logged('Deadlock on orders'), logged('Retry failed'), failed]);
    expect(kinds(before)).toEqual(['request-failed']);
    expect(before.shown[0]!.backend.map((line) => line.text)).toEqual(['Deadlock on orders', 'Retry failed']);
    // Another request's log, or one no request listed, stands on its own line.
    const apart = told([failed, { ...logged('Slow query'), status: 200, level: 'warning' } as PageEvent]);
    expect(kinds(apart)).toEqual(['backend', 'request-failed']);
    expect(laneEventLabel(apart.shown[0]!.event)).toBe('Backend warning');
    expect(laneEventParts(apart.shown[0]!.event)).toMatchObject({ note: 'Answered 200', logged: 'Slow query' });
  });

  test('say a test’s API calls, how they were answered or why not, and in how long', () => {
    const answered: PageEvent = {
      kind: 'api',
      method: 'POST',
      url: 'https://api.test/users',
      status: 201,
      ms: 84,
      failure: null,
    };
    expect(laneEventLabel(answered)).toBe('API call');
    expect(laneEventParts(answered)).toEqual({
      code: 'POST https://api.test/users',
      note: 'Answered 201 in',
      ms: 84,
      logged: null,
    });
    expect(laneEventParts({ ...answered, status: null, failure: 'connect ECONNREFUSED' }).note).toBe(
      'Failed: connect ECONNREFUSED, after',
    );
    expect(
      laneEventParts({ kind: 'request-failed', method: 'GET', url: 'https://x.test/a', status: null, failure: null }),
    ).toMatchObject({ note: 'Failed: no answer', ms: null });
  });
});

describe('the filmstrip', () => {
  const shot = (call: string, index: number) => ({
    thumb: { call, title: `Click ${call}`, index, width: 320, height: 200, at: AT + index } satisfies LaneThumb,
  });

  test('holds one image per call, in the strip’s order, whatever the worker sends again', () => {
    let strip: Array<ReturnType<typeof shot>> = [];
    const letGo: string[] = [];
    // A late joiner hears the whole strip from its start, while a newer image may come first.
    for (const next of [shot('call@9', 3), shot('call@2', 1), shot('call@5', 2), shot('call@5', 2)]) {
      const kept = addLaneThumb(strip, next);
      strip = kept.strip;
      letGo.push(...kept.letGo.map((one) => one.thumb.call));
    }
    expect(strip.map((one) => one.thumb.call)).toEqual(['call@2', 'call@5', 'call@9']);
    expect(letGo).toEqual(['call@5']);
  });

  test('keeps the latest images past its size', () => {
    const kept = addLaneThumb([shot('a', 1), shot('b', 2)], shot('c', 3), 2);
    expect(kept.strip.map((one) => one.thumb.call)).toEqual(['b', 'c']);
    expect(kept.letGo.map((one) => one.thumb.call)).toEqual(['a']);
  });
});

/** The page's text as a trace's ARIA snapshot writes it, masked by the worker. */
const TEXT = [
  '- banner [ref=e1]:',
  '  - heading "Checkout" [level=1] [ref=e2]',
  '- main [ref=e3]:',
  '  - textbox "Email" [ref=e4]: jo@example.test',
  '  - textbox "Card number" [ref=e5]: <hidden>',
  '  - paragraph [ref=e6]: Checking your card…',
  '  - button "Pay €84.90" [disabled] [ref=e7]',
  '  - button "Pay later" [ref=e8]',
  '  - text: "Total: €84.90"',
].join('\n');

describe('the page’s text', () => {
  test('names the element a call’s locator targets, read by core’s locator parser', () => {
    expect(laneTextTarget("Click getByRole('button', { name: 'Pay €84' })")).toEqual({
      kind: 'role',
      role: 'button',
      name: 'Pay €84',
      exact: false,
    });
    expect(laneTextTarget("Fill getByRole('main').getByLabel('Card number')")).toEqual({
      kind: 'name',
      name: 'Card number',
      exact: false,
    });
    expect(laneTextTarget("Expect toBeVisible getByText('Checking', { exact: true })")).toEqual({
      kind: 'text',
      text: 'Checking',
      exact: true,
    });
    for (const unnamed of [
      "Click locator('#pay')",
      "Click getByTestId('pay')",
      "Click getByRole('button')",
      "Click getByRole('button', { name: /pay/i })",
      'Navigate to "/checkout"',
      null,
    ]) {
      expect(laneTextTarget(unnamed)).toBeNull();
    }
  });

  test('marks the lines that name the target', () => {
    const lines = laneTextLines(TEXT);
    const marked = (title: string) => laneTextTargets(lines, laneTextTarget(title)).map((i) => lines[i]!.text.trim());
    expect(marked("Click getByRole('button', { name: 'pay €84' })")).toEqual([
      '- button "Pay €84.90" [disabled] [ref=e7]',
    ]);
    expect(marked("Click getByRole('button', { name: 'Pay' })")).toHaveLength(2);
    expect(marked("Click getByRole('button', { name: 'Pay', exact: true })")).toEqual([]);
    expect(marked("Fill getByLabel('Email')")).toEqual(['- textbox "Email" [ref=e4]: jo@example.test']);
    expect(marked("Expect toBeVisible getByText('checking your card')")).toEqual([
      '- paragraph [ref=e6]: Checking your card…',
    ]);
    expect(marked("Expect toHaveText getByText('Total: €84.90')")).toEqual(['- text: "Total: €84.90"']);
    expect(laneTextTargets(lines, null)).toEqual([]);
  });

  test('is searched with case and accents ignored, each match marked in the line’s own characters', () => {
    const lines = laneTextLines('- heading "Résumé" [level=2]\n- text: resume, RESUME');
    const found = laneTextMatches(lines, '  resume ');
    expect(found?.count).toBe(3);
    expect(markedParts(lines[0]!.text, found?.ranges[0])).toEqual([
      { text: '- heading "', marked: false },
      { text: 'Résumé', marked: true },
      { text: '" [level=2]', marked: false },
    ]);
    expect(markedParts(lines[1]!.text, found?.ranges[1]).filter((part) => part.marked)).toHaveLength(2);
    expect(laneTextMatches(lines, '   ')).toBeNull();
    expect(laneTextMatches(lines, 'checkout')?.count).toBe(0);
  });
});
