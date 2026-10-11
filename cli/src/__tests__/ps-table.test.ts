import { describe, expect, test } from "bun:test";

import { displayWidth, formatRow } from "../commands/ps.js";

describe("displayWidth", () => {
  test("ascii strings count one cell per character", () => {
    expect(displayWidth("healthy")).toBe(7);
    expect(displayWidth("")).toBe(0);
  });

  test("emoji count two cells", () => {
    expect(displayWidth("🟢")).toBe(2);
    expect(displayWidth("🚀")).toBe(2);
  });

  test("the ZWJ astronaut sequence counts two cells, not its UTF-16 length", () => {
    // "🧑‍🚀" is 5 UTF-16 units but renders 2 cells wide.
    expect(displayWidth("🧑‍🚀 Assistant")).toBe(12);
  });

  test("a variation selector widens a narrow symbol to two cells", () => {
    expect(displayWidth("⚠️ warn")).toBe(7);
  });
});

describe("ps table alignment", () => {
  const colWidths = { name: 15, type: 14, status: 10, info: 0 };

  /** The terminal column where `marker` starts (string indices shift under
   * emoji, which render 2 cells but span 2 UTF-16 units or more). */
  const columnOf = (s: string, marker: string): number =>
    displayWidth(s.slice(0, s.indexOf(marker)));

  test("emoji cells keep every later column aligned", () => {
    const emojiRow = formatRow(
      {
        name: "slim-yak",
        type: "🧑‍🚀 Assistant",
        status: "🟢 healthy",
        info: "http://x",
      },
      colWidths,
    );
    const asciiRow = formatRow(
      {
        name: "plain",
        type: "Assistant",
        status: "healthy",
        info: "http://y",
      },
      colWidths,
    );
    expect(columnOf(emojiRow, "http://x")).toBe(columnOf(asciiRow, "http://y"));
  });

  test("the header separator matches the emoji row's column starts", () => {
    const widths = {
      name: displayWidth("slim-yak-yhpdq6"),
      type: displayWidth("🧑‍🚀 Assistant"),
      status: displayWidth("🟢 healthy"),
      info: 0,
    };
    const header = formatRow(
      { name: "NAME", type: "TYPE", status: "STATUS", info: "INFO" },
      widths,
    );
    const row = formatRow(
      {
        name: "slim-yak-yhpdq6",
        type: "🧑‍🚀 Assistant",
        status: "🟢 healthy",
        info: "http://127.0.0.1:7830",
      },
      widths,
    );
    expect(columnOf(header, "TYPE")).toBe(columnOf(row, "🧑‍🚀"));
    expect(columnOf(header, "STATUS")).toBe(columnOf(row, "🟢"));
  });
});
