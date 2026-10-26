/**
 * Unit tests for `createCloudAssistant` — the primitive behind the tray
 * "New Assistant…" command. It must hatch with `mode: "create"` (so an
 * *additional* assistant is provisioned, not the existing one returned),
 * refresh the lockfile, and switch to the new assistant.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let hatchResult:
  | { ok: true; status: number; data: { id: string } }
  | { ok: false; status: number; error: Record<string, unknown> } = {
  ok: true,
  status: 201,
  data: { id: "ast-new" },
};

const hatchAssistantMock = mock(
  async (_input?: unknown, _mode?: string) => hatchResult,
);
const listAssistantsMock = mock(async () => ({
  ok: true as const,
  status: 200,
  data: [{ id: "ast-new", is_local: false, created: "" }],
}));
const setSelectedAssistantMock = mock(async (_id: string) => {});

mock.module("@/assistant/api", () => ({
  hatchAssistant: hatchAssistantMock,
  listAssistants: listAssistantsMock,
}));
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));
mock.module("@/lib/local-mode", () => ({}));
mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: {
    getState: () => ({ currentOrganizationId: "org-test" }),
  },
}));
mock.module("@/utils/api-errors", () => ({
  extractErrorMessage: (e: unknown, _r: unknown, fallback?: string) =>
    e &&
    typeof e === "object" &&
    typeof (e as { detail?: unknown }).detail === "string"
      ? (e as { detail: string }).detail
      : (fallback ?? "error"),
}));

const { createCloudAssistant } = await import("./create-cloud-assistant");

beforeEach(() => {
  hatchResult = { ok: true, status: 201, data: { id: "ast-new" } };
  hatchAssistantMock.mockClear();
  listAssistantsMock.mockClear();
  setSelectedAssistantMock.mockClear();
});

describe("createCloudAssistant", () => {
  test("hatches with mode=create and switches to the new id", async () => {
    const result = await createCloudAssistant("My Bot");
    expect(hatchAssistantMock).toHaveBeenCalledWith(
      { name: "My Bot" },
      "create",
    );
    expect(setSelectedAssistantMock).toHaveBeenCalledWith("ast-new");
    expect(result).toEqual({ ok: true, id: "ast-new" });
  });

  test("omits the body when no name is given (still mode=create)", async () => {
    await createCloudAssistant();
    expect(hatchAssistantMock).toHaveBeenCalledWith(undefined, "create");
  });

  test("returns an error and does not switch when hatch fails", async () => {
    hatchResult = { ok: false, status: 500, error: { detail: "boom" } };
    const result = await createCloudAssistant("x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("boom");
    }
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });
});
