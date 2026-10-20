import { afterEach, beforeEach, expect, mock, test } from "bun:test";

// The host's reported languages are the formatLocale seam: the app's own
// locale stays at its default ("en"), so a seeded host tag is what the
// >=1-month fallback should pick up. Mocked before the dynamic import per
// i18n.test.ts (mock.module is process-global; run-isolated-tests runs this
// file in its own process).
let preferred: string[] = [];
mock.module("@app/i18n/system-locale", () => ({
  systemLocales: () => preferred,
}));

const { formatRelativeDate } = await import("./format-date");

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** An instant `days` whole days ago, with a minute of margin so the
 * formatter's day floor lands on the whole number. */
const daysAgoIso = (days: number) =>
  new Date(Date.now() - days * DAY_MS - 60_000).toISOString();

const secondsAgoIso = (seconds: number) =>
  new Date(Date.now() - seconds * 1000).toISOString();

beforeEach(() => {
  preferred = [];
});
afterEach(() => {
  preferred = [];
});

test("a missing timestamp renders the em dash", () => {
  expect(formatRelativeDate(null)).toBe("—");
  expect(formatRelativeDate(undefined)).toBe("—");
  expect(formatRelativeDate("")).toBe("—");
});

test("recent ages render compact relative labels", () => {
  expect(formatRelativeDate(secondsAgoIso(30))).toBe("just now");
  expect(formatRelativeDate(secondsAgoIso(2 * 60 + 30))).toBe("2m ago");
  expect(
    formatRelativeDate(new Date(Date.now() - 3.2 * HOUR_MS).toISOString()),
  ).toBe("3h ago");
  expect(formatRelativeDate(daysAgoIso(1))).toBe("yesterday");
  expect(formatRelativeDate(daysAgoIso(5))).toBe("5d ago");
  // 15 whole days rounds down to 2 weeks.
  expect(formatRelativeDate(daysAgoIso(15))).toBe("2w ago");
});

test("future timestamps render an in- label", () => {
  expect(
    formatRelativeDate(new Date(Date.now() + 30 * 60_000).toISOString()),
  ).toBe("in <1h");
  expect(
    formatRelativeDate(new Date(Date.now() + 2 * HOUR_MS).toISOString()),
  ).toBe("in 2h");
  expect(
    formatRelativeDate(new Date(Date.now() + 72 * HOUR_MS).toISOString()),
  ).toBe("in 3d");
});

test("a month-old date falls back to the host's region", () => {
  preferred = ["en-GB"];
  const date = new Date(2001, 0, 15, 9, 14);
  expect(formatRelativeDate(date.toISOString())).toBe(
    date.toLocaleDateString("en-GB"),
  );
  expect(formatRelativeDate(date.toISOString())).not.toBe(
    date.toLocaleDateString("en"),
  );
});
