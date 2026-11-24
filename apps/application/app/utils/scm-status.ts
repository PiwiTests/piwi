/**
 * The "What changed" line of a failure cluster when no diff resolved: what Piwi
 * knows about the commits (the range, the host's compare page, the local `git
 * log`), what it is missing, and what would fill the gap — from the SCM coverage
 * the diagnosis context reports.
 *
 * A gap the configuration fills (no commit or repository recorded, a host Piwi
 * does not read, a host that did not answer) is a setup gap: the same on every
 * cluster of the project, so the line keeps only the range and a help hint.
 */
import { SCM_PROVIDER_LABELS } from '#shared/scm-urls';
import type { DiagnosisContextCoverage } from '~~/types/api';
import type { HelpTopicKey } from '~/utils/help-content';

type ScmCoverage = NonNullable<DiagnosisContextCoverage['scm']>;

export type ScmStatusKind =
  /** A diff resolved: commits or files to show. */
  | 'resolved'
  /** The last passing run tested the same commit. */
  | 'same-commit'
  /** The range was read and no file changed. */
  | 'no-changes'
  /** No passing run to compare with. */
  | 'no-baseline'
  /** A passing run exists, but the runs record no commit. */
  | 'no-commit'
  /** The range is known, but the runs record no repository URL. */
  | 'no-repository'
  /** The repository is on a host Piwi does not read. */
  | 'unsupported-host'
  /** The host did not return the changes: no token, an error, or a linked folder without the commits. */
  | 'fetch-failed'
  /** Nothing is known about the commits. */
  | 'unavailable';

export interface ScmStatus {
  kind: ScmStatusKind;
  /** The clause the line leads with. */
  text: string;
  /** The commit range, `a1b2c3d..e4f5a6b`, when known. */
  range: string | null;
  /** What the range is counted from, `since the last passing run`, when the range is known. */
  origin: string | null;
  /** The configuration fills the gap: the line shows the range and a help hint, no sentence. */
  setupGap: boolean;
  /** The help topic that explains a setup gap. */
  help: HelpTopicKey | null;
  /** What is missing or what to do next, one clause; null when the text says it all. */
  detail: string | null;
  /** The host's own compare page for the range. */
  compare: { url: string; label: string } | null;
  /** The command that lists the range locally. */
  gitCommand: string | null;
  /** A repository access token would let Piwi read the range. */
  needsToken: boolean;
  /** The error the host returned. */
  error: string | null;
  /** The host's error as the line shows it, `GitHub error: Not Found`. */
  errorText: string | null;
}

function hostName(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** What the range is counted from, as a clause: `since the last passing run`. */
function rangeOrigin(scm: ScmCoverage): string {
  if (scm.baselineKind === 'manual') return 'from the baseline you picked';
  // Without a project-wide passing run, a range that is not a picked baseline
  // starts at the last run this test passed in.
  if (scm.baselineKind === 'test-green' || !scm.hasLastGreen) return 'since this test last passed';
  return 'since the last passing run';
}

/** Describe the SCM coverage of a cluster's diagnosis context in one line. */
export function describeScmStatus(scm: ScmCoverage | null | undefined): ScmStatus {
  const base: ScmStatus = {
    kind: 'unavailable',
    text: 'No commit information for this cluster',
    range: null,
    origin: null,
    setupGap: false,
    help: null,
    detail: null,
    compare: null,
    gitCommand: null,
    needsToken: false,
    error: null,
    errorText: null,
  };
  if (!scm) return base;

  const host = scm.provider ? SCM_PROVIDER_LABELS[scm.provider] : null;
  const known: ScmStatus = {
    ...base,
    compare: scm.compareUrl && host ? { url: scm.compareUrl, label: `Compare on ${host}` } : null,
    gitCommand: scm.gitCommand ?? null,
    error: scm.error ?? null,
    errorText: scm.error ? `${host ?? 'Host'} error: ${scm.error}` : null,
  };
  const range = scm.range ? `${scm.range.from}..${scm.range.to}` : null;
  if (range) {
    known.range = range;
    known.origin = rangeOrigin(scm);
  }

  if (scm.filesCount > 0 || scm.commitsCount > 0) {
    return { ...known, kind: 'resolved', text: range ? `${range} ${rangeOrigin(scm)}` : 'Changes found' };
  }

  if (scm.range && scm.range.from === scm.range.to) {
    const when = scm.hasLastGreen ? 'the last passing run' : 'the last run this test passed in';
    return {
      ...known,
      kind: 'same-commit',
      text: `Same commit as ${when} (${scm.range.from})`,
      detail: 'what broke it is not in the code: look at the data, the environment or the test itself',
    };
  }

  if (!scm.hasLastGreen && !scm.baseCommitUsed && !range) {
    return {
      ...known,
      kind: 'no-baseline',
      text: 'No passing run to compare with yet',
      detail: 'pick the last commit you know was good to see what changed since',
    };
  }
  if (!range) {
    return {
      ...known,
      kind: 'no-commit',
      text: 'The runs do not record their commit',
      setupGap: true,
      help: 'cluster.scm-no-commit',
      detail: 'the reporter reads it from the Git checkout the tests run in',
    };
  }

  const text = `${range} ${rangeOrigin(scm)}`;
  if (!scm.repositoryUrl) {
    return {
      ...known,
      kind: 'no-repository',
      text,
      setupGap: true,
      help: 'cluster.scm-no-repository',
      detail: 'the checkout the tests run in has no origin remote, so Piwi cannot list the commits',
    };
  }
  if (!scm.provider) {
    const where = hostName(scm.repositoryUrl) ?? 'This host';
    return {
      ...known,
      kind: 'unsupported-host',
      text,
      setupGap: true,
      help: 'cluster.scm-unsupported-host',
      detail: `${where} is not a host Piwi reads (GitHub, GitLab and Bitbucket are)`,
    };
  }
  if (scm.localGit && !scm.error) {
    return {
      ...known,
      kind: 'fetch-failed',
      text,
      setupGap: true,
      help: 'cluster.scm-fetch-failed',
      detail: 'the folder linked to this project does not have these commits: fetch them there, or add an access token',
      needsToken: !scm.hasToken,
    };
  }
  if (scm.error || !scm.hasToken) {
    const what = scm.error ? `${host} did not return the changes` : `${host} returned no changes`;
    return {
      ...known,
      kind: 'fetch-failed',
      text,
      setupGap: true,
      // With a token set, the host's error is the cause, not a missing token.
      help: scm.hasToken ? 'cluster.scm-host-error' : 'cluster.scm-fetch-failed',
      detail: scm.hasToken ? what : `${what}: a private repository needs an access token`,
      needsToken: !scm.hasToken,
    };
  }
  return { ...known, kind: 'no-changes', text: `No file changed ${rangeOrigin(scm)} (${range})` };
}
