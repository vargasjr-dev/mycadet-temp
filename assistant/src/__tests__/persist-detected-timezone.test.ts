/**
 * `persistDetectedClientTimezone` keeps `config.ui.detectedTimezone` fresh
 * from the zone every inbound message already carries, so the scheduler's
 * zone chain (`resolveScheduleTimezone`) never falls back to the daemon host
 * clock (UTC on a managed container) for clients without the web app's
 * headless `TimezoneSync` component.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  getConfigReadOnly,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../config/loader.js";
import { persistDetectedClientTimezone } from "../schedule/sync-detected-timezone.js";

function seedUi(patch: {
  detectedTimezone?: string | null;
  userTimezone?: string | null;
}): void {
  const config = getConfigReadOnly();
  saveRawConfig({
    ...loadRawConfig(),
    ui: {
      ...config.ui,
      detectedTimezone: patch.detectedTimezone ?? null,
      userTimezone: patch.userTimezone ?? null,
    },
  });
  invalidateConfigCache();
}

describe("persistDetectedClientTimezone", () => {
  beforeEach(() => {
    seedUi({});
  });

  test("writes the client's zone into ui.detectedTimezone", () => {
    persistDetectedClientTimezone("Asia/Tokyo");
    expect(getConfigReadOnly().ui?.detectedTimezone ?? null).toBe("Asia/Tokyo");
  });

  test("canonicalizes the zone before writing", () => {
    persistDetectedClientTimezone(" asia/tokyo ");
    expect(getConfigReadOnly().ui?.detectedTimezone ?? null).toBe("Asia/Tokyo");
  });

  test("never touches ui.userTimezone — the manual override wins", () => {
    seedUi({ userTimezone: "Europe/Paris" });

    persistDetectedClientTimezone("Asia/Tokyo");
    expect(getConfigReadOnly().ui?.userTimezone ?? null).toBe("Europe/Paris");
    expect(getConfigReadOnly().ui?.detectedTimezone ?? null).toBe("Asia/Tokyo");
  });

  test("preserves the rest of the ui section", () => {
    seedUi({});
    persistDetectedClientTimezone("Asia/Tokyo");
    const ui = getConfigReadOnly().ui;
    expect(ui?.detectedTimezone ?? null).toBe("Asia/Tokyo");
    expect(ui?.emptyStateGreetingCacheTtlMs).toBeDefined();
  });

  test("is a no-op when no zone or an unknown zone is supplied", () => {
    persistDetectedClientTimezone(undefined);
    persistDetectedClientTimezone(null);
    persistDetectedClientTimezone("");
    persistDetectedClientTimezone("Mars/Olympus_Mons");
    expect(getConfigReadOnly().ui?.detectedTimezone ?? null).toBeNull();
  });
});
