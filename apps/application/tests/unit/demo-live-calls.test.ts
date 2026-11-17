import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { readLiveViewerMessage, type LiveViewerMessage } from '@piwitests/core/live-view';
import { isLayerCallId } from '@piwitests/core/live-layers';
import { SIMULATOR_CALL_LOGS, storyByClusterId } from '#shared/demo/failure-stories.mjs';
import { readZipEntries } from '../../app/demo/trace-zip.client';
import { withLiveSecretsHidden } from '../../app/demo/api/dom-snapshot';
import { parseTraceTexts, traceFileRank } from '../../server/utils/trace-events';
import { DOM_SNAPSHOT_CAP_CHARS, extractDomSnapshot } from '../../server/utils/dom-snapshot-render';
import {
  DEMO_INSPECT_TRACE,
  DEMO_TRACE_CALLS,
  demoCallError,
  demoCallId,
  demoTraceCall,
  demoCallLog,
  demoSnapshotNotice,
  demoTestHasPages,
  type DemoStep,
} from '../../app/demo/live-calls';

/**
 * What the demo's simulated workers say to a view of them: the call log of each step, the Pay click's as cluster 1's
 * story logs it, and the pages Inspect shows, each a moment of the committed checkout trace.
 */

const worker = { shard: null, worker: 1, slot: 1 };
const location = 'tests/checkout/checkout.spec.ts:20:3';
const pay: DemoStep = {
  title: 'Click',
  subtitle: "getByRole('button', { name: 'Pay' })",
  category: 'action',
  params: { locator: "getByRole('button', { name: 'Pay' })" },
  location: 'tests/helpers/payment.ts:12:51',
};
const email: DemoStep = {
  title: 'Fill "buyer@example.com"',
  subtitle: "getByLabel('Email address')",
  category: 'input',
  params: { locator: "getByLabel('Email address')", value: 'buyer@example.com' },
  location: 'tests/checkout/checkout.spec.ts:9:44',
};
const navigate: DemoStep = {
  title: 'Navigate',
  subtitle: '/checkout',
  category: 'navigation',
  params: { url: 'https://shop.example.com/checkout' },
};

/** A message as the demo's watch reads it from the channel: as a watch reads its stream. */
function read(message: LiveViewerMessage): LiveViewerMessage | null {
  return readLiveViewerMessage({ header: message as unknown as Record<string, unknown>, data: null });
}

describe('the call log of a demo step', () => {
  test('the Pay click logs the story’s call log, then one retry each half second, folded as Playwright folds it', () => {
    const story = storyByClusterId(1)!;
    expect(story.locator).toBe(pay.params!.locator);
    for (const line of SIMULATOR_CALL_LOGS.checkoutPay) expect(story.failingCases[1]!.error).toContain(`  - ${line}`);

    const early = demoCallLog(pay, { id: 'call@12', testLocation: location, status: 'running', ms: 0 });
    expect(early.lines).toEqual(SIMULATOR_CALL_LOGS.checkoutPay.map((line) => `- ${line}`));

    const log = demoCallLog(pay, { id: 'call@12', testLocation: location, status: 'running', ms: 60_150 });
    expect(log.call).toEqual({
      title: "Click getByRole('button', { name: 'Pay' })",
      file: 'tests/helpers/payment.ts',
      line: 12,
    });
    expect(log.lines[0]).toBe("- waiting for getByRole('button', { name: 'Pay' })");
    expect(log.lines[1]).toMatch(/^- locator resolved to <button disabled/);
    expect(log.lines).toContain('120 × waiting for element to be visible, enabled and stable');
    expect(log.lines).toContain('    - element is not enabled');
    expect(log.lines).toContain('    - retrying click action');
    expect(log.target).toEqual({ count: 1, box: null, enabled: false });
    expect(log.ms).toBe(60_150);
  });

  test('a call that ended matches nothing any more, and a failed one says the call the test timeout cut short', () => {
    const error = storyByClusterId(1)!.failingCases[1]!.error;
    const log = demoCallLog(pay, { id: 'call@12', testLocation: location, status: 'failed', ms: 30_000, error });
    expect(log.target).toBeNull();
    expect(log.error).toBe('locator.click: Test timeout of 30000ms exceeded.');
    expect(demoCallError('Error: boom\n    at x.ts:1:1')).toBe('Error: boom');
  });

  test('a navigation logs its address, a locator step waits for its locator, and a step without either logs nothing', () => {
    expect(demoCallLog(navigate, { id: 'demo@0', testLocation: location, status: 'running', ms: 0 })).toMatchObject({
      call: { title: 'Navigate /checkout', file: 'tests/checkout/checkout.spec.ts', line: 20 },
      lines: ['- navigating to "https://shop.example.com/checkout", waiting until "load"'],
      target: null,
    });
    expect(demoCallLog(email, { id: 'call@10', testLocation: location, status: 'passed', ms: 420 }).lines).toEqual([
      "- waiting for getByLabel('Email address')",
    ]);
    const bare = { title: 'Wait for timeout', category: 'wait' };
    expect(demoCallLog(bare, { id: 'demo@3', testLocation: location, status: 'running', ms: 0 }).lines).toEqual([]);
  });

  test('reads as a watch reads it, the text a fill types hidden', () => {
    const log = demoCallLog(email, { id: 'call@10', testLocation: location, status: 'running', ms: 0 });
    const message = read({ type: 'call-log', ...worker, log, test: 'should complete checkout with PayPal' });
    expect(message).toMatchObject({ type: 'call-log', ...worker, test: 'should complete checkout with PayPal' });
    expect(message?.type === 'call-log' && message.log.call.title).toBe(
      'Fill "<hidden>" getByLabel(\'Email address\')',
    );
    const long = demoCallLog(pay, { id: 'call@12', testLocation: location, status: 'running', ms: 6 * 60_000 });
    expect(read({ type: 'call-log', ...worker, log: long, test: null })).toMatchObject({ log: { lines: long.lines } });
  });
});

describe('the pages Inspect shows of a demo step', () => {
  test('a step of the trace names its call and moment, read as a watch reads it; any other names none', () => {
    const at = { call: 'call@12:7', testLocation: location, index: 2, at: 1_800_000_000_000 };
    const before = demoSnapshotNotice(worker, 'should complete checkout with PayPal', pay, { ...at, phase: 'before' });
    expect(before).toMatchObject({ type: 'snapshot', call: 'call@12:7', phase: 'before', main: true, index: 2 });
    expect(read(before!)).toEqual(before);
    expect(demoSnapshotNotice(worker, 'x', navigate, { ...at, phase: 'before' })).toBeNull();
    expect(demoSnapshotNotice(worker, 'x', navigate, { ...at, call: 'call@8:3', phase: 'after' })).toMatchObject({
      call: 'call@8:3',
    });
    const card = { ...email, subtitle: "getByLabel('Card number')", params: { locator: "getByLabel('Card number')" } };
    expect(demoSnapshotNotice(worker, 'x', card, { ...at, phase: 'after' })).toBeNull();
    // Each attempt's calls are its own, the trace's call read back from them.
    expect(demoCallId(pay, 6, '7')).toBe('call@12:7');
    expect(demoCallId(card, 3, '7')).toBe('demo@3:7');
    expect(demoTraceCall('call@12:7')).toBe('call@12');
    expect(isLayerCallId(demoCallId(pay, 6, '1234'))).toBe(true);
    expect(demoTestHasPages([navigate, card])).toBe(true);
    expect(demoTestHasPages([card])).toBe(false);
  });

  test('every moment named is that moment of the committed trace, the Pay click’s the checkout page at its disabled button', async () => {
    const zip = new Uint8Array(
      readFileSync(fileURLToPath(new URL(`../../public/${DEMO_INSPECT_TRACE}`, import.meta.url))),
    );
    const entries = (await readZipEntries(zip, (name) => name.endsWith('.trace'))).sort(
      (a, b) => traceFileRank(a.name) - traceFileRank(b.name),
    );
    const decoder = new TextDecoder();
    const data = parseTraceTexts(entries.map((entry) => decoder.decode(entry.data)));
    for (const { call, phases } of Object.values(DEMO_TRACE_CALLS)) {
      for (const phase of phases) {
        const page = extractDomSnapshot(data, DOM_SNAPSHOT_CAP_CHARS, {}, { callId: call, phase });
        expect(page.snapshotName, `${phase}@${call}`).toBe(`${phase}@${call}`);
        expect(page.html, `${phase}@${call}`).toContain('<h1>Checkout</h1>');
      }
    }
    const atPay = extractDomSnapshot(data, DOM_SNAPSHOT_CAP_CHARS, {}, { callId: 'call@12', phase: 'before' });
    expect(atPay.html).toMatch(/<button class="primary" id="pay" disabled=""/);
    expect(atPay.viewport).toEqual({ width: 640, height: 480 });

    // As a live worker sends it, the page holds no secret field's value: the card's number and code are removed.
    expect(atPay.html).toContain('<input id="card" value="4242 4242 4242 4242">');
    expect(atPay.html).toContain('<input id="cvv" value="123">');
    const live = withLiveSecretsHidden(data);
    for (const { call, phases } of Object.values(DEMO_TRACE_CALLS)) {
      for (const phase of phases) {
        const page = extractDomSnapshot(live, DOM_SNAPSHOT_CAP_CHARS, {}, { callId: call, phase });
        expect(page.snapshotName, `${phase}@${call}`).toBe(`${phase}@${call}`);
        expect(page.html, `${phase}@${call}`).not.toContain('4242');
      }
    }
    const livePay = extractDomSnapshot(live, DOM_SNAPSHOT_CAP_CHARS, {}, { callId: 'call@12', phase: 'before' });
    expect(livePay.html).toContain('<input id="email" type="email" value="buyer@example.com">');
    expect(livePay.html).toContain('<input id="card">');
    expect(livePay.html).toContain('<input id="cvv">');
  });
});
