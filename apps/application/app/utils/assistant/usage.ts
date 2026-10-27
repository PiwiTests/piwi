/**
 * What the assistant's limits leave, as the panel shows them under its
 * input: the daily token allowance (the cap that binds first, the user's or
 * the instance's) and, with the Claude Code CLI, the Claude subscription's
 * usage window. One line warns once either is nearly spent, and a spent
 * allowance stops the input from asking: the server would refuse the question.
 */
import type { AssistantStatus, AssistantSubscriptionLimit } from '#shared/assistant';

/** From this share of a limit spent, the panel warns. */
export const ASSISTANT_USAGE_WARNING = 0.8;

/** One limit as the panel shows it. */
export interface AssistantUsageMeter {
  id: 'allowance' | 'subscription';
  label: string;
  /** The share spent, from 0 to 1; null when the limit does not say. */
  share: number | null;
  /** What was spent, in words. */
  detail: string;
  /** When it frees up or resets, in words; null when unknown. */
  resets: string | null;
}

export interface AssistantUsageView {
  meters: AssistantUsageMeter[];
  /** The largest share spent among the meters, for the input's compact gauge; null when none says. */
  peak: number | null;
  /** The line warning that a limit is nearly or wholly spent; null when none is. */
  warning: string | null;
  /** Why the input cannot ask: the allowance is spent; null while it is not. */
  blocked: string | null;
}

/** How a time reads in the panel, as a phrase: "at 14:32", or "on Mon 09:00" when it is not within the next 24 hours. */
export type AssistantTimeFormat = (iso: string) => string;

const WINDOWS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'weekly window',
  seven_day_opus: 'weekly Opus window',
  seven_day_sonnet: 'weekly Sonnet window',
  seven_day_overage_included: 'weekly window',
  overage: 'extra usage',
};

const tokens = (n: number) => n.toLocaleString('en-US');
const percent = (share: number) => `${Math.round(share * 100)}%`;
const clampShare = (share: number) => Math.min(1, Math.max(0, share));

function allowanceMeter(
  allowance: NonNullable<AssistantStatus['allowance']>,
  time: AssistantTimeFormat,
): AssistantUsageMeter {
  return {
    id: 'allowance',
    label: allowance.scope === 'user' ? 'Your daily allowance' : 'This instance’s daily allowance',
    share: allowance.limit > 0 ? clampShare(allowance.used / allowance.limit) : 1,
    detail: `${tokens(allowance.used)} of ${tokens(allowance.limit)} tokens in the last 24 hours`,
    resets:
      allowance.freesAt && allowance.used > 0
        ? `Frees up ${time(allowance.freesAt)}, as earlier answers pass 24 hours`
        : null,
  };
}

function windowName(limit: AssistantSubscriptionLimit): string {
  return (limit.window && WINDOWS[limit.window]) || 'usage window';
}

function subscriptionMeter(limit: AssistantSubscriptionLimit, time: AssistantTimeFormat): AssistantUsageMeter {
  const share = limit.status === 'rejected' ? 1 : limit.utilization === null ? null : clampShare(limit.utilization);
  const spent = {
    allowed: 'Within its limit',
    allowed_warning: 'Nearly spent',
    rejected: 'Spent',
  }[limit.status];
  return {
    id: 'subscription',
    label: `Claude subscription · ${windowName(limit)}`,
    share,
    detail: share === null ? spent : `${percent(share)} used`,
    resets: limit.resetsAt ? `Resets ${time(limit.resetsAt)}` : null,
  };
}

/** The limits of `status` as the panel shows them. */
export function assistantUsageView(status: AssistantStatus | null, time: AssistantTimeFormat): AssistantUsageView {
  const meters: AssistantUsageMeter[] = [];
  let warning: string | null = null;
  let blocked: string | null = null;

  const allowance = status?.allowance;
  if (allowance) {
    const meter = allowanceMeter(allowance, time);
    meters.push(meter);
    const whose = allowance.scope === 'user' ? 'your' : 'this instance’s';
    const frees = allowance.freesAt ? ` It frees up ${time(allowance.freesAt)}.` : '';
    if (allowance.used >= allowance.limit) {
      blocked = `${allowance.scope === 'user' ? 'You reached your' : 'This instance reached its'} daily assistant allowance.${frees}`;
    } else if ((meter.share ?? 0) >= ASSISTANT_USAGE_WARNING) {
      warning = `${percent(meter.share!)} of ${whose} daily assistant allowance is spent.${frees}`;
    }
  }

  const subscription = status?.subscription;
  if (subscription) {
    const meter = subscriptionMeter(subscription, time);
    meters.push(meter);
    const resets = subscription.resetsAt ? ` It resets ${time(subscription.resetsAt)}.` : '';
    const nearly = subscription.status === 'allowed_warning' || (meter.share ?? 0) >= ASSISTANT_USAGE_WARNING;
    if (subscription.status === 'rejected') {
      warning ??= `Your Claude subscription reached the limit of its ${windowName(subscription)}.${resets}`;
    } else if (nearly) {
      const used = meter.share === null ? 'is nearly spent' : `is ${percent(meter.share)} spent`;
      warning ??= `Your Claude subscription’s ${windowName(subscription)} ${used}.${resets}`;
    }
  }

  const shares = meters.map((m) => m.share).filter((share): share is number => share !== null);
  return { meters, peak: shares.length ? Math.max(...shares) : null, warning, blocked };
}

/** A time as the panel says it: "at 14:32", or "on Mon 09:00" when it is not within the next 24 hours. */
export function assistantTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const soon = date.getTime() - now < 24 * 60 * 60 * 1000;
  const time = date.toLocaleString(undefined, {
    ...(soon ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  });
  return soon ? `at ${time}` : `on ${time}`;
}
