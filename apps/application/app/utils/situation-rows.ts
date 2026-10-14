/**
 * The labelled lines of the situation block, in the order the block renders
 * them: the explanation first, then the action, then the context.
 *
 * - **Explanation**: _Most likely_ (the story or the diagnosis) and _Situation_
 *   (the claim a bug report makes).
 * - **Action**: _State_ sits right above _Next_, since the state often says why
 *   the next step is the one offered.
 * - **Context**: the failure's cluster and its ticket first (_Cluster_ on the
 *   execution page, which ends with the ticket; _Issue_ on the cluster page),
 *   then the facts that help read the failure (_Occurrences_, _What changed_,
 *   _The suite_).
 *
 * Every page fills only the lines it has, so one order serves the execution
 * page (Most likely, Next, Cluster, and What changed when its suspect lines are
 * known), the cluster page (Most likely, State, Next, Issue, Occurrences, What
 * changed) and a bug report (Situation, State, Next, The suite).
 */
export const SITUATION_ROWS = [
  { slot: 'story', label: 'Most likely' },
  { slot: 'situation', label: 'Situation' },
  { slot: 'state', label: 'State' },
  { slot: 'next', label: 'Next' },
  { slot: 'cluster', label: 'Cluster' },
  { slot: 'issue', label: 'Issue' },
  { slot: 'occurrences', label: 'Occurrences' },
  { slot: 'whatChanged', label: 'What changed' },
  { slot: 'suite', label: 'The suite' },
] as const;
