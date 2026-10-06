import { describe, test, expect } from "bun:test";
import {
  FIREWALL_TAG,
  GATEWAY_PORT,
  VALID_REMOTE_HOSTS,
} from "../lib/constants.js";

describe("constants", () => {
  test("FIREWALL_TAG is a non-empty string", () => {
    expect(typeof FIREWALL_TAG).toBe("string");
    expect(FIREWALL_TAG.length).toBeGreaterThan(0);
  });

  test("GATEWAY_PORT is a valid port number", () => {
    expect(typeof GATEWAY_PORT).toBe("number");
    expect(GATEWAY_PORT).toBeGreaterThan(0);
    expect(GATEWAY_PORT).toBeLessThan(65536);
  });

  test("VALID_REMOTE_HOSTS includes expected hosts", () => {
    expect(VALID_REMOTE_HOSTS).toContain("local");
    expect(VALID_REMOTE_HOSTS).toContain("docker");
    expect(VALID_REMOTE_HOSTS).toContain("custom");
    expect(VALID_REMOTE_HOSTS).toContain("cloud");
  });

  test("VALID_REMOTE_HOSTS excludes cloud provisioning targets", () => {
    expect(VALID_REMOTE_HOSTS).not.toContain("gcp");
    expect(VALID_REMOTE_HOSTS).not.toContain("aws");
  });
});
