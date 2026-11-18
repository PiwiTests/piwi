/**
 * A deployed environment's facts in words, for the run page, the Changes tab, the failure pages, the AI diagnosis and
 * the bisect: where a deployed commit comes from, a deploy marker, and whether two deployed commits are one. Pure, so
 * the server, the demo and the pages word them one way.
 */
import type { DeployedCommit } from './handlers/deployed-commit';

/** Whether two commits, either one possibly short, name the same commit. */
export function sameDeployedCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left.startsWith(right) || right.startsWith(left);
}

/** Where a deployed commit comes from: "reported by https://staging.shop.test", "from the deploy marker Deploy 42". */
export function deployedCommitSource(commit: Pick<DeployedCommit, 'source' | 'origin' | 'markerLabel'>): string {
  if (commit.source === 'server') return `reported by ${commit.origin ?? 'the server under test'}`;
  return commit.markerLabel ? `from the deploy marker ${commit.markerLabel}` : 'from a deploy marker';
}

/** A deploy marker in words: its label, and its commit when the label does not name it ("v2.4.1 (a1b2c3d)"). */
export function deployText(deploy: { label: string; commit: string | null }): string {
  const short = deploy.commit?.slice(0, 7);
  return short && !deploy.label.includes(short) ? `${deploy.label} (${short})` : deploy.label;
}

/** What `firstFailingDeploySentence` reads of a cluster's first failing deploy. */
export interface FirstFailingDeployFacts {
  environment: { name: string };
  deploys: Array<{ label: string; commit: string | null }>;
  more: boolean;
  lastPassingRunId: number | null;
}

/**
 * A cluster's first failing deploy in a sentence: "First failing deploy: Deploy 42 (a1b2c3d) to Staging", or that no
 * deploy marker of the environment falls since the last pass. Null when the environment has no earlier pass of the
 * cluster's tests to count from.
 */
export function firstFailingDeploySentence(facts: FirstFailingDeployFacts): string | null {
  if (facts.lastPassingRunId == null) return null;
  const name = facts.environment.name;
  const first = facts.deploys.at(-1);
  if (!first) return `No deploy of ${name} since the last pass`;
  const count = facts.deploys.length;
  const of =
    count > 1 || facts.more ? `, the latest of ${facts.more ? 'more than ' : ''}${count} since the last pass` : '';
  return `First failing deploy: ${deployText(first)} to ${name}${of}`;
}

/**
 * What change coverage says of a run of a deployed environment: the run reached the deployed application's lines,
 * which are the head's only when the deployed commit is the head. Null when it is.
 */
export function changeCoverageDeployedNote(input: {
  environment: string;
  /** The run's deployed commit; null when unknown. */
  commit: string | null;
  /** The head of the change. */
  headSha: string | null;
}): string | null {
  if (input.commit && sameDeployedCommit(input.commit, input.headSha)) return null;
  return input.commit
    ? `This run tested ${input.environment}, deployed at ${input.commit.slice(0, 7)}: what it reached of the application is that version's, not this change's.`
    : `This run tested ${input.environment}, whose deployed version is unknown: it may differ from the run's commit, so what it reached of the application may not be this change.`;
}
