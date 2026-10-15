import { afterEach, expect, mock, test } from "bun:test";
const createBackup = mock(async (_id: string) => ({
  ok: true,
  status: 201,
  data: { snapshot_name: "assistant-1-backup-1" },
}));
mock.module("@/assistant/api", () => ({ createAssistantBackup: createBackup }));
const { exportManagedBundle, exportBundleFilename } =
  await import("./cloud-export");
afterEach(() => createBackup.mockClear());
test("cloud export creates an API-owned backup and downloads a root tar filename", async () => {
  expect(await exportManagedBundle("assistant-1")).toEqual({
    bundleKey: "assistant-1-backup-1",
    runtimeVersion: undefined,
  });
  expect(createBackup).toHaveBeenCalledWith("assistant-1");
  expect(exportBundleFilename("../Assistant one", new Date("2026-01-02"))).toBe(
    "Assistant-one-2026-01-02.tar.gz",
  );
});
