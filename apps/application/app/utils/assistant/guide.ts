/** A guide the assistant composed, as the guide engine (`useGuide`) runs it. */
import type { AssistantGuidePlan } from '#shared/assistant';
import { findGuideAnchor } from '#shared/guide-anchors/index.mjs';
import type { GuideRun, GuideWords } from '~/utils/guide/types';

/** The words of a composed guide's popover; the dashboard and its guides speak English. */
export const ASSISTANT_GUIDE_WORDS: GuideWords = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  close: 'End the guide',
  docs: 'Read the docs',
  progress: '{{current}} of {{total}}',
};

/**
 * The guide run of `plan`, named `id` (its popover's `data-guide`): one stop
 * per planned stop, on its registry anchor, with its route, its words and the
 * anchor's docs page. A stop whose anchor this build does not know shows
 * centered.
 */
export function assistantGuideRun(plan: AssistantGuidePlan, id: string): GuideRun {
  return {
    id,
    lang: 'en',
    stops: plan.stops.map((stop, index) => {
      const anchor = findGuideAnchor(stop.anchor);
      return {
        id: `stop-${index + 1}`,
        anchor: anchor?.id,
        route: stop.route,
        title: stop.title,
        body: stop.body,
        doc: anchor?.doc,
      };
    }),
    words: ASSISTANT_GUIDE_WORDS,
  };
}

/** The id of the guide a block of an answer plays: `assistant-<message>-<block>`, or `-<step>` for a checklist step's. */
export function assistantGuideId(messageId: number, blockId: string, stepId?: string): string {
  return ['assistant', messageId, blockId, stepId].filter((part) => part !== undefined).join('-');
}
