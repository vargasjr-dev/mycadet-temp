import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  type ProfileDispatchOptions,
  type ProfilePickerEntry,
  type ProfilePickerIssue,
  profilePickerIssue,
  profilePickerLabel,
  undispatchableProfileReason,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import { inferenceProfilesGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useSupportsCompleteProfileSnapshots } from "@/lib/backwards-compat/complete-profile-snapshots";

export interface ProfileOption {
  readonly value: string | null;
  readonly label: string;
  /** Set when the resolver would skip this profile; the view renders it. */
  readonly issue?: ProfilePickerIssue;
  /** Hover copy for an `"undispatchable"` option. */
  readonly reason?: string;
}

export function buildProfileOptions(
  summaries: ReadonlyArray<ProfilePickerEntry>,
  selectedProfile: string | null | undefined,
  options: ProfileDispatchOptions,
): ProfileOption[] {
  // The summaries arrive in the daemon's presentation order, the same one
  // the pickers have always shown.
  const visibleProfiles = visibleProfilesForPicker(
    summaries,
    [selectedProfile],
    options,
  );

  return [
    { value: null, label: "Default" },
    ...visibleProfiles.map((profile) => {
      const issue = profilePickerIssue(profile, summaries, options);
      return {
        value: profile.name,
        label: profilePickerLabel(profile),
        ...(issue ? { issue } : {}),
        ...(issue === "undispatchable"
          ? { reason: undispatchableProfileReason(profile) }
          : {}),
      };
    }),
  ];
}

export function useProfileOptions(
  assistantId: string,
  selectedProfile?: string | null,
): ProfileOption[] {
  const { data: profilesData } = useQuery({
    ...inferenceProfilesGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  });

  const requireOwnProviderAndModel = useSupportsCompleteProfileSnapshots();

  return useMemo(
    () =>
      buildProfileOptions(profilesData?.profiles ?? [], selectedProfile, {
        requireOwnProviderAndModel,
      }),
    [profilesData, selectedProfile, requireOwnProviderAndModel],
  );
}
