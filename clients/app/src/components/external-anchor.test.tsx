import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let native = false;
const openUrl = mock(async (_url: string) => {});
mock.module("@app/runtime/native-platform", () => ({
  isNativePlatform: () => native,
}));
mock.module("@app/runtime/browser", () => ({ openUrl }));
const { ExternalAnchor } = await import("@app/components/external-anchor");

afterEach(() => {
  cleanup();
  native = false;
  openUrl.mockClear();
});

test("browser links retain copyable href and safe new-tab attributes", () => {
  render(<ExternalAnchor href="https://example.com">Docs</ExternalAnchor>);
  const link = screen.getByRole("link", { name: "Docs" });
  expect(link.getAttribute("href")).toBe("https://example.com");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(fireEvent.click(link)).toBe(true);
  expect(openUrl).not.toHaveBeenCalled();
});

test("native links intercept the click and open the native browser", () => {
  native = true;
  render(<ExternalAnchor href="https://example.com">Docs</ExternalAnchor>);
  expect(fireEvent.click(screen.getByRole("link", { name: "Docs" }))).toBe(
    false,
  );
  expect(openUrl).toHaveBeenCalledWith("https://example.com");
});
