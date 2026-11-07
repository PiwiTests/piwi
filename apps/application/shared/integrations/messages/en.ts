/**
 * English copy for everything Piwi authors in a ticket — the single source of
 * the English strings, so no English literal is left in the builders. `fr.ts`
 * mirrors these keys exactly (a parity test enforces it); another language is
 * one more file next to these.
 *
 * A value is either a plain string (with `{name}` placeholders) or a set of
 * plural forms selected by `Intl.PluralRules` on the `count` param.
 */

/** A message value: a string, or plural forms keyed by CLDR category. */
export type PluralForms = {
  zero?: string;
  one: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};
export type MessageValue = string | PluralForms;

export const en = {
  // Section headings
  'section.whatHappened': 'What happened',
  'section.mostLikely': 'Most likely',
  'section.evidence': 'Evidence',
  'section.whatToDo': 'What to do',
  'section.links': 'Links',
  'section.affectedTests': { one: '{count} affected test', other: '{count} affected tests' },

  // Fact labels
  'fact.errorType': 'Error type',
  'fact.firstSeen': 'First seen',
  'fact.lastSeen': 'Last seen',
  'fact.occurrences': 'Occurrences',
  'fact.branches': { one: 'Branch', other: 'Branches' },
  'fact.environments': { one: 'Environment', other: 'Environments' },
  'fact.commit': 'Latest commit',
  'value.inRuns': { one: '{occurrences} in {count} run', other: '{occurrences} in {count} runs' },

  // Affected-tests table headers
  'table.test': 'Test',
  'table.file': 'File',
  'table.owner': 'Owner',
  'table.failures': 'Failures',
  'text.moreTests': { one: '…and {count} more test.', other: '…and {count} more tests.' },
  'text.moreClusters': { one: '…and {count} more failure cluster.', other: '…and {count} more failure clusters.' },

  // Inline labels
  'label.rootCause': 'Root cause',
  'label.failingLocator': 'Failing locator',
  'label.verify': 'Verify',
  'label.reproduce': 'Reproduce',
  'label.category': 'Category',

  // Diagnosis categories and confidence
  'category.app-bug': 'Application bug',
  'category.test-bug': 'Test bug',
  'category.flaky-test': 'Flaky test',
  'category.infrastructure': 'Infrastructure',
  'category.environment': 'Environment',
  'confidence.high': 'high confidence',
  'confidence.medium': 'medium confidence',
  'confidence.low': 'low confidence',

  // Related issues
  'section.related': 'Related issues',
  'related.fixedBefore': 'the same kind of failure, fixed before',

  // An issue filed by a rule, not a person
  'count.occurrences': { one: '{count} occurrence', other: '{count} occurrences' },
  'count.runs': { one: '{count} run', other: '{count} runs' },
  'auto.filed': 'Filed automatically by Piwi after {occurrences} in {runs} since {since}.',
  'auto.filed.noDate': 'Filed automatically by Piwi after {occurrences} in {runs}.',
  'auto.countedOn': 'Counted on {where}.',
  'auto.countedIn': {
    one: 'Counted in the {where} environment.',
    other: 'Counted in the {where} environments.',
  },

  // Link labels
  'link.cluster': 'Failure cluster',
  'link.execution': 'Latest execution',
  'link.run': 'Run',
  'link.share': 'Shareable report',
  'link.dashboard': 'Open in Piwi',
  'link.bugReport': 'Bug report in Piwi',

  // Bug reports (a ticket filed from a report sent from Piwi Picker)
  'section.stepsToReproduce': 'Steps to reproduce',
  'section.expectedActual': 'Expected and actual',
  'section.failingTest': 'The failing test',
  'section.reproductions': 'Reproductions',
  'section.missedBy': 'Why the suite missed it',
  'label.expected': 'Expected',
  'label.actual': 'The page showed',
  'label.note': 'Note',
  'fact.page': 'Page',
  'fact.browser': 'Browser',
  'fact.reportedBy': 'Reported by',
  'fact.reportedOn': 'Reported on',
  'evidence.screenshots': {
    one: '{count} screenshot, attached to this ticket',
    other: '{count} screenshots, attached to this ticket',
  },
  'evidence.console': { one: '{count} console error or warning', other: '{count} console errors and warnings' },
  'evidence.requests': { one: '{count} failed request', other: '{count} failed requests' },
  'text.reportLanguage':
    'Reported in {language}. The steps are written again in the language of this ticket; the title, the note and the values typed by the reporter stay as they were written.',
  'text.failingTest':
    'Commit it as {path}. Marked test.fail(), it keeps the suite green while the bug exists; once it passes, the bug looks fixed.',
  'verdict.reproduced': 'Reproduced',
  'verdict.notReproduced': 'Not reproduced',
  'verdict.diverged': 'Could not reach the bug (step {step})',
  'reproduction.replay': 'replayed in a browser',
  'reproduction.desktop': 'run with Playwright',
  'comment.bugLooksFixed':
    'The test of this bug passed in run #{run} while still marked test.fail(): the bug looks fixed. Remove test.fail() with the fix.',

  // Policy comments (written back to the ticket in its language)
  'comment.fixLanded': 'Fix landed in run #{run} (commit {commit}, {verification}) — every affected test passed.',
  'comment.fixLanded.noCommit': 'Fix landed in run #{run} ({verification}) — every affected test passed.',
  'verification.diagnosisVerified': 'diagnosis-verified',
  'verification.stoppedFailing': 'stopped failing',
  'comment.regressed': 'Regressed in run #{run} — the fix did not hold.',
  'comment.stillFailing': {
    one: 'Still failing — +{count} occurrence in {runs} since the last note, latest run #{latest}.',
    other: 'Still failing — +{count} occurrences in {runs} since the last note, latest run #{latest}.',
  },
  'comment.lastFailureOn': 'Latest failure on {where}.',
  'comment.lastFailureIn': 'Latest failure in the {where} environment.',
  'comment.newTests': {
    one: 'Now also failing in {count} more test:',
    other: 'Now also failing in {count} more tests:',
  },
  'comment.newBranches': { one: 'Now failing on a new branch: {list}.', other: 'Now failing on new branches: {list}.' },
  'comment.newEnvironments': {
    one: 'Now failing in a new environment: {list}.',
    other: 'Now failing in new environments: {list}.',
  },
  'comment.diagnosis': 'Piwi diagnosed this failure:',
  'comment.mergedInto': 'This failure was merged into {key} — tracking continues there.',
  'comment.absorbed': 'Absorbed {key} into this issue — its failures are tracked here now.',
  // An issue a person files, with their comment, for a run or one execution
  'section.comment': 'Comment',
  'section.commentFrom': 'Comment from {name}',
  'section.theRun': 'The run',
  'section.tests': { one: '{count} test', other: '{count} tests' },
  'section.failureClusters': { one: '{count} failure cluster', other: '{count} failure clusters' },
  'fact.project': 'Project',
  'fact.branch': 'Branch',
  'fact.commit.run': 'Commit',
  'fact.environment': 'Environment',
  'fact.startedAt': 'Started',
  'fact.results': 'Results',
  'value.runResults': '{passed} passed, {failed} failed, {flaky} flaky, {skipped} skipped, of {total}',
  'table.project': 'Project',
  'table.result': 'Result',
  'result.passed': 'Passed',
  'result.failed': 'Failed',
  'result.timedOut': 'Timed out',
  'result.flaky': 'Flaky',
  'result.skipped': 'Skipped',
  'result.interrupted': 'Interrupted',
  'result.didNotRun': 'Did not run',
  'link.thisExecution': 'This execution',
  'text.filedBy': 'Filed by {name} from Piwi.',
  'text.filedFromPiwi': 'Filed from Piwi.',
  'title.run': 'Run #{id}',
  'title.failedOf': '{failed} of {total} failed',
  'title.onBranch': 'on {branch}',
  'comment.addedFrom': 'Comment added from Piwi on {where}.',
} satisfies Record<string, MessageValue>;

/** Every message key; `fr.ts` must supply exactly these. */
export type MessageKey = keyof typeof en;
