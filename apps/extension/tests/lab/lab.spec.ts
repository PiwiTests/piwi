import { test, expect } from '@playwright/test';
import { dryRun, LAB, prepareExtension, record, replay, saveResult, stepsOf, type Replay } from './harness.js';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { WILD_SCENARIOS } from './wild.js';

/**
 * One test per scenario: record it with the extension, replay the recording
 * with the extension (`LAB_REPLAYS` times, each in a fresh browser), and write
 * the spec Playwright runs next (`specs.config.ts`). A replay passes when it
 * plays every step and ends on the page the recording ended on. `LAB_DRY=1`
 * only drives each scenario in a plain browser. `LAB_SET` picks the scenarios:
 * `dashboard` (the default, `scenarios.ts`), `wild` (public sites, `wild.ts`)
 * or `all`.
 */

const SETS: Record<string, Scenario[]> = {
  dashboard: SCENARIOS,
  wild: WILD_SCENARIOS,
  all: [...SCENARIOS, ...WILD_SCENARIOS],
};
const chosen = SETS[process.env.LAB_SET ?? 'dashboard'];
if (!chosen) throw new Error(`LAB_SET is one of ${Object.keys(SETS).join(', ')}.`);

// The public sites share no data, so their scenarios may run side by side (`LAB_WORKERS`); the dashboard's may not.
if (!chosen.some((s) => !/^https?:/.test(s.start))) test.describe.configure({ mode: 'parallel' });

test.beforeAll(({}, workerInfo) => {
  if (!LAB.dry) prepareExtension(chosen, workerInfo.workerIndex);
});

for (const scenario of chosen) {
  test(scenario.name, async ({}, testInfo) => {
    test.setTimeout(6 * 60_000);
    if (LAB.dry) {
      testInfo.annotations.push({ type: 'ended on', description: await dryRun(scenario) });
      return;
    }

    const recording = await record(scenario);
    const { doc, lines } = stepsOf(scenario, recording);
    const replays: Replay[] = [];
    for (let run = 0; run < LAB.replays; run++) replays.push(await replay(scenario, doc, run));
    // The first replay that did not pass, or the first: the one the table and the checks below report.
    const replayed =
      replays.find((r) => r.reason != null || r.status !== 'done' || r.endUrl !== recording.endUrl) ?? replays[0]!;
    saveResult(scenario.name, {
      name: scenario.name,
      knownGap: scenario.knownGap ?? null,
      steps: lines,
      recordedEndUrl: recording.endUrl,
      replay: replayed,
      replays,
    });
    testInfo.annotations.push({ type: 'steps', description: lines.join('\n') });
    await testInfo.attach('steps.json', { body: JSON.stringify(doc, null, 2), contentType: 'application/json' });

    if (scenario.knownGap) {
      testInfo.annotations.push({ type: 'known gap', description: scenario.knownGap });
      return;
    }
    if (scenario.hovers != null) {
      const hovers = doc.steps.filter((s) => s.action === 'hover').length;
      expect(hovers, `the recording holds the hovers its clicks depend on:\n${lines.join('\n')}`).toBe(scenario.hovers);
    }
    expect(replayed.reason, `the replay played every step`).toBeNull();
    expect(replayed.status).toBe('done');
    expect(replayed.endUrl, 'the replay ends on the page the recording ended on').toBe(recording.endUrl);
  });
}
