import { CoverageReportReader, detectCoverageFormat, type CoverageReportFormat } from '../src/coverage-formats';

/** A report read whole from its text, through the stream reader fed once; null when its format is unknown. */
export function parseCoverageReport(text: string, format?: CoverageReportFormat) {
  const detected = format ?? detectCoverageFormat(text.slice(0, 4096));
  if (!detected) return null;
  const reader = new CoverageReportReader(detected);
  reader.write(text);
  return reader.end();
}
