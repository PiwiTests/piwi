import type { LiveStepInfo } from '~/utils/live-steps';

/**
 * The worker's step, when it began after the image the view shows was taken (`frameAt`, 0 for an image that names no
 * time) and is a step of the view's test: a page that does not change sends no image, so the step says where its test
 * is. Both times are wall clocks of the machine the test runs on.
 */
export function stepAfterFrame(
  step: LiveStepInfo | null | undefined,
  frameAt: number,
  test: string,
): LiveStepInfo | null {
  if (!step?.startedAt || !frameAt || step.startedAt <= frameAt) return null;
  return !step.parentTitle || step.parentTitle === test ? step : null;
}
