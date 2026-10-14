/**
 * Shared test fixtures for the Piwi Dashboard test suite.
 *
 * Extends the base Playwright `test` with dashboard fixtures that mirror the
 * behavior of `@piwitests/reporter` fixtures — automatically
 * capturing network request timing, browser performance (Web Vitals),
 * ARIA snapshots, and locator interaction data for every page interaction
 * so they appear in the dashboard.
 *
 * Usage in test files:
 * ```ts
 * import { test, expect } from './fixtures'
 * ```
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { test as base, expect, type Page, type Request, type Response, type TestInfo } from '@playwright/test';
import {
  generateAlternatives,
  extractAccessibleName,
  approximateAccessibleName,
  captureCallerLocation,
  dedupeSnapshotsByLocation,
  resolveAriaRole,
  suggestLocatorsFromAria,
  LOCATOR_METHODS,
  CHAIN_METHODS,
  ACTION_METHODS,
  LOCATOR_CREATING_CHAINS,
  EXPECT_METHOD,
  EXPECT_CAPTURE_EXPRESSIONS,
  type LocatorSnapshot,
  type FailedLocatorInfo,
} from '../../../packages/reporter/dist/internal/capture/locator-healing.js';
import {
  ariaSnapshotBestEffort,
  boxCaptureFrames,
  buildPageState,
  callMethod,
  computeCoreVitals,
  internalCall,
  probeElementAttrs,
  readPageInteraction,
  CAPTURED_ATTRS_ARG,
  LocatorPageLog,
  noteLocatorCall,
  noteNavigation,
  codeReachRoots,
  configuredCodeReachRoots,
  pageMapFetcher,
  resolveCodeReach,
  startCodeReach,
  stopCodeReach,
  activeResourceLedger,
  noteResourceUse,
  recordResourceCensus,
  startResourceLedger,
  stopResourceLedger,
} from '../../../packages/reporter/dist/internal/capture/capture-fixtures.js';
import {
  inspectionGateFromTestInfo,
  shouldInspectOnFailure,
} from '../../../packages/reporter/dist/internal/capture/inspect-on-failure.js';
import {
  applyPickToSnapshots,
  deriveFailedLocator,
  runLocatorPicker,
  type UserPickResult,
} from '../../../packages/reporter/dist/internal/capture/pick-on-failure.js';
import {
  ATTACHMENT_NAMES,
  FAILURE_SCREENSHOT_ATTACHMENT,
  LOCATOR_SUGGESTION_ANNOTATION,
  USER_PICK_ANNOTATION,
} from '../../../packages/reporter/dist/internal/capture/attachments.js';

type NetworkRequest = {
  method: string;
  url: string;
  status: number;
  duration: number;
  startTime: number;
  resourceType: string;
  serverLogs?: unknown;
  failure?: string;
};

async function collectNetworkAndVitals(page: Page, testInfo: TestInfo) {
  const networkRequests: NetworkRequest[] = [];
  const pendingHandlers: Promise<void>[] = [];
  // As the reporter's capture: the response of each request, kept from its arrival, so a request whose body the page
  // never read (a no-store response that never finishes, an empty error response Chromium cancels) is still recorded.
  const openResponses = new Map<Request, Response>();
  const recordedOpen = new WeakSet<Request>();

  /** A request's record; `unfinished` when its response arrived but its body never finished loading. */
  const record = (request: Request, response: Response | null, unfinished: boolean) => {
    const p = (async () => {
      try {
        const url = request.url();
        if (url.startsWith('data:') || url.startsWith('blob:')) return;

        const timing = request.timing();
        response ??= unfinished ? null : await request.response();
        const duration = unfinished
          ? Math.max(0, Math.round(timing.responseStart - timing.requestStart))
          : timing.responseEnd > 0
            ? Math.round(timing.responseEnd - timing.requestStart)
            : 0;

        const entry: NetworkRequest = {
          method: request.method(),
          url,
          status: response ? response.status() : 0,
          duration,
          startTime: timing.startTime,
          resourceType: request.resourceType(),
        };

        if (response) {
          const logHeader = response.headers()['x-piwi-logs'];
          if (logHeader) {
            try {
              entry.serverLogs = JSON.parse(gunzipSync(Buffer.from(logHeader, 'base64')).toString('utf-8'));
            } catch {
              /* ignore malformed header */
            }
          }
        }

        networkRequests.push(entry);
      } catch {
        // ignore aborted requests
      }
    })();
    pendingHandlers.push(p);
  };

  page.on('response', (response) => {
    try {
      openResponses.set(response.request(), response);
    } catch {
      /* a page event handler must never throw */
    }
  });

  page.on('requestfinished', (request) => {
    if (recordedOpen.has(request)) return;
    const response = openResponses.get(request) ?? null;
    openResponses.delete(request);
    record(request, response, false);
  });

  page.on('requestfailed', (request) => {
    if (recordedOpen.has(request)) return;
    const response = openResponses.get(request) ?? null;
    openResponses.delete(request);
    try {
      const failure = request.failure()?.errorText ?? 'failed';
      // Cancelled after its response arrived: the response is the record.
      if (response && /^net::ERR_ABORTED$|^NS_BINDING_ABORTED$|cancell?ed/i.test(failure)) {
        record(request, response, true);
        return;
      }
      const url = request.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return;
      const timing = request.timing();
      networkRequests.push({
        method: request.method(),
        url,
        status: 0,
        duration: timing.startTime > 0 ? Math.max(0, Math.round(Date.now() - timing.startTime)) : 0,
        startTime: timing.startTime,
        resourceType: request.resourceType(),
        failure,
      });
    } catch {
      /* a request shape the reader does not expect — skip it */
    }
  });

  return async () => {
    // Wait for all in-flight requestfinished handlers to complete before
    // snapshotting networkRequests — without this, the last request (often
    // the one that caused the test to fail) races with fixture teardown and
    // its entry (including serverLogs) can be missing from the attachment.
    // The requests whose response arrived but which are still open are recorded first.
    for (const [request, response] of openResponses) {
      recordedOpen.add(request);
      record(request, response, true);
    }
    openResponses.clear();
    await Promise.allSettled(pendingHandlers);

    if (networkRequests.length > 0) {
      await testInfo.attach(ATTACHMENT_NAMES.network, {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(networkRequests)),
      });
    }

    try {
      const probe = await page.evaluate(async () => {
        const navEntries = performance.getEntriesByType('navigation');
        const paintEntries = performance.getEntriesByType('paint');
        const nav = navEntries[0] as PerformanceNavigationTiming | undefined;

        const navigation = nav
          ? {
              url: nav.name,
              ttfb: Math.round(nav.responseStart - nav.fetchStart),
              domInteractive: Math.round(nav.domInteractive - nav.fetchStart),
              domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.fetchStart),
              loadComplete: Math.round(nav.loadEventEnd - nav.fetchStart),
              transferSize: nav.transferSize || 0,
              encodedBodySize: nav.encodedBodySize || 0,
              decodedBodySize: nav.decodedBodySize || 0,
            }
          : null;

        const paint: Record<string, number> = {};
        for (const entry of paintEntries) {
          const key = entry.name.replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase());
          paint[key] = Math.round(entry.startTime);
        }

        // Buffered core-vitals entries (Chromium-only; null = type unsupported).
        // Mirrors the reporter fixture's readWebVitals probe.
        const readBuffered = (type: string, extra?: Record<string, unknown>): Promise<any[] | null> =>
          new Promise((resolve) => {
            try {
              const PO = (globalThis as any).PerformanceObserver;
              if (!PO || !(PO.supportedEntryTypes || []).includes(type)) return resolve(null);
              const out: any[] = [];
              const po = new PO((list: any) => out.push(...list.getEntries()));
              po.observe({ type, buffered: true, ...extra });
              setTimeout(() => {
                try {
                  out.push(...po.takeRecords());
                  po.disconnect();
                } catch {
                  // Entries gathered so far still count.
                }
                resolve(out);
              }, 0);
            } catch {
              resolve(null);
            }
          });

        const [lcpRaw, shiftRaw, eventRaw, firstInputRaw] = await Promise.all([
          readBuffered('largest-contentful-paint'),
          readBuffered('layout-shift'),
          readBuffered('event', { durationThreshold: 40 }),
          readBuffered('first-input'),
        ]);

        const project = (entries: any[] | null) =>
          entries === null
            ? null
            : entries.map((e: any) => ({
                startTime: e.startTime,
                value: e.value,
                hadRecentInput: e.hadRecentInput,
                interactionId: e.interactionId,
                duration: e.duration,
              }));

        const interactionEntries =
          eventRaw === null && firstInputRaw === null ? null : [...(eventRaw ?? []), ...(firstInputRaw ?? [])];

        return {
          navigation,
          paint,
          lcpEntries: project(lcpRaw),
          shiftEntries: project(shiftRaw),
          eventEntries: project(interactionEntries),
        };
      });

      const vitals = computeCoreVitals(probe.lcpEntries, probe.shiftEntries, probe.eventEntries);
      if (probe.navigation || Object.keys(probe.paint).length > 0 || vitals) {
        await testInfo.attach(ATTACHMENT_NAMES.webVitals, {
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({ navigation: probe.navigation, paint: probe.paint, vitals })),
        });
      }
    } catch {
      // page may already be closed or no navigation happened
    }

    // Page state at test end (dogfooding: mirrors the reporter fixture's capture)
    if (process.env.PIWI_CAPTURE_PAGE_STATE !== 'false') {
      try {
        const rawState = await page.evaluate(() => {
          const listStorage = (s: Storage): Array<{ key: string; length: number }> => {
            const out: Array<{ key: string; length: number }> = [];
            try {
              for (let i = 0; i < s.length; i++) {
                const key = s.key(i);
                if (key != null) out.push({ key, length: (s.getItem(key) ?? '').length });
              }
            } catch {
              // Storage access can throw in sandboxed pages.
            }
            return out;
          };
          let historyState: string | null = null;
          try {
            historyState = history.state == null ? null : JSON.stringify(history.state);
          } catch {
            // Unserializable history state.
          }
          return {
            url: location.href,
            hash: location.hash || null,
            historyState,
            localStorage: listStorage(localStorage),
            sessionStorage: listStorage(sessionStorage),
          };
        });
        const cookies = await page
          .context()
          .cookies()
          .catch(() => null);
        const interaction = await page.evaluate(readPageInteraction).catch(() => null);
        const pageState = buildPageState(rawState, cookies as Array<Record<string, unknown>> | null, interaction);
        await testInfo.attach(ATTACHMENT_NAMES.pageState, {
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify(pageState)),
        });
      } catch {
        // page may already be closed
      }
    }
  };
}

/** This file, boxed with the reporter's bundle so wrapped actions report the spec's line. */
const FIXTURES_FILE = fileURLToPath(import.meta.url);

export const test = base.extend<{ page: Page; piwiResourceCensus: void }, { piwiResources: void }>({
  // ── Resource ledger (mirrors the reporter fixtures' `piwiResources` worker
  // fixture and the census their `piwiCapture` takes) ──
  piwiResources: [
    async ({ playwright }, use, workerInfo) => {
      boxCaptureFrames([FIXTURES_FILE]);
      startResourceLedger(playwright, workerInfo.workerIndex);
      try {
        await use();
      } finally {
        stopResourceLedger();
      }
    },
    { scope: 'worker', auto: true },
  ],
  // Auto, so it is set up before the page and torn down after its context:
  // what is still open at the census outlived the test.
  piwiResourceCensus: [
    async ({}, use, testInfo) => {
      activeResourceLedger()?.testStarted(testInfo);
      await use();
      await recordResourceCensus(testInfo);
    },
    { auto: true },
  ],
  page: async ({ page }, use, testInfo) => {
    boxCaptureFrames([FIXTURES_FILE]);
    // ── Locator interaction capture (dogfooding: matches reporter/src/fixtures.ts) ──
    const captureLocators = process.env.PIWI_CAPTURE_LOCATORS !== 'false';
    const capturedLocators: LocatorSnapshot[] = [];
    const capturePromises: Promise<void>[] = [];
    const failedLocators: FailedLocatorInfo[] = [];
    // Call sites already captured via a passing assertion this test —
    // assertions are denser than actions, so each site probes only once.
    const expectCapturedLocations = new Set<string>();
    // The page each locator call ran on (mirrors the reporter fixture's `piwi-locator-pages`).
    const locatorPages = new LocatorPageLog();
    const recordPage = (target: unknown, location: string | null, arrival: boolean) => {
      try {
        locatorPages.record({ location, locator: String(target), url: page.url(), arrival });
      } catch {
        // A side channel: it must never affect the test.
      }
    };

    // Method-surface constants and the in-page probe are imported from the
    // reporter so this fixture stays in lockstep with the reporter's proxy
    // (LOCATOR_METHODS, CHAIN_METHODS, ACTION_METHODS, EXPECT_METHOD,
    // EXPECT_CAPTURE_EXPRESSIONS, probeElementAttrs).

    // Fire-and-forget element capture for a locator that proved it resolves —
    // a successful action or a passing presence assertion (mirrors the
    // reporter fixture's startElementCapture).
    function startElementCapture(
      target: any,
      seq: number,
      callerLocation: string | null,
      used: LocatorSnapshot['used'],
    ): void {
      const resolveAttrs = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const attrs = (await Promise.race([
            internalCall(page, () => target.evaluate(probeElementAttrs, CAPTURED_ATTRS_ARG)),
            new Promise<null>((_, reject) => {
              deadline = setTimeout(() => reject(new Error('locator capture timeout')), 500);
            }),
          ])) as any;

          // Only pay for the ARIA snapshot when the accessible name will
          // be used (role-based or form-field alternatives).
          const role = resolveAriaRole({ ...attrs, accessibleName: null });
          const isFormField = ['input', 'select', 'textarea'].includes(attrs.tagName);
          // Bound with a timeout: without it, ariaSnapshot waits up to the
          // test timeout when the page is mid-navigation, hanging the
          // fixture teardown that drains these capture promises.
          const aria =
            role || isFormField ? await internalCall(page, () => ariaSnapshotBestEffort(target as any, 500)) : null;

          const accessibleName =
            extractAccessibleName(aria) || approximateAccessibleName({ ...attrs, accessibleName: null });

          capturedLocators[seq] = {
            location: callerLocation,
            used,
            // hasLabel/selectorCounts inform alternative generation only —
            // keep the stored element to the wire shape. rolePosition and
            // ancestors ARE wire fields: the server's renamed-element
            // match uses them at heal time.
            element: {
              tagName: attrs.tagName,
              attributes: attrs.attributes,
              textContent: attrs.textContent,
              accessibleName,
              center: attrs.center,
              ...(attrs.rolePosition ? { rolePosition: attrs.rolePosition } : {}),
              ...(attrs.ancestors && attrs.ancestors.length > 0 ? { ancestors: attrs.ancestors } : {}),
            },
            alternatives: generateAlternatives({ ...attrs, accessibleName }),
          };
        } catch {
          // keep the placeholder
        } finally {
          clearTimeout(deadline);
        }
      })();

      capturePromises.push(resolveAttrs);
    }

    function wrapLocator(locator: any, originMethod: string, originArgs: unknown[]): any {
      return new Proxy(locator, {
        get(target, prop) {
          const original = target[prop];
          if (typeof original !== 'function') return original;

          if (CHAIN_METHODS.includes(prop as string)) {
            return (...args: unknown[]) => {
              const next = callMethod(target, prop, args);
              if (LOCATOR_CREATING_CHAINS.has(prop as string)) {
                return wrapLocator(next, String(prop), args);
              }
              return wrapLocator(next, originMethod, originArgs);
            };
          }

          if (prop === EXPECT_METHOD) {
            return async (...callArgs: unknown[]) => {
              const expression = typeof callArgs[0] === 'string' ? callArgs[0] : '';
              const isNot = Boolean((callArgs[1] as { isNot?: boolean } | undefined)?.isNot);
              // Sync, before the await — the caller's frames are gone after it.
              const callerLocation = captureCallerLocation();
              // Every assertion records the page it ran on, negations included.
              recordPage(target, callerLocation, noteLocatorCall(page, EXPECT_METHOD, true));
              // Only positive presence-proving assertions participate —
              // negations, absence/count/page-level assertions, and any
              // unknown future expression pass through untouched.
              if (isNot || !EXPECT_CAPTURE_EXPRESSIONS.has(expression)) {
                return callMethod(target, prop, callArgs);
              }

              const used = {
                method: originMethod,
                args: originArgs,
                raw: `${originMethod}(${JSON.stringify(originArgs)})`,
              };

              // One probe per call site: assertions are far denser than
              // actions (loops, toPass blocks re-assert the same line). The
              // placeholder still marks the location as exercised this run.
              const alreadyCaptured = callerLocation !== null && expectCapturedLocations.has(callerLocation);
              let seq = -1;
              if (!alreadyCaptured) {
                seq = capturedLocators.length;
                capturedLocators.push({ location: callerLocation, used, element: null, alternatives: [] });
              }

              const result = await callMethod(target, prop, callArgs);

              // `_expect` reports the outcome instead of throwing (the matcher
              // layer above does the throw). A missing `matches` — a future
              // result-shape change — degrades to no capture.
              const matches = (result as { matches?: boolean } | null | undefined)?.matches;
              if (matches === true && !alreadyCaptured) {
                if (callerLocation) expectCapturedLocations.add(callerLocation);
                startElementCapture(target, seq, callerLocation, used);
              } else if (matches === false) {
                // A presence assertion that missed is a failed-locator signal —
                // feeds the failure-time picker and the fresh-locator
                // suggestion, same as a failed action.
                failedLocators.push({ method: originMethod, args: originArgs, location: callerLocation });
              }

              return result;
            };
          }

          if (!ACTION_METHODS.includes(prop as string)) return original;

          return async (...callArgs: unknown[]) => {
            const seq = capturedLocators.length;
            // Capture the test call-site now (sync) so the snapshot's location
            // matches the error stack's first user frame.
            const callerLocation = captureCallerLocation();
            recordPage(target, callerLocation, noteLocatorCall(page, String(prop)));
            const used = {
              method: originMethod,
              args: originArgs,
              raw: `${originMethod}(${JSON.stringify(originArgs)})`,
            };

            // Push a placeholder immediately — DOM capture runs async below
            capturedLocators.push({
              location: callerLocation,
              used,
              element: null,
              alternatives: [],
            });

            // The placeholder is already pushed. If the action throws, record
            // the failed locator (so teardown can suggest a fresh one for the
            // element's current identity) and re-throw so the test still fails.
            let result: unknown;
            try {
              result = await callMethod(target, prop, callArgs);
            } catch (err) {
              failedLocators.push({ method: originMethod, args: originArgs, location: callerLocation });
              throw err;
            }

            startElementCapture(target, seq, callerLocation, used);

            return result;
          };
        },
      });
    }

    if (captureLocators) {
      for (const method of LOCATOR_METHODS) {
        const original = (page as any)[method].bind(page);
        (page as any)[method] = (...args: unknown[]) => {
          noteResourceUse(page);
          return wrapLocator(original(...args), method, args);
        };
      }
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) noteNavigation(page);
      });
    }

    // ── Code reach (mirrors the reporter fixture, on with PIWI_CAPTURE_CODE_REACH=true) ──
    const codeReach = process.env.PIWI_CAPTURE_CODE_REACH === 'true' && (await startCodeReach(page));

    // ── Existing event listeners ──────────────────────────────────────────
    const flush = await collectNetworkAndVitals(page, testInfo);
    await use(page);

    if (codeReach && !page.isClosed()) {
      try {
        const entries = await stopCodeReach(page);
        const configDir = testInfo.config.configFile ? dirname(testInfo.config.configFile) : testInfo.config.rootDir;
        const files = entries
          ? await resolveCodeReach(entries, codeReachRoots(configDir, configuredCodeReachRoots()), pageMapFetcher(page))
          : [];
        if (files.length > 0) {
          await testInfo.attach(ATTACHMENT_NAMES.codeReach, {
            contentType: 'application/json',
            body: Buffer.from(JSON.stringify(files)),
          });
        }
      } catch {
        // Code reach is best-effort and must never affect the test.
      }
    }

    // ── Attach locator snapshots ──────────────────────────────────────────
    // Cap the drain so a stuck capture (e.g. a navigation in flight) can never
    // hang teardown past the test timeout; per-action evaluate/ariaSnapshot are
    // already bounded, this is a backstop.
    let drainDeadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(capturePromises),
      new Promise((resolve) => {
        drainDeadline = setTimeout(resolve, 2000);
      }),
    ]);
    clearTimeout(drainDeadline);

    // Failure-time overlay (dogfooding: mirrors the reporter fixture). Both
    // PIWI_PICK_LOCATOR_ON_FAIL and PIWI_INSPECT_ON_FAIL open Piwi's own
    // overlay — never Playwright's native inspector. Runs before the snapshots
    // attach — a confirmed pick is folded into them.
    let userPick: UserPickResult | null = null;
    const pickGate = shouldInspectOnFailure(
      inspectionGateFromTestInfo(testInfo, process.env.PIWI_PICK_LOCATOR_ON_FAIL),
    );
    const inspectGate = shouldInspectOnFailure(inspectionGateFromTestInfo(testInfo, process.env.PIWI_INSPECT_ON_FAIL));
    if (pickGate || inspectGate) {
      // Captured failed action, else the failing locator derived from an
      // assertion error; inspectOnFailure opens even with no failing locator.
      const failed = failedLocators[failedLocators.length - 1] ?? deriveFailedLocator(testInfo);
      if (failed || inspectGate) {
        userPick = await internalCall(page, () =>
          runLocatorPicker(page, testInfo, failed, {
            fn: probeElementAttrs,
            arg: CAPTURED_ATTRS_ARG,
          }),
        );
        if (userPick) applyPickToSnapshots(capturedLocators, userPick);
      }
    }

    if (capturedLocators.length > 0) {
      await testInfo.attach(ATTACHMENT_NAMES.locators, {
        contentType: 'application/json',
        // Repeated call sites (loops) keep only their latest capture.
        body: Buffer.from(JSON.stringify(dedupeSnapshotsByLocation(capturedLocators))),
      });
    }
    if (locatorPages.size > 0) {
      await testInfo.attach(ATTACHMENT_NAMES.locatorPages, {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(locatorPages.list())),
      });
    }

    try {
      if (testInfo.status !== testInfo.expectedStatus) {
        const screenshot = await page.screenshot({ fullPage: true, timeout: 5000 });
        await testInfo.attach(FAILURE_SCREENSHOT_ATTACHMENT, {
          contentType: 'image/png',
          body: screenshot,
        });
      }
    } catch {
      // page may already be closed or screenshot failed — skip
    }

    try {
      if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
        // Version-tolerant + bounded — mirrors the reporter's flushSink.
        const snapshot = await internalCall(page, () => ariaSnapshotBestEffort(page.locator(':root') as any));
        if (snapshot) {
          await testInfo.attach(ATTACHMENT_NAMES.ariaSnapshot, {
            contentType: 'text/plain',
            body: snapshot,
          });

          // Suggest a fresh locator for the failed action from the current page
          // (matches reporter/src/fixtures.ts). Annotation shows in the report +
          // trace; attachment shows in the trace viewer. Does not change the locator.
          const failed = failedLocators[failedLocators.length - 1];
          const suggestion = failed ? suggestLocatorsFromAria(failed, snapshot) : null;
          if (suggestion) {
            testInfo.annotations.push({
              type: LOCATOR_SUGGESTION_ANNOTATION,
              description: `${suggestion.failing} matched nothing on the failing page — the element may have been renamed or moved. Suggested: ${suggestion.suggestions.join('  |  ')}`,
            });
            await testInfo.attach(ATTACHMENT_NAMES.locatorSuggestion, {
              contentType: 'application/json',
              body: Buffer.from(JSON.stringify(suggestion)),
            });
          }
        }
      }
    } catch {
      // aria snapshot may fail if page is already closed
    }

    // A confirmed picker choice — attach it and surface it in the report
    // (matches the reporter fixture's flushSink).
    if (userPick) {
      testInfo.annotations.push({
        type: USER_PICK_ANNOTATION,
        description: userPick.failing
          ? `Replacement locator picked on the failing page for ${userPick.failing.rendered}` +
            `${userPick.failing.location ? ` at ${userPick.failing.location}` : ''}: ${userPick.picked.locator}`
          : `Locator picked while inspecting the failing page: ${userPick.picked.locator}`,
      });
      await testInfo.attach(ATTACHMENT_NAMES.userPick, {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(userPick)),
      });
    }

    await internalCall(page, flush);
  },
});

export { expect };
