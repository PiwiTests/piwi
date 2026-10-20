/**
 * The label a test is shown under: its title without its external ID when the reporter removed it
 * (`externalId.stripFromTitle`), else its title. The title itself stays whole, for matching and copying.
 */
export function testLabel(test: { title: string; displayTitle?: string | null }): string {
  return test.displayTitle || test.title;
}
