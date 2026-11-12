/** The id of the pass reuse plan a run executed, from its metadata (`piwiPlan`, written by the reporter), or null. */
export function runPlanId(metadata: unknown): number | null {
  const meta = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
  const plan = meta.piwiPlan && typeof meta.piwiPlan === 'object' ? (meta.piwiPlan as Record<string, unknown>) : {};
  return typeof plan.id === 'number' && Number.isInteger(plan.id) && plan.id > 0 ? plan.id : null;
}
