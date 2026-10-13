import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup } from "@testing-library/react";

import { CADET_DOWNLOADS_URL } from "@/utils/external-urls";

const { openDesktopAppDownload } =
  await import("@/hooks/use-desktop-app-nudge");

const originalWindowOpen = window.open;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.open = originalWindowOpen;
});

describe("desktop app download link", () => {
  test("opens the canonical downloads page", () => {
    const open = mock(() => null);
    window.open = open as typeof window.open;

    openDesktopAppDownload();

    expect(open).toHaveBeenCalledWith(
      "https://www.mycadet.ai/downloads",
      "_blank",
      "noopener,noreferrer",
    );
    expect(CADET_DOWNLOADS_URL).toBe("https://www.mycadet.ai/downloads");
  });
});
