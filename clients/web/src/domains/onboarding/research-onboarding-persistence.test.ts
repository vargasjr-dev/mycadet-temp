/**
 * Tests for the research-onboarding resume persistence: the round-trip
 * read/write/clear contract (assistant-scoped key, privacy-mode tolerance) and the
 * resolveResumeStep routing — jump to suggestions once research finished,
 * otherwise resume where we were.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearResearchSnapshot,
  readResearchSnapshot,
  resolveResumeStep,
  writeResearchSnapshot,
  type ResearchOnboardingSnapshot,
} from "@/domains/onboarding/research-onboarding-persistence";

const ASSISTANT = "user-123";

function baseSnapshot(
  overrides: Partial<ResearchOnboardingSnapshot> = {},
): ResearchOnboardingSnapshot {
  return {
    step: "looking",
    formValues: {
      firstName: "Ada",
      lastName: "Lovelace",
      role: "Engineer",
      hobbies: ["chess"],
    },
    faceValues: null,
        research: null,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("read/write/clear round-trip", () => {
  test("writes then reads back the same snapshot", () => {
    const snapshot = baseSnapshot();
    writeResearchSnapshot(ASSISTANT, snapshot);
    expect(readResearchSnapshot(ASSISTANT)).toEqual(snapshot);
  });

  test("returns null when nothing was written", () => {
    expect(readResearchSnapshot(ASSISTANT)).toBeNull();
  });

  test("is assistant-scoped — another assistant can't read this assistant's snapshot", () => {
    writeResearchSnapshot(ASSISTANT, baseSnapshot());
    expect(readResearchSnapshot("someone-else")).toBeNull();
  });

  test("clear removes the snapshot", () => {
    writeResearchSnapshot(ASSISTANT, baseSnapshot());
    clearResearchSnapshot(ASSISTANT);
    expect(readResearchSnapshot(ASSISTANT)).toBeNull();
  });

  test("a null assistant id is a no-op for read/write/clear (never throws)", () => {
    expect(() => writeResearchSnapshot(null, baseSnapshot())).not.toThrow();
    expect(readResearchSnapshot(null)).toBeNull();
    expect(() => clearResearchSnapshot(null)).not.toThrow();
  });

  test("malformed stored JSON reads as null rather than throwing", () => {
    localStorage.setItem(`research_onboarding:${ASSISTANT}`, "{not json");
    expect(readResearchSnapshot(ASSISTANT)).toBeNull();
  });

  test("round-trips the research conversation id for mid-search resume", () => {
    const snapshot = baseSnapshot({ researchConversationId: "conv-abc" });
    writeResearchSnapshot(ASSISTANT, snapshot);
    expect(readResearchSnapshot(ASSISTANT)?.researchConversationId).toBe("conv-abc");
  });

  test("round-trips dropped claims and the scrub flag on completed research", () => {
    // Persisted so a refresh that resumes past the results step can still scrub
    // the hidden aggregator-only drops — and only re-fires when the prior
    // session never dispatched the correction (scrub flag absent/false).
    const snapshot = baseSnapshot({
      step: "suggestions",
      research: {
        status: "done",
        claims: [],
        droppedClaims: ["Lives in Dallas"],
        suggestions: [],
        installedPlugins: [],
      },
      droppedClaimsScrubbed: true,
    });
    writeResearchSnapshot(ASSISTANT, snapshot);
    const read = readResearchSnapshot(ASSISTANT);
    expect(read?.research?.droppedClaims).toEqual(["Lives in Dallas"]);
    expect(read?.droppedClaimsScrubbed).toBe(true);
  });
});

describe("Electron host", () => {
  // The desktop app must start onboarding fresh on every launch: reads and
  // writes are no-ops, but clear stays live so completion/retire can still
  // remove a snapshot written by an older build (or the web host).
  const cadetBridge = { platform: "electron" } as unknown as Window["cadet"];

  beforeEach(() => {
    window.cadet = cadetBridge;
  });

  afterEach(() => {
    delete window.cadet;
  });

  test("never writes a snapshot", () => {
    writeResearchSnapshot(ASSISTANT, baseSnapshot());
    expect(localStorage.getItem(`research_onboarding:${ASSISTANT}`)).toBeNull();
  });

  test("never reads a snapshot, even one written by an older build", () => {
    localStorage.setItem(
      `research_onboarding:${ASSISTANT}`,
      JSON.stringify(baseSnapshot()),
    );
    expect(readResearchSnapshot(ASSISTANT)).toBeNull();
  });

  test("clear still removes a stale snapshot", () => {
    localStorage.setItem(
      `research_onboarding:${ASSISTANT}`,
      JSON.stringify(baseSnapshot()),
    );
    clearResearchSnapshot(ASSISTANT);
    expect(localStorage.getItem(`research_onboarding:${ASSISTANT}`)).toBeNull();
  });
});

describe("resolveResumeStep", () => {
  test("jumps straight to suggestions once research finished", () => {
    const snapshot = baseSnapshot({
      step: "results",
      research: {
        status: "done",
        claims: [],
        suggestions: [],
        installedPlugins: [],
      },
    });
    expect(resolveResumeStep(snapshot)).toBe("suggestions");
  });

  test("resumes the saved step mid-flow when research hasn't settled", () => {
    expect(resolveResumeStep(baseSnapshot({ step: "intro" }))).toBe("intro");
  });

  test("skips the research reveal when role and hobbies are both empty", () => {
    const emptyDetails = {
      firstName: "Alice",
      lastName: "Example",
      role: "",
      hobbies: [] as string[],
    };
    expect(
      resolveResumeStep(
        baseSnapshot({ step: "looking", formValues: emptyDetails }),
      ),
    ).toBe("suggestions");
    expect(
      resolveResumeStep(
        baseSnapshot({ step: "results", formValues: emptyDetails }),
      ),
    ).toBe("suggestions");
  });

  test("skips the research reveal when last name is empty", () => {
    expect(
      resolveResumeStep(
        baseSnapshot({
          step: "looking",
          formValues: {
            firstName: "Alice",
            lastName: "",
            role: "Engineer",
            hobbies: ["chess"],
          },
        }),
      ),
    ).toBe("suggestions");
  });
});
