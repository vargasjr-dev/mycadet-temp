import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const LOCAL = { assistantId: "local-1", cloud: "local" } as const;
let selected: typeof LOCAL | null = LOCAL;
let gatewayPath: string | null = "/assistant/__gateway/7830";
const calls: string[] = [];
let exportFails = false;
let toastErrors: string[] = [];

mock.module("@/lib/local-mode", () => ({
  getSelectedAssistant: () => selected,
  hasLocalGateway: () => selected !== null && gatewayPath !== null,
}));

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
    selected = LOCAL;
    gatewayPath = "/assistant/__gateway/7830";
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

  test("without a local daemon it points at the desktop app instead of a button", () => {
    gatewayPath = null;
    renderRow();
    expect(screen.queryByRole("button")).toBeNull();
    screen.getByText(/export from the cadet desktop app/i);
  });
});
