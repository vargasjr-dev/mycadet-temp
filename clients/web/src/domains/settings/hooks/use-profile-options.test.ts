import { describe, expect, test } from "bun:test";

import type { ProfilePickerEntry } from "@/assistant/profile-pickers";
import { buildProfileOptions } from "@/domains/settings/hooks/use-profile-options";

// In the daemon's presentation order — `GET /inference/profiles` returns
// the summaries already ordered, so the array order is the display order.
const summaries: ProfilePickerEntry[] = [
  {
    name: "smart",
    label: "Smart",
    provider: "anthropic",
    model: "claude-opus-5",
  },
  {
    name: "fast",
    label: "Fast",
    provider: "anthropic",
    model: "claude-fable-5",
  },
  {
    name: "legacy",
    label: "Legacy",
    status: "disabled",
    provider: "anthropic",
    model: "claude-opus-5",
  },
  // Carries nothing to dispatch with. The resolver skips such a rung, so
  // offering it would produce a selection that silently does nothing.
  { name: "extra" },
];

// 0.10.8+ bakes blank profile fields at write time; older assistants
// live-inherit them, so a sparse profile dispatches there.
const STRICT = { requireOwnProviderAndModel: true } as const;
const LEGACY = { requireOwnProviderAndModel: false } as const;

describe("buildProfileOptions", () => {
  test("keeps the daemon's presentation order, omits what the resolver would skip, and prepends Default", () => {
    expect(buildProfileOptions(summaries, null, STRICT)).toEqual([
      { value: null, label: "Default" },
      { value: "smart", label: "Smart" },
      { value: "fast", label: "Fast" },
    ]);
  });

  test("keeps the selected disabled profile visible", () => {
    expect(buildProfileOptions(summaries, "legacy", STRICT)).toEqual([
      { value: null, label: "Default" },
      { value: "smart", label: "Smart" },
      { value: "fast", label: "Fast" },
      { value: "legacy", label: "Legacy (Disabled)", issue: "disabled" },
    ]);
  });

  // Hiding the current selection would leave the trigger blank with no way
  // back, so it stays and is flagged instead.
  test("keeps a selected undispatchable profile visible and marks the issue", () => {
    expect(buildProfileOptions(summaries, "extra", STRICT)).toEqual([
      { value: null, label: "Default" },
      { value: "smart", label: "Smart" },
      { value: "fast", label: "Fast" },
      {
        value: "extra",
        label: "extra",
        issue: "undispatchable",
        reason: expect.stringContaining("cannot be used"),
      },
    ]);
  });

  test("returns just the Default option when no summaries are loaded", () => {
    expect(buildProfileOptions([], null, STRICT)).toEqual([
      { value: null, label: "Default" },
    ]);
  });
});

describe("buildProfileOptions on a pre-0.10.8 assistant", () => {
  // `extra` carries nothing, which live-inherits there, so it is a normal
  // option rather than being hidden or flagged.
  test("keeps sparse profiles as ordinary options", () => {
    expect(buildProfileOptions(summaries, null, LEGACY)).toEqual([
      { value: null, label: "Default" },
      { value: "smart", label: "Smart" },
      { value: "fast", label: "Fast" },
      { value: "extra", label: "extra" },
    ]);
  });
});
