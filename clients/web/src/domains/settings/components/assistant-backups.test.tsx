import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";


let exportFails = false;
const calls: string[] = [];
let toastErrors: string[] = [];

mock.module("@/assistant/api", () => ({
  listAssistantBackups: async () => ({ ok: true, status: 200, data: [] }),
  createAssistantBackup: async () => ({ ok: true, status: 201, data: {} }),
  restoreAssistantBackup: async () => ({ ok: true, status: 200, data: {} }),
}));

mock.module("@/domains/settings/teleport/cloud-export", () => ({
  exportBundleFilename: (label: string) => `${label}-2026-10-02.tar.gz`,
  exportManagedBundle: async (
    assistantId: string,
    { onStep }: { onStep?: (step: string) => void } = {},
  ) => {
    calls.push(`export:${assistantId}`);
    onStep?.("exporting");
    if (exportFails) {
      throw new Error("Export failed (HTTP 500).");
    }
    return {
      bundleKey: "uploads/org-abc/bundle.tar.gz",
      runtimeVersion: "1.2.3",
    };
  },
}));

mock.module("@/domains/settings/teleport/cloud-migration-client", () => ({
  requestSignedDownloadUrl: async (
    bundleKey: string,
    targetRuntimeVersion: string | undefined,
    downloadFilename?: string,
  ) => {
    calls.push(
      `download-url:${bundleKey}:${targetRuntimeVersion}:${downloadFilename}`,
    );
    return "https://storage.example.com/download";
  },
}));

mock.module("@/runtime/native-file", () => ({
  saveFile: async (source: string, filename: string) => {
    calls.push(`save:${source}:${filename}`);
  },
}));

mock.module("@/lib/error-reporting/capture-error", () => ({
  captureError: () => {},
}));

mock.module("@mycadet/design-library/components/toast", () => ({
  toast: {
    success: () => {},
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
}));

import { AssistantBackups } from "@/domains/settings/components/assistant-backups";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

async function confirmExport() {
  fireEvent.click(await screen.findByRole("button", { name: "Export" }));
  const dialog = await screen.findByRole("dialog");
  within(dialog).getByText(/including encrypted credentials and the keys/i);
  fireEvent.click(within(dialog).getByRole("button", { name: "Export" }));
}

describe("AssistantBackups export", () => {
  beforeEach(() => {
    exportFails = false;
    calls.length = 0;
    toastErrors = [];
  });
  afterEach(() => cleanup());

  test("exports, then saves the bundle from a named signed download URL", async () => {
    useResolvedAssistantStore.getState().setAssistant({
      cloud: "cloud",
      assistantId: "ast-1",
      name: "Ast",
      hatchedAt: "1970-01-01T00:00:00.000Z",
    });
    render(<AssistantBackups />);

    await confirmExport();

    await waitFor(() =>
      expect(calls).toEqual([
        "export:ast-1",
        "download-url:uploads/org-abc/bundle.tar.gz:1.2.3:ast-1-2026-10-02.tar.gz",
        "save:https://storage.example.com/download:ast-1-2026-10-02.tar.gz",
      ]),
    );
    expect(toastErrors).toEqual([]);
  });

  test("a failed export toasts and leaves the button ready", async () => {
    exportFails = true;
    useResolvedAssistantStore.getState().setAssistant({
      cloud: "cloud",
      assistantId: "ast-1",
      name: "Ast",
      hatchedAt: "1970-01-01T00:00:00.000Z",
    });
    render(<AssistantBackups />);

    await confirmExport();

    await waitFor(() =>
      expect(toastErrors).toEqual(["Failed to export the assistant."]),
    );
    expect(calls).toEqual(["export:ast-1"]);
    expect(
      (screen.getByRole("button", { name: "Export" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("cancelling the confirmation starts no export", async () => {
    useResolvedAssistantStore.getState().setAssistant({
      cloud: "cloud",
      assistantId: "ast-1",
      name: "Ast",
      hatchedAt: "1970-01-01T00:00:00.000Z",
    });
    render(<AssistantBackups />);

    fireEvent.click(await screen.findByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toEqual([]);
  });


  test("switching assistants closes an open confirmation without exporting", async () => {
    useResolvedAssistantStore.getState().setAssistant({
      cloud: "cloud",
      assistantId: "ast-1",
      name: "Ast",
      hatchedAt: "1970-01-01T00:00:00.000Z",
    });
    render(<AssistantBackups />);
    fireEvent.click(await screen.findByRole("button", { name: "Export" }));
    await screen.findByRole("dialog");

    useResolvedAssistantStore.getState().setAssistant({
      cloud: "cloud",
      assistantId: "ast-2",
      name: "Ast Two",
      hatchedAt: "1970-01-01T00:00:00.000Z",
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls).toEqual([]);
  });

});
