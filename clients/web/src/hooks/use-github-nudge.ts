/**
 * GitHub repo state for the community page.
 *
 * The chat nudge stack is gone; what survives is the star action and the
 * store-backed flag the community page reads.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { CADET_GITHUB_REPOSITORY_URL } from "@mycadet/shared";

import { useNudgeStore } from "@/stores/nudge-store";

/** Minimum account age (ms since first observation) before the nudge is eligible. */
export const GITHUB_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Minimum user messages sent before the nudge is eligible. */
export const GITHUB_MIN_USER_MESSAGES = 5;

export interface GitHubNudgeState {
  /** True iff the user hasn't starred, hasn't dismissed, and meets an engagement gate. */
  bannerShouldShow: boolean;
  /** Open the GitHub repo and persist the "starred" flag. */
  handleStar: () => void;
  /** Persist the "banner dismissed" flag. */
  handleBannerDismiss: () => void;
}

export function useGitHubNudgeState(): GitHubNudgeState {
  const starred = useNudgeStore.use.githubStarred();
  const bannerDismissed = useNudgeStore.use.githubBannerDismissed();
  const firstSeenAt = useNudgeStore.use.githubFirstSeenAt();
  const userMessagesSeen = useNudgeStore.use.githubUserMessagesSeen();

  // --- Age eligibility with timer -------------------------------------------
  const [ageEligible, setAgeEligible] = useState(() => {
    if (firstSeenAt === 0) {
      return false;
    }
    return Date.now() - firstSeenAt >= GITHUB_MIN_AGE_MS;
  });

  useEffect(() => {
    if (firstSeenAt === 0 || ageEligible) {
      return;
    }

    const remaining = GITHUB_MIN_AGE_MS - (Date.now() - firstSeenAt);
    if (remaining <= 0) {
      setAgeEligible(true);
      return;
    }

    const timer = setTimeout(() => setAgeEligible(true), remaining);
    return () => clearTimeout(timer);
  }, [firstSeenAt, ageEligible]);

  const messageEligible = userMessagesSeen >= GITHUB_MIN_USER_MESSAGES;
  const engagementMet = ageEligible || messageEligible;

  const handleStar = useCallback(() => {
    openGitHubRepo();
    useNudgeStore.getState().markGitHubStarred();
  }, []);

  const handleBannerDismiss = useCallback(() => {
    useNudgeStore.getState().dismissGitHubBanner();
  }, []);

  // Stable identity: consumers feed this into `useMemo` deps that build
  // banner elements. See docs/CONVENTIONS.md, "Never key an effect on a
  // ReactNode prop".
  return useMemo(
    () => ({
      bannerShouldShow: !starred && !bannerDismissed && engagementMet,
      handleStar,
      handleBannerDismiss,
    }),
    [starred, bannerDismissed, engagementMet, handleStar, handleBannerDismiss],
  );
}

export function openGitHubRepo(): void {
  window.open(CADET_GITHUB_REPOSITORY_URL, "_blank", "noopener,noreferrer");
}
