import { describe, expect, test } from "bun:test";

import {
  channelSectionKey,
  isChannelSectionKey,
} from "./sidebar-group-collapse-storage";

describe("sidebar section keys", () => {
  test("a channel section key prefixes the channel id", () => {
    expect(channelSectionKey("slack")).toBe("channel:slack");
  });

  test("the predicate matches only channel-section keys", () => {
    expect(isChannelSectionKey(channelSectionKey("telegram"))).toBe(true);
    expect(isChannelSectionKey("recents")).toBe(false);
    expect(isChannelSectionKey("grp-a")).toBe(false);
  });
});
