/**
 * Tests for the `ThemePicker` shown inline in the Preferences card.
 *
 * It renders on every platform. `useThemePreference` and `SegmentControl` are
 * stubbed so the test exercises the option list and its delegation to the
 * shared theme setter.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const setThemePreferenceMock = mock((_theme: string) => {});

mock.module("@/hooks/use-theme-preference", () => ({
  useThemePreference: () => ({
    theme: "system",
    setThemePreference: setThemePreferenceMock,
  }),
}));

// Minimal SegmentControl harness: render one button per item exposing onChange.
mock.module("@mycadet/design-library/components/segment-control", () => ({
  SegmentControl: ({
    items,
    onChange,
    ariaLabel,
  }: {
    items: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    ariaLabel: string;
  }) => (
    <div aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

import { ThemePicker } from "@/domains/settings/components/theme-picker";

describe("ThemePicker", () => {
  beforeEach(() => {
    setThemePreferenceMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders the theme options under a Theme heading", () => {
    render(<ThemePicker />);

    expect(screen.getByText("Theme")).toBeDefined();
    expect(screen.getByLabelText("Theme")).toBeDefined();
    expect(screen.getByRole("button", { name: "System" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Light" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Dark" })).toBeDefined();
  });

  test("choosing a theme delegates to the shared theme setter", () => {
    render(<ThemePicker />);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(setThemePreferenceMock).toHaveBeenCalledWith("dark");
  });
});
