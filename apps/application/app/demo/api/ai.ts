/**
 * Client-side implementations of the AI-diagnosis endpoints for demo mode.
 *
 * The demo has no real AI provider, but it still tells a fully-grounded story: for
 * every failing cluster it generates a diagnosis from that cluster's *actual* seeded
 * evidence (occurrences, failure rate, affected tests, browsers) and the canned SCM
 * history, then streams believable "thinking" tokens before returning a structured
 * result. Suggested-fix patches are validated for real against the seeded source
 * files, so the "verified patch" badge means the same thing it does in production.
 *
 * Diagnoses are persisted to the in-browser DB so they survive reloads; a
 * force-refresh snapshots the previous result into the version history first.
 */

import { eq, and, isNotNull } from 'drizzle-orm';
import {
  failureDiagnoses,
  failureDiagnosisVersions,
  testRunsCases,
  failureClusters,
  projects,
} from '../../../server/database/schema';
import type { FailureDiagnosis } from '../../../server/database/schema';
import { getDemoDb } from '../db.client';
import {
  CONTEXT_LIMIT_FIELDS,
  DEFAULT_CONTEXT_LIMITS,
  CONTEXT_LIMITS_SETTING_KEY,
  resolveStoredContextLimits,
  mergeContextLimitsUpdate,
} from '#shared/ai-context-limits';
import type { ContextLimits } from '#shared/ai-context-limits';
import { getAppSetting, setAppSetting } from '~~/server/utils/app-settings';
import { validatePatch } from '#shared/patch';
import { hasFailureToDiagnose } from '#shared/ai-diagnosis';
import { buildDiagnosisVersionValues } from '#shared/handlers/diagnosis-versions';
import { getAiUsageSummary } from '#shared/handlers/ai-usage';
import { collectClusterEvidence } from './diagnosis-context';
import type { ClusterEvidence } from './diagnosis-context';
import { getDemoScmProject } from '../demo-scm';
import { storyByClusterId } from '#shared/demo/failure-stories.mjs';
import { parsePlaywrightError } from '#shared/error-parse';
import type { FailureStory } from '#shared/demo/failure-stories.mjs';
import { publishDemoNotificationEvent } from '../run-events';
import { demoHttpError } from './http-error';
import { diagnosisFrame } from '~~/server/utils/diagnosis-stream-frames';

const DEMO_MODEL = 'demo-simulated';

/** GET /api/ai/status */
export async function apiGetAiStatus() {
  return { configured: true, provider: 'demo', model: DEMO_MODEL, autoDiagnose: false, source: 'demo' };
}

// ── Scripted diagnosis generation ────────────────────────────────────────────

type DiagnosisKind =
  | 'timeout-interaction'
  | 'goto-timeout'
  | 'http-500'
  | 'assertion-mismatch'
  | 'strict-mode'
  | 'stale-locator'
  | 'js-error'
  | 'crash'
  | 'env-visibility'
  | 'generic';

const STORY_KINDS: DiagnosisKind[] = [
  'timeout-interaction',
  'goto-timeout',
  'http-500',
  'assertion-mismatch',
  'strict-mode',
  'stale-locator',
  'js-error',
  'crash',
  'env-visibility',
];

/**
 * Classify a cluster into a diagnosis script kind. Seeded clusters carry their
 * kind on the failure story; clusters created live (e.g. by the run simulator)
 * fall back to pattern-matching the error the same way the seeded ones would.
 */
function diagnosisKind(
  errorType: string | null,
  sampleError: string | null,
  story: FailureStory | null,
): DiagnosisKind {
  const storyKind = story?.diagnosis.kind as DiagnosisKind | undefined;
  if (storyKind && STORY_KINDS.includes(storyKind)) return storyKind;
  const e = sampleError ?? '';
  if (errorType === 'strict-mode') return 'strict-mode';
  if (errorType === 'crash') return 'crash';
  if (/page\.goto/.test(e)) return 'goto-timeout';
  if (errorType === 'timeout' || errorType === 'navigation') return 'timeout-interaction';
  if (/\b500\b|Server error/.test(e)) return 'http-500';
  if (errorType === 'assertion') return 'assertion-mismatch';
  return 'generic';
}

interface DiagnosisScript {
  category: string;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  severity: 'blocker' | 'high' | 'medium' | 'low';
  affectedArea: string;
  summary: string;
  rootCause: string;
  hypotheses: Array<{ category: string; likelihood: number; rootCause: string; evidence: string[] }>;
  evidence: string[];
  investigationSteps: string[];
  preventionTips: string[];
  suggestedFix: { description: string; file: string | null; code: string | null; patch: string | null };
  thinkingChunks: string[];
}

/** First affected test's short name, for interpolation. */
function firstTest(ev: ClusterEvidence): string {
  return ev.affectedTests[0]?.title ?? ev.rep?.title ?? 'the affected test';
}

function browsersSentence(ev: ClusterEvidence): string {
  if (!ev.browsers.length) return 'all browsers';
  return ev.browsers.map((b) => `${b.name} (${b.count})`).join(', ');
}

/**
 * The slow request a timed-out click waited on, from the representative
 * execution's network capture: its `METHOD /path`, how long it took, and how
 * the call log describes the target (a disabled one stays disabled until the
 * request answers). Null when the capture has no slow request.
 */
function waitedOnRequest(ev: ClusterEvidence) {
  const req = ev.slowRequest;
  if (!req) return null;
  const parsed = parsePlaywrightError(ev.rep?.error ?? ev.cluster.sampleError ?? '');
  let path = req.url;
  try {
    path = new URL(req.url).pathname;
  } catch {
    // A relative or malformed URL is named as captured.
  }
  return {
    name: `${req.method} ${path}`,
    took: `${Math.round(req.duration / 1000)} s`,
    tookExact: `${(req.duration / 1000).toFixed(1)} s`,
    timeout: `${Math.round((parsed.timeoutMs ?? 30000) / 1000)} s ${parsed.kind === 'test-timeout' ? 'test timeout' : 'timeout'}`,
    target: /not enabled/.test(ev.rep?.error ?? ev.cluster.sampleError ?? '') ? 'stays disabled' : 'is not ready',
  };
}

function buildScript(kind: DiagnosisKind, ev: ClusterEvidence, story: FailureStory | null): DiagnosisScript {
  const proj = getDemoScmProject(ev.cluster.projectId);
  const suspectSha = story?.suspectSha ?? proj?.suspectShas[0];
  const suspect = proj?.commits.find((c) => c.sha === suspectSha);
  const suspectLine = suspect ? `\`${suspect.sha.slice(0, 7)}\` "${suspect.message}"` : 'a recent commit';
  const rate = ev.failureRatePct;
  const runs = `${ev.failedRuns}/${ev.runsInProject} runs (${rate}%)`;
  const tests = ev.affectedTests.length;
  const area = story?.diagnosis.area ?? ev.rep?.filePath ?? 'unknown';
  /** The story's verified fix, or advice-only when the cluster has no story. */
  const fix = (fallbackDescription: string, code: string | null = null) =>
    story
      ? {
          description: story.diagnosis.fix.description,
          file: story.diagnosis.fix.file,
          code: null,
          patch: story.diagnosis.fix.patch,
        }
      : { description: fallbackDescription, file: null, code, patch: null };

  switch (kind) {
    case 'timeout-interaction': {
      const waited = waitedOnRequest(ev);
      if (waited) {
        return {
          category: 'infrastructure',
          confidence: 'high',
          confidenceScore: 82,
          severity: 'high',
          affectedArea: area,
          summary: `${firstTest(ev)} times out on its click: the target ${waited.target} until ${waited.name} answers, and on CI that request takes ${waited.took}, so the click is still waiting when the ${waited.timeout} hits.`,
          rootCause: `The click waits on a target that ${waited.target} until ${waited.name} answers. On the failing run that request takes ${waited.tookExact}, so the click is still waiting when the ${waited.timeout} interrupts it, and nothing in the test waits on the request first.${suspect ? ` The failures start with ${suspectLine}.` : ''}`,
          hypotheses: [
            {
              category: 'infrastructure',
              likelihood: 82,
              rootCause: `${waited.name} answers in ${waited.took} on loaded CI runners; the target ${waited.target} until then, so the click is still waiting when the ${waited.timeout} hits.`,
              evidence: [
                `${waited.name} takes ${waited.tookExact} on the failing run [networkRequests]`,
                `Failure rate correlates with CI load: ${runs} [recurrenceFlakiness]`,
              ],
            },
            {
              category: 'test-bug',
              likelihood: 38,
              rootCause: `The test clicks without waiting for ${waited.name}.`,
              evidence: [`Nothing waits on ${waited.name} before the click [testSource]`],
            },
          ],
          evidence: [
            `TimeoutError fires during the click across ${tests} test(s) [executionError]`,
            `${waited.name} takes ${waited.tookExact} on the failing run [networkRequests]`,
            `Affects ${browsersSentence(ev)} [browserDistribution]`,
          ],
          investigationSteps: [
            `Time ${waited.name} on a low-load runner to confirm CI load is the driver`,
            `Check why ${waited.name} slows down under load`,
          ],
          preventionTips: [
            'Wait on the request a control depends on (page.waitForResponse) before interacting with it',
            'Mark flows that wait on slow backend calls with test.slow() instead of raising the global timeout',
          ],
          suggestedFix: fix(
            `Wait for ${waited.name} (page.waitForResponse) before the click, so the click does not wait on it until the timeout.`,
          ),
          thinkingChunks: [
            'Starting from the error signature: this is a **locator timeout**, not an assertion failure.\n\n',
            `The cluster recurs in **${runs}**. A deterministic bug would fail every run; an intermittent rate this shape points at timing.\n\n`,
            `The network capture of the failing run has **${waited.name}** taking **${waited.tookExact}**.\n\n`,
            `The locator resolves but the target ${waited.target}, so the click waits on that request until the ${waited.timeout} hits.\n\n`,
            `Nothing in the test waits on ${waited.name} before the click. Primary hypothesis: a slow request the click depends on, worse on a loaded CI runner. Writing it up.\n\n`,
          ],
        };
      }
      return {
        category: 'infrastructure',
        confidence: 'high',
        confidenceScore: 82,
        severity: 'high',
        affectedArea: area,
        summary: `${firstTest(ev)} times out clicking the target element — the page renders slowly on CI and the click races the render.`,
        rootCause: `The locator times out because the target element is present in the DOM but not yet interactive when the click fires. ${suspect ? `The introduction of ${suspectLine} added a third-party script fetch that delays the form becoming interactive; ` : ''}on a loaded CI runner this consistently exceeds the default 30s timeout.`,
        hypotheses: [
          {
            category: 'infrastructure',
            likelihood: 82,
            rootCause:
              'Slow CI runner renders the form too late; the click exceeds the timeout before the element is interactive.',
            evidence: [
              `Failure rate correlates with CI load — ${runs} [recurrenceFlakiness]`,
              'Element present in the DOM but not interactive at click time [steps]',
            ],
          },
          {
            category: 'test-bug',
            likelihood: 38,
            rootCause: 'The test clicks without waiting for what the element depends on.',
            evidence: ['Nothing waits on the request or state the element depends on before the click [testSource]'],
          },
        ],
        evidence: [
          `TimeoutError fires during the click across ${tests} test(s) [executionError]`,
          `Recurs in ${runs}, and the SCM diff shows a new async dependency [scmInvestigation]`,
          `Affects ${browsersSentence(ev)} [browserDistribution]`,
        ],
        investigationSteps: [
          'Re-run the cluster on a low-load runner to confirm CI variability is the driver',
          'Find the request or state the target waits on before it becomes interactive',
        ],
        preventionTips: [
          'Wait on the request the element depends on (page.waitForResponse), or assert its state (expect(locator).toBeEnabled()), before interacting',
          'Add a CI-aware timeout multiplier for critical interactions',
        ],
        suggestedFix: fix(
          'Wait for the request or the web-first condition the element depends on (page.waitForResponse, expect(locator).toBeEnabled()) before the interaction, so the click does not race it.',
        ),
        thinkingChunks: [
          'Starting from the error signature — this is a **locator timeout**, not an assertion failure.\n\n',
          `The cluster recurs in **${runs}**. A deterministic bug would fail every run; an intermittent rate this shape points at timing.\n\n`,
          'The element is in the DOM (the locator resolves) but the click never lands — so it is present-but-not-interactive.\n\n',
          `Cross-referencing the SCM diff: ${suspectLine} added a third-party payment SDK fetched before the form is enabled.\n\n`,
          'On a loaded CI runner that fetch pushes interactivity past the 30s timeout. Primary hypothesis: infrastructure-amplified race. Writing it up.\n\n',
        ],
      };
    }

    case 'goto-timeout':
      return {
        category: 'infrastructure',
        confidence: 'high',
        confidenceScore: 78,
        severity: 'high',
        affectedArea: area,
        summary: `page.goto exceeds the 30s navigation timeout on ${browsersSentence(ev)} — the landing page ships heavy unoptimized assets.`,
        rootCause: `The navigation timeout is exceeded during initial page load. ${suspect ? `${suspectLine} added a full-bleed hero image with no optimization; ` : ''}on throttled mobile CI networks the load never completes inside the default timeout.`,
        hypotheses: [
          {
            category: 'infrastructure',
            likelihood: 78,
            rootCause: 'Heavy unoptimized assets push mobile page load past the goto timeout on CI networks.',
            evidence: [
              'Timeout occurs on the main navigation load, not a later interaction [executionError]',
              `Only affects the mobile browser profile — ${browsersSentence(ev)} [browserDistribution]`,
            ],
          },
          {
            category: 'environment',
            likelihood: 34,
            rootCause: 'CI network throttling specific to the mobile project profile.',
            evidence: [`Page load time tracks asset deploys [webVitals]`],
          },
        ],
        evidence: [
          `page.goto TimeoutError across ${tests} test(s) [executionError]`,
          `Recurs in ${runs} [recurrenceFlakiness]`,
          `A new large asset was added in the diff [scmInvestigation]`,
        ],
        investigationSteps: [
          'Measure page weight and largest-contentful-paint on the mobile profile',
          'Compare goto timing on local mobile emulation vs CI',
        ],
        preventionTips: [
          'Set browser-specific navigation timeouts via Playwright config projects',
          'Optimize landing-page assets for mobile (responsive images, lazy-loading)',
        ],
        suggestedFix: fix('Raise the navigation timeout for this profile while the asset weight is addressed.'),
        thinkingChunks: [
          'The error is a **navigation timeout** (page.goto), so this is about page load, not an element.\n\n',
          `It only shows up on ${browsersSentence(ev)} — a browser-specific signal, which argues against a universal app bug.\n\n`,
          `The SCM diff has ${suspectLine}, adding a large hero image. That inflates load weight on mobile.\n\n`,
          `Recurrence is ${runs}, consistent with a slow-but-not-always-over-the-line load on variable CI networks. Concluding: infrastructure.\n\n`,
        ],
      };

    case 'http-500':
      return {
        category: 'app-bug',
        confidence: 'high',
        confidenceScore: 90,
        severity: 'blocker',
        affectedArea: area,
        summary: `The endpoint returns HTTP 500 instead of the expected status — a server-side regression in the login handler.`,
        rootCause: `The assertion fails because the endpoint responds 500. ${suspect ? `${suspectLine} changed credential verification to return null instead of throwing, and the login handler then dereferences a null user → unhandled exception → 500.` : 'An unhandled exception in the handler produces a 500 on the affected path.'}`,
        hypotheses: [
          {
            category: 'app-bug',
            likelihood: 90,
            rootCause:
              'The login handler dereferences a null user after the auth refactor, throwing and returning 500.',
            evidence: [
              'Expected vs Received shows a 500 where 200 was expected [executionError]',
              'Backend logs show an unhandled exception on the request [serverLogs]',
              `The auth refactor commit changed the null-user path [scmInvestigation]`,
            ],
          },
        ],
        evidence: [
          `Received 500 across ${tests} auth test(s) [executionError]`,
          'Server logs capture the 5xx and stack on the failing request [serverLogs]',
          `Started after ${suspectLine} [scmInvestigation]`,
        ],
        investigationSteps: [
          'Inspect the server stack trace behind the 500 on the login route',
          'Confirm the null-user branch in the refactored handler',
        ],
        preventionTips: [
          'Add integration tests exercising the auth endpoint with missing/invalid users',
          'Add error monitoring on 5xx responses for the auth route',
        ],
        suggestedFix: fix(
          'Guard the failing path server-side so the endpoint returns a proper 4xx instead of throwing.',
        ),
        thinkingChunks: [
          'The assertion compares status codes — Expected 200, Received 500. A 500 is server-side, so this is very likely an app bug, not a test bug.\n\n',
          'The backend server logs on the failing request show an unhandled exception, not a timeout — confirming a thrown error.\n\n',
          `The SCM diff points at ${suspectLine}: verifyCredentials now returns null instead of throwing, and the handler still reads user.id.\n\n`,
          `That null dereference is the 500. Recurrence is ${runs}. High confidence: app-bug in the login handler. Writing the fix.\n\n`,
        ],
      };

    case 'strict-mode':
      return {
        category: 'test-flakiness',
        confidence: 'medium',
        confidenceScore: 66,
        severity: 'medium',
        affectedArea: area,
        summary: `Strict-mode violation: getByRole('button') matches multiple rendered variants, so the unscoped locator is ambiguous.`,
        rootCause: `The component page now renders several button variants side by side, so getByRole('button') resolves to more than one element and Playwright's strict mode throws. ${suspect ? `The variants were added in ${suspectLine}.` : ''} The locator needs scoping.`,
        hypotheses: [
          {
            category: 'test-bug',
            likelihood: 66,
            rootCause:
              "getByRole('button') matches multiple button variants; the locator must be scoped by name or container.",
            evidence: [
              'Strict-mode violation resolving to multiple elements [executionError]',
              'The ARIA snapshot shows several button nodes on the page [ariaSnapshot]',
              'Locator healing offers a scoped, higher-stability alternative [locatorHealing]',
            ],
          },
        ],
        evidence: [
          'Deterministic strict-mode violation, not intermittent [recurrenceFlakiness]',
          'Multiple buttons rendered by design [ariaSnapshot]',
          'A name-scoped locator disambiguates [locatorHealing]',
        ],
        investigationSteps: [
          'Confirm the page intentionally renders multiple button variants',
          'Pick a scoping strategy (name filter or container) with the component owner',
        ],
        preventionTips: [
          'Scope locators to a container when multiple matches are expected',
          'Add data-testid attributes to disambiguate similar components',
        ],
        suggestedFix: fix('Scope the locator with a name filter or container so it matches exactly one element.'),
        thinkingChunks: [
          'The error text says **strict mode violation** — the locator matched more than one element. That is a locator problem, not an app failure.\n\n',
          'The ARIA snapshot confirms several button nodes are present on the page at once.\n\n',
          `This is deterministic (${runs}) — it fails the same way every time, which rules out a race.\n\n`,
          'Locator healing already ranks a name-scoped alternative highest. The fix is to scope the query. Concluding: test-bug / flakiness.\n\n',
        ],
      };

    case 'assertion-mismatch':
      return {
        category: 'app-bug',
        confidence: 'medium',
        confidenceScore: 72,
        severity: 'medium',
        affectedArea: area,
        summary: `The assertion receives a different value than expected — the application state disagrees with what the test (correctly) asserts.`,
        rootCause: `The Expected/Received mismatch is stable, not intermittent, so the application genuinely returns the unexpected value. ${suspect ? `${suspectLine} changed the behavior the assertion covers; ` : ''}the test is doing its job and caught a regression.`,
        hypotheses: [
          {
            category: 'app-bug',
            likelihood: 72,
            rootCause: 'A behavior change shipped: the value the test asserts on is now computed differently.',
            evidence: [
              'Expected vs Received shows a stable, deterministic mismatch [executionError]',
              `Recurs in ${runs} — consistent, not flaky [recurrenceFlakiness]`,
              `The SCM diff touches the code path under test [scmInvestigation]`,
            ],
          },
          {
            category: 'test-bug',
            likelihood: 30,
            rootCause: 'The expected value is stale and the new behavior is intentional.',
            evidence: ['The change may be a deliberate product decision [scmInvestigation]'],
          },
        ],
        evidence: [
          `A deterministic Expected/Received mismatch across ${tests} test(s) [executionError]`,
          `Consistent across ${runs} [recurrenceFlakiness]`,
          `Started after ${suspectLine} [scmInvestigation]`,
        ],
        investigationSteps: [
          'Confirm with the code owner whether the new value is intentional',
          'Bisect against the suspect commit to confirm it flips the assertion',
        ],
        preventionTips: [
          'Assert on user-visible behavior rather than internal defaults where possible',
          'Flag intentional behavior changes in the PR description so expected values get updated together',
        ],
        suggestedFix: fix(
          'Update the application (or the expected value, if the change was intentional) so the assertion and behavior agree.',
        ),
        thinkingChunks: [
          'Expected vs Received disagree the same way on every occurrence — this is deterministic, so not a race.\n\n',
          `Recurrence is ${runs}; a stable mismatch means the app now genuinely returns the other value.\n\n`,
          `The SCM diff has ${suspectLine} touching exactly this code path. The test caught a regression.\n\n`,
          'Concluding app-bug, with a secondary hypothesis that the change was intentional and the expectation is stale.\n\n',
        ],
      };

    case 'stale-locator':
      return {
        category: 'test-bug',
        confidence: 'high',
        confidenceScore: 80,
        severity: 'medium',
        affectedArea: area,
        summary: `The locator no longer matches — the element it targeted was renamed or restructured, and the stored capture confirms the old identity is gone.`,
        rootCause: `The action times out because the locator's target no longer exists under its old name. ${suspect ? `${suspectLine} restructured the markup the locator relied on. ` : ''}The last passing run's captured element attributes no longer appear in the failing page's ARIA snapshot, so this is a rename, not a timing issue.`,
        hypotheses: [
          {
            category: 'test-bug',
            likelihood: 80,
            rootCause:
              'The locator keys on a label/name that was renamed; a structure-anchored locator survives the change.',
            evidence: [
              'The failing ARIA snapshot no longer contains the captured accessible name [ariaSnapshot]',
              'Locator healing flags the name-based alternatives as stale and recommends an anchored one [locatorHealing]',
              `The markup change shipped in ${suspectLine} [scmInvestigation]`,
            ],
          },
          {
            category: 'app-bug',
            likelihood: 25,
            rootCause: 'The field was removed rather than renamed, breaking the user flow itself.',
            evidence: ['The replacement control appears in the failing ARIA snapshot [ariaSnapshot]'],
          },
        ],
        evidence: [
          `The fill/click times out deterministically across ${runs} [recurrenceFlakiness]`,
          'The stored element capture and the failing page disagree on the accessible name [locatorHealing]',
          `Markup restructure in ${suspectLine} [scmInvestigation]`,
        ],
        investigationSteps: [
          "Open the locator-healing panel and compare the captured element with the failing page's ARIA snapshot",
          'Confirm the rename in the suspect commit diff',
        ],
        preventionTips: [
          'Anchor critical-path locators to data-testid wrappers instead of user-visible labels',
          'Run locator capture on every green run so healing always has a fresh baseline',
        ],
        suggestedFix: fix('Re-anchor the locator to a stable attribute that survives the rename.'),
        thinkingChunks: [
          'A fill timeout on a locator that used to work — first question: did the element change, or is the page slow?\n\n',
          'The stored capture from the last passing run has the old accessible name; the failing ARIA snapshot does not contain it anywhere.\n\n',
          `That is a rename, not slowness. ${suspectLine} restructured this exact markup.\n\n`,
          'Locator healing already excludes the stale name-based alternatives and recommends the anchored one. Writing up as a test-side locator fix.\n\n',
        ],
      };

    case 'js-error':
      return {
        category: 'app-bug',
        confidence: 'high',
        confidenceScore: 84,
        severity: 'high',
        affectedArea: area,
        summary: `The page throws an uncaught JavaScript error, so the UI state the test waits for is never reached.`,
        rootCause: `The wait times out because the interaction handler throws before updating the UI. The browser console captured the uncaught exception on every failing run. ${suspect ? `${suspectLine} introduced the code path that now throws.` : ''}`,
        hypotheses: [
          {
            category: 'app-bug',
            likelihood: 84,
            rootCause: 'An uncaught exception in the UI handler prevents the expected state change.',
            evidence: [
              'The console shows the same uncaught TypeError on every failing occurrence [console]',
              'The awaited UI state never appears after the interaction [steps]',
              `The throwing code path changed in ${suspectLine} [scmInvestigation]`,
            ],
          },
          {
            category: 'test-bug',
            likelihood: 15,
            rootCause: 'The test waits on a selector the component never used.',
            evidence: ['The selector matched on prior green runs [recurrenceFlakiness]'],
          },
        ],
        evidence: [
          `An uncaught exception is captured in the browser console on each failure [console]`,
          `The wait then times out across ${tests} test(s) [executionError]`,
          `Recurs in ${runs} [recurrenceFlakiness]`,
        ],
        investigationSteps: [
          'Open the console evidence and map the stack to the interaction handler',
          'Reproduce locally with the console open to confirm the throw precedes the missing UI state',
        ],
        preventionTips: [
          'Fail tests fast on uncaught page errors (page.on("pageerror")) so the root cause surfaces directly',
          'Add a unit test around the throwing handler',
        ],
        suggestedFix: fix('Fix the throwing handler so the interaction completes and the awaited state appears.'),
        thinkingChunks: [
          'The wait timed out — but the console evidence is more interesting: an uncaught TypeError fires right after the interaction.\n\n',
          'If the handler throws, the UI state the test waits for can never appear. The timeout is a symptom, not the cause.\n\n',
          `${suspectLine} refactored exactly this handler.\n\n`,
          'High confidence app-bug: fix the throw, the wait resolves. Writing it up.\n\n',
        ],
      };

    case 'crash':
      return {
        category: 'infrastructure',
        confidence: 'medium',
        confidenceScore: 68,
        severity: 'high',
        affectedArea: area,
        summary: `The page (or browser) is gone mid-action — the target closed before the interaction completed, which on this profile points at a renderer crash.`,
        rootCause: `The action fails with a closed-target error, not a timeout: the renderer died mid-test. ${suspect ? `${suspectLine} added work that allocates far more memory on high-DPR devices, ` : 'A recent change increased page memory pressure, '}which is consistent with the mobile profile's renderer being killed.`,
        hypotheses: [
          {
            category: 'infrastructure',
            likelihood: 68,
            rootCause: 'The renderer is killed under memory pressure on the emulated device profile.',
            evidence: [
              'The error is a closed-target, not a timeout or assertion [executionError]',
              `Only the mobile profile is affected — ${browsersSentence(ev)} [browserDistribution]`,
              'No console/page evidence survives the crash — the page is gone [console]',
            ],
          },
          {
            category: 'app-bug',
            likelihood: 45,
            rootCause: 'A page allocation (canvas/media) exceeds what the device profile can hold.',
            evidence: [`${suspectLine} added a large allocation on this page [scmInvestigation]`],
          },
        ],
        evidence: [
          `Closed-target error mid-action across ${tests} test(s) [executionError]`,
          `Recurs in ${runs}, only on ${browsersSentence(ev)} [browserDistribution]`,
          'No post-crash artifacts (screenshot/ARIA/console) — consistent with a renderer kill [console]',
        ],
        investigationSteps: [
          'Check CI worker memory limits for the mobile profile',
          'Profile page memory around the suspect allocation on a 3× DPR viewport',
        ],
        preventionTips: [
          'Cap canvas/media allocations by the visible viewport rather than the document size',
          'Alert on renderer crashes separately from test failures',
        ],
        suggestedFix: fix('Reduce the page allocation that overwhelms the emulated device renderer.'),
        thinkingChunks: [
          'The error is "Target page, context or browser has been closed" — the page died mid-action. That is a crash, not a slow page.\n\n',
          `It only happens on ${browsersSentence(ev)} — device-profile specific.\n\n`,
          'There are no post-failure artifacts at all (no screenshot, no ARIA, no console) — the renderer was killed before capture could run.\n\n',
          `${suspectLine} allocates a full-document canvas; at 3× DPR that is enormous. Concluding: memory-pressure crash.\n\n`,
        ],
      };

    case 'env-visibility':
      return {
        category: 'app-bug',
        confidence: 'high',
        confidenceScore: 79,
        severity: 'medium',
        affectedArea: area,
        summary: `The element exists but is hidden — and only in one browser environment. The environment diff isolates the variable: color scheme.`,
        rootCause: `The visibility assertion fails only on runs whose browser profile differs from the last passing baseline — same project, different color scheme. ${suspect ? `${suspectLine} hides this control under the dark theme, ` : 'A theme-specific style hides the control, '}so the failure tracks the environment, not the code path.`,
        hypotheses: [
          {
            category: 'app-bug',
            likelihood: 79,
            rootCause: 'A dark-scheme style hides the control; light-scheme runs keep passing.',
            evidence: [
              'The element resolves but reports hidden [executionError]',
              'The environment diff vs the last pass shows only the color scheme changed [environmentDiff]',
              `The dark-theme style change shipped in ${suspectLine} [scmInvestigation]`,
            ],
          },
          {
            category: 'environment',
            likelihood: 25,
            rootCause: 'The CI profile rollout (new Playwright + dark scheme) changed rendering behavior.',
            evidence: ['The failing runs also carry a newer Playwright version [environmentDiff]'],
          },
        ],
        evidence: [
          'The locator resolves to the element, but it is hidden [executionError]',
          'Environment diff vs last pass: color scheme (and Playwright version) changed [environmentDiff]',
          `Dark-theme CSS change in ${suspectLine} [scmInvestigation]`,
        ],
        investigationSteps: [
          'Re-run the test with colorScheme: "light" to confirm the environment dependency',
          'Audit the dark-theme stylesheet for display/visibility overrides on secondary actions',
        ],
        preventionTips: [
          'Run visual/interaction tests on both color schemes for critical controls',
          'Lint theme stylesheets for visibility:hidden on interactive elements',
        ],
        suggestedFix: fix('Make the control visible under the dark scheme instead of hiding it.'),
        thinkingChunks: [
          'The element is found but hidden — so this is styling, not a missing element.\n\n',
          'The environment diff is the key evidence: the failing runs differ from the passing baseline only by color scheme (plus a Playwright bump).\n\n',
          `${suspectLine} is a dark-theme pass that touches exactly this control's styles.\n\n`,
          'Environment-conditional app bug: hidden in dark mode. Recommending the style fix and a two-scheme test matrix.\n\n',
        ],
      };

    default:
      return {
        category: 'unknown',
        confidence: 'low',
        confidenceScore: 45,
        severity: 'medium',
        affectedArea: area,
        summary: `${firstTest(ev)} fails, but the available evidence is not conclusive about the root cause.`,
        rootCause:
          'The failure signature does not match a known pattern with high confidence. More evidence (trace, server logs, or a baseline diff) would narrow it down.',
        hypotheses: [
          {
            category: 'unknown',
            likelihood: 45,
            rootCause: 'Insufficient evidence to assign a confident category.',
            evidence: [`Recurs in ${runs} [recurrenceFlakiness]`],
          },
        ],
        evidence: [`Failure recurs in ${runs} [recurrenceFlakiness]`, 'Error signature is unmatched [executionError]'],
        investigationSteps: [
          'Enable trace recording to capture the failing action',
          'Pin a baseline commit to fetch the SCM diff',
        ],
        preventionTips: ['Capture traces and server logs on failure for richer diagnosis'],
        suggestedFix: {
          description: 'Gather a trace and re-run diagnosis with a pinned baseline.',
          file: null,
          code: null,
          patch: null,
        },
        thinkingChunks: [
          'The error signature does not match a known template cleanly.\n\n',
          `Recurrence is ${runs}. Without a trace or a baseline diff I cannot assign high confidence.\n\n`,
          'Reporting a low-confidence result and the evidence that would sharpen it.\n\n',
        ],
      };
  }
}

/** Build a full diagnosis details payload + top-level fields from a cluster's evidence. */
async function generateDiagnosis(
  clusterId: number,
  opts: { additionalContext?: string | null; selectedCommitShas?: string[] | null },
) {
  const db = await getDemoDb();
  const ev = await collectClusterEvidence(db, clusterId);
  if (!ev) throw demoHttpError(404, `Cluster ${clusterId} not found`);

  const story = storyByClusterId(clusterId);
  const kind = diagnosisKind(ev.cluster.errorType, ev.cluster.sampleError, story);
  const script = buildScript(kind, ev, story);

  const proj = getDemoScmProject(ev.cluster.projectId);
  const autoSelectedCommits = story ? [story.suspectSha] : (proj?.suspectShas.slice(0, 3) ?? []);

  // Validate the suggested patch for real against the seeded source files.
  const sourceFiles = new Map((proj?.sourceFiles ?? []).map((f) => [f.path, f.content] as const));
  const patchValidation = script.suggestedFix.patch ? validatePatch(script.suggestedFix.patch, sourceFiles) : null;

  // Realistic two-stage pipeline token accounting.
  const baseInput = 900 + ev.affectedTests.length * 120 + (ev.rep ? 400 : 0);
  const pipeline = [
    {
      role: 'research',
      model: 'demo-research',
      inputTokens: Math.round(baseInput * 0.6),
      outputTokens: 180,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    {
      role: 'diagnosis',
      model: DEMO_MODEL,
      inputTokens: baseInput,
      outputTokens: 320 + script.hypotheses.length * 40,
      cacheCreationInputTokens: Math.round(baseInput * 0.4),
      cacheReadInputTokens: Math.round(baseInput * 0.5),
    },
  ];
  const inputTokens = pipeline.reduce((s, p) => s + p.inputTokens, 0);
  const outputTokens = pipeline.reduce((s, p) => s + p.outputTokens, 0);

  const details = {
    confidenceScore: script.confidenceScore,
    severity: script.severity,
    affectedArea: script.affectedArea,
    hypotheses: script.hypotheses,
    evidence: script.evidence,
    suggestedFix: script.suggestedFix,
    preventionTips: script.preventionTips,
    investigationSteps: script.investigationSteps,
    pipeline,
    autoSelectedCommits,
    selectedCommitShas: opts.selectedCommitShas ?? null,
    additionalContext: opts.additionalContext ?? null,
    patchValidation,
  };

  return {
    ev,
    thinkingChunks: script.thinkingChunks,
    row: {
      category: script.category,
      confidence: script.confidence,
      summary: script.summary,
      rootCause: script.rootCause,
      details,
      inputTokens,
      outputTokens,
    },
  };
}

// ── Persistence helpers ──────────────────────────────────────────────────────

/** Snapshot the current cluster diagnosis into the version history, then delete it. */
async function snapshotAndClear(db: Awaited<ReturnType<typeof getDemoDb>>, clusterId: number): Promise<void> {
  const [existing] = await db.select().from(failureDiagnoses).where(eq(failureDiagnoses.clusterId, clusterId)).limit(1);
  if (!existing) return;
  await db.insert(failureDiagnosisVersions).values(buildDiagnosisVersionValues(existing, new Date()));
  await db.delete(failureDiagnoses).where(eq(failureDiagnoses.id, existing.id));
}

/**
 * Store a generated diagnosis and send `diagnosis.completed` like the server:
 * about the diagnosed cluster, or the cluster of the diagnosed execution
 * (`eventClusterId`), opening the execution; none for a failure in no cluster.
 */
async function persistDiagnosis(
  clusterId: number | null,
  gen: Awaited<ReturnType<typeof generateDiagnosis>>,
  scope: 'cluster' | 'execution' = 'cluster',
  testRunsCaseId: number | null = null,
  eventClusterId: number | null = clusterId,
): Promise<FailureDiagnosis> {
  const db = await getDemoDb();
  const now = new Date();
  const durationMs = 1800 + gen.thinkingChunks.reduce((s, c) => s + c.length, 0);
  const [saved] = await db
    .insert(failureDiagnoses)
    .values({
      clusterId,
      scope,
      testRunsCaseId,
      status: 'completed',
      provider: 'demo',
      model: DEMO_MODEL,
      category: gen.row.category,
      confidence: gen.row.confidence,
      summary: gen.row.summary,
      rootCause: gen.row.rootCause,
      details: gen.row.details,
      error: null,
      inputTokens: gen.row.inputTokens,
      outputTokens: gen.row.outputTokens,
      durationMs,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  if (eventClusterId != null) {
    const [cluster] = await db
      .select({ projectId: failureClusters.projectId })
      .from(failureClusters)
      .where(eq(failureClusters.id, eventClusterId))
      .limit(1);
    publishDemoNotificationEvent({
      type: 'diagnosis.completed',
      clusterId: eventClusterId,
      ...(scope === 'execution' && testRunsCaseId != null ? { executionId: testRunsCaseId } : {}),
      projectId: cluster?.projectId ?? 0,
      summary: gen.row.summary,
      rootCause: gen.row.rootCause,
      category: gen.row.category,
      confidence: gen.row.confidence,
    });
  }

  return saved!;
}

// ── Endpoints ────────────────────────────────────────────────────────────────

/** POST /api/failure-clusters/:id/diagnose (non-streaming fallback) */
export async function apiDiagnoseCluster(
  clusterId: number,
  body?: Record<string, unknown>,
  query?: URLSearchParams,
): Promise<FailureDiagnosis> {
  const db = await getDemoDb();
  const force = query?.get('force') === 'true';

  // Execution-scoped diagnose targets one test-run-case, mirroring the server's
  // scope branch on the cluster endpoint.
  if (body?.scope === 'execution' && body?.executionId != null) {
    return apiDiagnoseExecution(Number(body.executionId), body, query);
  }

  // Like the server: an existing completed diagnosis is the answer unless the
  // caller forces a re-run (which snapshots the previous one into history).
  if (!force) {
    const [existing] = await db
      .select()
      .from(failureDiagnoses)
      .where(and(eq(failureDiagnoses.clusterId, clusterId), eq(failureDiagnoses.scope, 'cluster')))
      .limit(1);
    if (existing?.status === 'completed') return existing;
  }

  await snapshotAndClear(db, clusterId);
  const gen = await generateDiagnosis(clusterId, {
    additionalContext: (body?.additionalContext as string) ?? null,
    selectedCommitShas: (body?.selectedCommitShas as string[]) ?? null,
  });
  return persistDiagnosis(clusterId, gen);
}

/** POST /api/test-run-cases/:id/diagnose (execution scope) */
export async function apiDiagnoseExecution(
  testRunsCaseId: number,
  body?: Record<string, unknown>,
  query?: URLSearchParams,
): Promise<FailureDiagnosis> {
  const db = await getDemoDb();
  const [trc] = await db
    .select({ clusterId: testRunsCases.failureClusterId, status: testRunsCases.status, error: testRunsCases.error })
    .from(testRunsCases)
    .where(eq(testRunsCases.id, testRunsCaseId));
  if (!trc) throw demoHttpError(404, 'Execution not found');
  if (!hasFailureToDiagnose(trc)) throw demoHttpError(400, 'This test run case did not fail');
  // Every failing demo case belongs to a cluster; ground the diagnosis in that cluster's
  // evidence when present (the common path). If a failure ever had no cluster the diagnose
  // action simply wouldn't fire, so a missing cluster is a hard error, not a silent no-op.
  if (!trc.clusterId) throw demoHttpError(400, 'Execution has no failure to diagnose');

  // Like the server: an existing completed diagnosis is the answer unless the
  // caller forces a re-run, which snapshots and replaces it.
  const [existing] = await db
    .select()
    .from(failureDiagnoses)
    .where(and(eq(failureDiagnoses.testRunsCaseId, testRunsCaseId), eq(failureDiagnoses.scope, 'execution')))
    .limit(1);
  if (existing?.status === 'completed' && query?.get('force') !== 'true') return existing;
  if (existing) {
    await db.insert(failureDiagnosisVersions).values(buildDiagnosisVersionValues(existing, new Date()));
    await db.delete(failureDiagnoses).where(eq(failureDiagnoses.id, existing.id));
  }

  const gen = await generateDiagnosis(trc.clusterId, {
    additionalContext: (body?.additionalContext as string) ?? null,
    selectedCommitShas: (body?.selectedCommitShas as string[]) ?? null,
  });
  // Execution-scoped rows persist a null cluster (mirrors the server + keeps the
  // (cluster_id, scope) unique index from colliding across executions of one cluster).
  return persistDiagnosis(null, gen, 'execution', testRunsCaseId, trc.clusterId);
}

/** How long the simulated research stage lasts before the diagnosis stage streams. */
const RESEARCH_STAGE_MS = 900;

/**
 * POST /api/failure-clusters/:id/diagnose/stream
 *
 * Streams realistic thinking tokens grounded in the cluster's real evidence, then a
 * final structured result. Persists the result to the demo DB so a later GET returns
 * it. `?force=true` snapshots the previous result into the version history first.
 */
export async function apiStreamDiagnoseCluster(
  clusterId: number,
  body?: Record<string, unknown>,
  query?: URLSearchParams,
): Promise<Response> {
  const force = query?.get('force') === 'true';
  const db = await getDemoDb();
  const encoder = new TextEncoder();

  const sse = (stream: ReadableStream) =>
    new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });

  if (force) {
    await snapshotAndClear(db, clusterId);
  } else {
    // If a completed diagnosis already exists, replay it immediately.
    const [existing] = await db
      .select()
      .from(failureDiagnoses)
      .where(eq(failureDiagnoses.clusterId, clusterId))
      .limit(1);
    if (existing?.status === 'completed') {
      return sse(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(diagnosisFrame.result(existing)));
            controller.close();
          },
        }),
      );
    }
  }

  const gen = await generateDiagnosis(clusterId, {
    additionalContext: (body?.additionalContext as string) ?? null,
    selectedCommitShas: (body?.selectedCommitShas as string[]) ?? null,
  });
  const saved = await persistDiagnosis(clusterId, gen);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // The simulated pipeline runs a research stage, then the diagnosis stage.
        controller.enqueue(encoder.encode(diagnosisFrame.stage('research')));
        await new Promise((r) => setTimeout(r, RESEARCH_STAGE_MS));
        controller.enqueue(encoder.encode(diagnosisFrame.stage('diagnosis')));
        for (const chunk of gen.thinkingChunks) {
          controller.enqueue(encoder.encode(diagnosisFrame.thinking(chunk)));
          await new Promise((r) => setTimeout(r, Math.max(300, Math.min(1100, chunk.length * 4))));
        }
        controller.enqueue(encoder.encode(diagnosisFrame.result(saved)));
        controller.close();
      } catch (err) {
        // Mirrors the server's stream endpoint: a failure surfaces as an
        // `error` event instead of silently closing the stream.
        const message = err instanceof Error ? err.message : String(err);
        try {
          controller.enqueue(encoder.encode(diagnosisFrame.error(message)));
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
  });

  return sse(stream);
}

// ── Settings (read-only in demo) ─────────────────────────────────────────────

/** GET /api/settings/ai — presents a read-only, env-managed demo provider. */
export async function apiGetAiSettings() {
  const db = await getDemoDb();
  // SCM is configured only when a seeded/project token actually exists — the
  // canned demo SCM needs no token, so this reads false unless one was stored.
  const scmRows = await db.select({ id: projects.id }).from(projects).where(isNotNull(projects.scmToken)).limit(1);
  const demoRole = {
    provider: 'demo',
    model: DEMO_MODEL,
    baseUrl: null,
    hasApiKey: true,
    reuse: null,
  };
  return {
    roles: { diagnosis: demoRole, research: null, embedding: null, assistant: null },
    autoDiagnose: false,
    hasScmToken: scmRows.length > 0,
    envManaged: true,
    customInstructions: null,
    language: null,
    languageEnvManaged: false,
    canStoreSecrets: true,
    claudeCliAvailable: false,
    codexCliAvailable: false,
  };
}

/** PUT /api/settings/ai — no-op in demo (config is fixed). */
export async function apiPutAiSettings(_body: unknown) {
  return { success: true };
}

/** POST /api/settings/ai/test */
export async function apiTestAiSettings() {
  return {
    success: true as const,
    provider: 'demo',
    model: DEMO_MODEL,
    note: 'Demo provider — diagnoses are simulated from seeded evidence.',
  };
}

/**
 * POST /api/settings/ai/models — the real endpoint calls out to the
 * configured provider's models API; the demo has no real provider (and a
 * browser-side fetch to most providers' model-list endpoints would fail on
 * CORS anyway), so it returns the two canned demo "models" this build
 * actually uses, in the same `ModelInfo[]` shape.
 */
export async function apiListAiModels(_body?: unknown) {
  return {
    models: [
      {
        id: DEMO_MODEL,
        label: 'Demo (simulated)',
        description: 'Generates diagnoses from the seeded cluster evidence — no real model calls in demo mode.',
        contextLength: undefined,
        maxTokens: undefined,
        modalities: undefined,
      },
      {
        id: 'demo-research',
        label: 'Demo research (simulated)',
        description: 'The simulated research stage of the two-stage diagnosis pipeline.',
        contextLength: undefined,
        maxTokens: undefined,
        modalities: undefined,
      },
    ],
  };
}

/** GET /api/settings/ai/limits */
export async function apiGetAiLimits() {
  const db = await getDemoDb();
  const stored = await getAppSetting<Partial<ContextLimits>>(db, CONTEXT_LIMITS_SETTING_KEY);
  return {
    limits: resolveStoredContextLimits(stored),
    defaults: DEFAULT_CONTEXT_LIMITS,
    envManaged: [],
    fields: CONTEXT_LIMIT_FIELDS,
  };
}

/** PUT /api/settings/ai/limits — persisted the same way the server does, minus env precedence. */
export async function apiPutAiLimits(body: unknown) {
  const incoming = (body as { limits?: Partial<Record<keyof ContextLimits, unknown>> } | undefined)?.limits ?? {};
  const db = await getDemoDb();
  const stored = await getAppSetting<Partial<ContextLimits>>(db, CONTEXT_LIMITS_SETTING_KEY);
  const next = mergeContextLimitsUpdate(stored, incoming);
  await setAppSetting(db, CONTEXT_LIMITS_SETTING_KEY, next);
  return {
    limits: resolveStoredContextLimits(next),
    defaults: DEFAULT_CONTEXT_LIMITS,
    envManaged: [],
    fields: CONTEXT_LIMIT_FIELDS,
  };
}

/** GET /api/settings/ai/usage — synthesised from stored demo diagnoses. */
export async function apiGetAiUsage(daysParam?: string | null) {
  const parsed = parseInt(daysParam ?? '30', 10);
  const days = Math.min(365, Math.max(1, Number.isFinite(parsed) ? parsed : 30));
  return getAiUsageSummary(await getDemoDb(), days);
}
