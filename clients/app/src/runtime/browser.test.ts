import { afterEach, expect, mock, spyOn, test } from "bun:test";

let native = false;
let electron = false;
let pluginUnavailable = false;
const browserOpen = mock(async (_options: unknown) => {
  if (pluginUnavailable) throw new Error("Plugin unavailable");
});
mock.module("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native },
}));
mock.module("@capacitor/browser", () => ({ Browser: { open: browserOpen } }));
mock.module("@app/runtime/electron-bridge", () => ({
  getElectronBridge: () => (electron ? { platform: "electron" } : undefined),
}));
const { openUrl } = await import("@app/runtime/browser");
const initialUrl = window.location.href;

afterEach(() => {
  native = false;
  electron = false;
  pluginUnavailable = false;
  browserOpen.mockClear();
  window.location.href = initialUrl;
});

test("Electron opens externally without invoking the Capacitor browser", async () => {
  electron = true;
  const opened = spyOn(window, "open").mockReturnValue(null);
  try {
    await openUrl("https://example.com");
    expect(opened).toHaveBeenCalledWith("https://example.com", "_blank");
    expect(browserOpen).not.toHaveBeenCalled();
  } finally {
    opened.mockRestore();
  }
});

test("Capacitor uses its browser sheet", async () => {
  native = true;
  await openUrl("https://example.com");
  expect(browserOpen).toHaveBeenCalledWith({
    url: "https://example.com",
    presentationStyle: "popover",
  });
  expect(window.location.href).toBe(initialUrl);
});

test("plain browser and missing native plugin fall back to page navigation", async () => {
  await openUrl("https://example.com/plain");
  expect(window.location.href).toBe("https://example.com/plain");
  native = true;
  pluginUnavailable = true;
  await openUrl("https://example.com/fallback");
  expect(window.location.href).toBe("https://example.com/fallback");
});
