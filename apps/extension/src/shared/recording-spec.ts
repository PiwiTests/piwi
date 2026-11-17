import { renderSpec, type CodegenResult } from '@piwitests/core/codegen';
import { isWrongStep, renderBugSpec, type BugReport } from '@piwitests/core/bug-report';
import type { TestFunctionEntry } from '@piwitests/core/function-match';
import { sessionFromSteps } from '@piwitests/core/steps';

/**
 * The test a recording makes. With a step that says the page was wrong, the
 * report's failing test (`renderBugSpec`); without one, a test that passes,
 * with the addresses as recorded and a URL check after each navigation.
 * `catalog` puts the project's test functions in.
 */
export function recordingSpec(report: BugReport, catalog: TestFunctionEntry[] = []): CodegenResult {
  if (report.steps.steps.some(isWrongStep)) return renderBugSpec(report, { catalog });
  return renderSpec(sessionFromSteps(report.steps), {
    catalog,
    urlChecks: true,
    title: report.steps.title ?? undefined,
  });
}
