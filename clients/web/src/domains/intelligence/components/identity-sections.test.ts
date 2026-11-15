/**
 * The overview's drill-down section list: a stable order, with nothing gated
 * on backend capability or platform. Whatever the backend reports and
 * whatever shell the app runs in, the list is the same, so a phone user
 * reaches every section — Email included, always last.
 */
import { describe, expect, test } from "bun:test";

import { buildIdentitySections } from "./identity-sections";

const keys = () => buildIdentitySections().map((s) => s.key);

describe("buildIdentitySections", () => {
  test("includes every section, in order", () => {
    expect(keys()).toEqual([
      "personality",
      "schedules",
      "superpowers",
      "library",
      "workspace",
      "contacts",
      "channels",
      "email",
    ]);
  });

  test("draws Email after Channels, always", () => {
    const sections = buildIdentitySections();
    const emailIndex = sections.findIndex((s) => s.key === "email");
    expect(emailIndex).toBeGreaterThan(-1);
    expect(emailIndex).toBe(
      sections.findIndex((s) => s.key === "channels") + 1,
    );
    expect(sections[emailIndex]?.to).toBe("/assistant/inbox");
  });

  test("every section carries a label, description and path", () => {
    for (const section of buildIdentitySections()) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.description.length).toBeGreaterThan(0);
      expect(section.to.startsWith("/")).toBe(true);
    }
  });
});
