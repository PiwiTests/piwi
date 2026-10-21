/**
 * The label a test is shown under: its title without its external ID when the reporter removed it
 * (`externalId.stripFromTitle`), else its title. The title itself stays whole, for matching and copying.
 */
export function testLabel(test: { title: string; displayTitle?: string | null }): string {
  return test.displayTitle || test.title;
}

/**
 * A test as one line of plain text (pull-request comments, notifications, exports): its external ID, then its label
 * (`12526 · Log in with Email`). A title that already holds the ID is not prefixed with it again.
 */
export function testTextLabel(test: {
  title: string;
  displayTitle?: string | null;
  externalId?: string | null;
}): string {
  const label = testLabel(test);
  if (!test.externalId || label.includes(test.externalId)) return label;
  return `${test.externalId} · ${label}`;
}
