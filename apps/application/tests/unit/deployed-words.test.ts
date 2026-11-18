import { describe, expect, test } from 'vitest';
import {
  changeCoverageDeployedNote,
  deployedCommitSource,
  deployText,
  firstFailingDeploySentence,
  sameDeployedCommit,
} from '#shared/deployed-words';
import { suspectLinesContext, suspectLinesDeployedNote, unavailableSuspectLines } from '#shared/suspect-lines';
import { renderChangeCoverage, type PrChangeCoverage } from '#shared/pr-feedback';

describe("a deployed environment's facts in words", () => {
  test('a commit, short or full, names the same commit', () => {
    expect(sameDeployedCommit('a1b2c3d', 'A1B2C3D4E5')).toBe(true);
    expect(sameDeployedCommit('a1b2c3d', 'b1b2c3d')).toBe(false);
    expect(sameDeployedCommit(null, 'a1b2c3d')).toBe(false);
  });

  test('where a deployed commit comes from, and a deploy marker', () => {
    expect(deployedCommitSource({ source: 'server', origin: 'https://staging.shop.test' })).toBe(
      'reported by https://staging.shop.test',
    );
    expect(deployedCommitSource({ source: 'marker', markerLabel: 'Deploy 42' })).toBe(
      'from the deploy marker Deploy 42',
    );
    expect(deployText({ label: 'Deploy 42', commit: 'b2c3d4e5f6' })).toBe('Deploy 42 (b2c3d4e)');
    expect(deployText({ label: 'Deployed b2c3d4e', commit: 'b2c3d4e5f6' })).toBe('Deployed b2c3d4e');
  });

  test("a cluster's first failing deploy, none since the last pass, or no pass to count from", () => {
    const facts = {
      environment: { name: 'Staging' },
      deploys: [
        { label: 'Deploy 41', commit: 'a1b2c3d4' },
        { label: 'Deploy 42', commit: 'b2c3d4e5' },
      ],
      more: false,
      lastPassingRunId: 7,
    };
    expect(firstFailingDeploySentence(facts)).toBe(
      'First failing deploy: Deploy 42 (b2c3d4e) to Staging, the latest of 2 since the last pass',
    );
    expect(firstFailingDeploySentence({ ...facts, deploys: facts.deploys.slice(1) })).toBe(
      'First failing deploy: Deploy 42 (b2c3d4e) to Staging',
    );
    expect(firstFailingDeploySentence({ ...facts, deploys: [] })).toBe('No deploy of Staging since the last pass');
    expect(firstFailingDeploySentence({ ...facts, lastPassingRunId: null })).toBeNull();
  });

  test('change coverage says what a deployed run reached, unless it ran the head', () => {
    expect(
      changeCoverageDeployedNote({ environment: 'Staging', commit: 'b2c3d4e5', headSha: 'b2c3d4e5f6' }),
    ).toBeNull();
    expect(changeCoverageDeployedNote({ environment: 'Staging', commit: 'b2c3d4e5', headSha: 'ffff000' })).toContain(
      'deployed at b2c3d4e',
    );
    expect(changeCoverageDeployedNote({ environment: 'Staging', commit: null, headSha: 'ffff000' })).toContain(
      'whose deployed version is unknown',
    );
    const section = renderChangeCoverage({
      fileReach: true,
      totalFiles: 1,
      uncoveredFiles: 1,
      reachedFiles: 0,
      notCounted: { notObservable: 0, outOfScope: 0, deleted: 0 },
      ticketCount: 0,
      windowRuns: 30,
      tickets: [
        {
          ticket: null,
          files: [
            { filePath: 'src/cart.ts', additions: 3, deletions: 1, reach: 'unreached', lines: null, gapId: null },
          ],
        },
      ],
      deployedNote:
        'This run tested Staging, deployed at b2c3d4e: what it reached of the application is that version’s.',
    } as PrChangeCoverage);
    expect(section).toContain('This run tested Staging, deployed at b2c3d4e');
  });

  test('suspect lines say whose changes they are for a deployed environment', () => {
    expect(suspectLinesDeployedNote({})).toBeNull();
    expect(suspectLinesDeployedNote({ deployed: { environment: 'Staging', commit: 'b2c3d4e5' } })).toContain(
      'between the deployed commits',
    );
    expect(suspectLinesDeployedNote({ deployed: { environment: 'Staging', commit: null } })).toContain(
      'may differ from the run',
    );
    const answer = {
      ...unavailableSuspectLines('no-changes', { deployed: { environment: 'Staging', commit: null } }),
      available: true,
      runId: 3,
    };
    expect(suspectLinesContext(answer, [], null).markdown).toContain("Staging's deployed version is unknown");
  });
});
