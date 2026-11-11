/**
 * What the run's results sync panel says of an upload whose outcome is unknown: the status line, and what to do next
 * for a reader who can send the results again and for one who cannot. Only the next step names the test run.
 */
export function outcomeUnknownLines(runName: string | null, canSendAgain: boolean): { status: string; next: string } {
  const named = runName ? ` “${runName}”` : '';
  return {
    status: 'Outcome unknown: the upload may have reached the tool.',
    next: canSendAgain
      ? `Sync again looks there for the test run${named} first and links it when it exists.`
      : `Check there for the test run${named}. A project Maintainer can send the results again.`,
  };
}
