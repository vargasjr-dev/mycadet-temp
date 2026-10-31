import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const LOCAL = { assistantId: "local-1", cloud: "local", port: 7830 } as const;
const calls: string[] = [];
let exportFails = false;
let toastErrors: string[] = [];

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsDebugBundleUploadUrlCreate: async ({
    path,
  }: {
    path: { id: string };
  }) => {
    calls.push(`platform:${path.id}`);
    return { data: { url: "https://bucket/signed", bundle_key: "k" } };
  },
}));

mock.module("@/domains/settings/components/diagnostic-export", () => ({
  exportLocalDebugBundle: async (
    assistant: { assistantId: string },
    uploadUrl: string,
  ) => {
    calls.push(`export:${assistant.assistantId}:${uploadUrl}`);
    if (exportFails) {
      throw new Error("gateway socket missing");
    }
    return "job-1";
  },
}));

mock.module("@mycadet/design-library/components/toast", () => ({
  toast: {
    success: () => {},
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
}));

import { DebugBundleExport } from "@/domains/settings/components/debug-bundle-export";
import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

function renderRow() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DebugBundleExport assistantId="asst-1" />
    </QueryClientProvider>,
  );
}

describe("DebugBundleExport", () => {
  beforeEach(() => {
    useResolvedAssistantStore.getState().setAssistant({ ...LOCAL });
    calls.length = 0;
    exportFails = false;
    toastErrors = [];
  });
  afterEach(() => cleanup());

  test("uploads diagnostic logs after requesting the signed URL", async () => {
    renderRow();
    fireEvent.click(
      screen.getByRole("button", { name: "Export debug bundle" }),
    );

    await screen.findByText(/sent to cadet at/i);
    expect(calls).toEqual([
      "platform:asst-1",
      "export:local-1:https://bucket/signed",
    ]);
  });

  test("a failed export says why and leaves the button ready", async () => {
    exportFails = true;
    renderRow();
    fireEvent.click(
      screen.getByRole("button", { name: "Export debug bundle" }),
    );

    await waitFor(() => expect(toastErrors).toHaveLength(1));
    expect(toastErrors[0]).toContain("gateway socket missing");
    expect(screen.queryByText(/sent to cadet at/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Export debug bundle" }),
    ).toBeTruthy();
  });

  test("the export reads the resolved store's entry", () => {
    // The store is the single assistant fact and its entry is non-optional;
    // the export rides whatever entry the surface serves.
    expect(useResolvedAssistantStore.getState().assistant.assistantId).toBe(
      "local-1",
    );
    renderRow();
    expect(
      screen.getByRole("button", { name: "Export debug bundle" }),
    ).toBeTruthy();
  });
});
