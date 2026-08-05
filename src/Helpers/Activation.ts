/**
 * Activation — the one number that decides whether this product works.
 *
 * The funnel already tracked `ai_quest_created` as "activation", but creating a
 * quest only proves the AI produced something plausible. It says nothing about
 * whether the plan actually got *followed*, which is the entire thesis:
 *
 *   > does an AI-generated plan survive contact with a real week?
 *
 * So the activation milestone is **the first completed mini-goal**, and the
 * headline metric is the share of a signup cohort that reaches it inside their
 * first week. If that number is low, no amount of marketing or paywall tuning
 * matters — the plans themselves are the problem.
 */

import { User } from "../models/User.js";
import { logEvent } from "./Telemetry.js";
import { logError } from "./Helpers.js";

/** The window a new user gets to reach activation. */
export const ACTIVATION_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Stamp the first completed mini-goal, once.
 *
 * `$exists: false` makes it first-write-wins, so this is safe to call from every
 * path that can complete a mini-goal (there are two) without the value drifting.
 */
export async function stampFirstMiniGoal(userId: string): Promise<void> {
  try {
    const previous = await User.findOneAndUpdate(
      { _id: userId, firstMiniGoalCompletedAt: { $exists: false } },
      { $set: { firstMiniGoalCompletedAt: new Date() } },
      { new: false, projection: "createdAt" }
    ).lean();

    // Already stamped — nothing to record.
    if (!previous) return;

    const signedUpAt = (previous as any).createdAt
      ? new Date((previous as any).createdAt).getTime()
      : null;
    const daysToActivate = signedUpAt
      ? Math.round((Date.now() - signedUpAt) / DAY_MS)
      : null;

    logEvent({
      name: "activated",
      userId,
      props: {
        daysToActivate,
        withinWindow: daysToActivate !== null && daysToActivate <= ACTIVATION_WINDOW_DAYS,
      },
    });
  } catch (error) {
    logError("stampFirstMiniGoal", error);
  }
}

export interface ActivationCohort {
  /** Users who signed up inside the reporting window. */
  cohortSize: number;
  /** Of those, how many ever completed a mini-goal. */
  activated: number;
  /** Of those, how many did it within ACTIVATION_WINDOW_DAYS of signing up. */
  activatedInWindow: number;
  /** activatedInWindow / cohortSize — THE number. */
  weekOneActivationRate: number;
  /** Median days from signup to first completed mini-goal, for those who did. */
  medianDaysToActivate: number | null;
}

/**
 * Cohort activation over the last `days`.
 *
 * Deliberately cohort-based rather than a ratio of two event counts: dividing
 * this month's completions by this month's signups mixes cohorts and flatters
 * the number whenever signups dip. Here every user counted in the denominator
 * had a real chance to activate.
 */
export async function activationCohort(days: number): Promise<ActivationCohort> {
  const empty: ActivationCohort = {
    cohortSize: 0,
    activated: 0,
    activatedInWindow: 0,
    weekOneActivationRate: 0,
    medianDaysToActivate: null,
  };

  try {
    const since = new Date(Date.now() - days * DAY_MS);

    // Only count users who have had the full window to activate; otherwise
    // yesterday's signups drag the rate down for no reason.
    const cutoff = new Date(Date.now() - ACTIVATION_WINDOW_DAYS * DAY_MS);

    const cohort = await User.find({
      createdAt: { $gte: since, $lte: cutoff },
    })
      .select("createdAt firstMiniGoalCompletedAt")
      .lean();

    if (cohort.length === 0) return empty;

    const lags: number[] = [];
    let activated = 0;
    let activatedInWindow = 0;

    for (const u of cohort as any[]) {
      if (!u.firstMiniGoalCompletedAt) continue;
      activated++;
      const lag =
        (new Date(u.firstMiniGoalCompletedAt).getTime() - new Date(u.createdAt).getTime()) / DAY_MS;
      lags.push(lag);
      if (lag <= ACTIVATION_WINDOW_DAYS) activatedInWindow++;
    }

    lags.sort((a, b) => a - b);
    const median =
      lags.length === 0
        ? null
        : Number(
            (lags.length % 2
              ? lags[(lags.length - 1) / 2]
              : (lags[lags.length / 2 - 1] + lags[lags.length / 2]) / 2
            ).toFixed(1)
          );

    return {
      cohortSize: cohort.length,
      activated,
      activatedInWindow,
      weekOneActivationRate: Number((activatedInWindow / cohort.length).toFixed(4)),
      medianDaysToActivate: median,
    };
  } catch (error) {
    logError("activationCohort", error);
    return empty;
  }
}
