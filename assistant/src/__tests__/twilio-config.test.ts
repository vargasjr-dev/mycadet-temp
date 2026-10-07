import { beforeEach, describe, expect, test } from "bun:test";

import {
  reseedMemorySecureKeys,
  useMemorySecureKeys,
} from "./helpers/secure-keys.js";

// ── Mocks (must come before source imports) ──────────────────────────

const mockSecureKeys = useMemorySecureKeys();

import { getTwilioConfig } from "../calls/twilio-config.js";
import { credentialKey } from "../security/credential-key.js";
import { setConfig } from "./helpers/set-config.js";

describe("twilio-config", () => {
  beforeEach(() => {
    reseedMemorySecureKeys(mockSecureKeys, {
      [credentialKey("twilio", "auth_token")]: "test_auth_token",
    });
    setConfig("twilio", {
      accountSid: "AC_test_sid",
      phoneNumber: "+15550123",
    });
  });

  test("returns config when credentials and phone number are set", async () => {
    const config = await getTwilioConfig();
    expect(config.accountSid).toBe("AC_test_sid");
    expect(config.authToken).toBe("test_auth_token");
    expect(config.phoneNumber).toBe("+15550123");
  });

  test("throws ConfigError when account SID is missing", async () => {
    setConfig("twilio", { accountSid: "", phoneNumber: "+15550123" });
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio credentials not configured/,
    );
  });

  test("throws ConfigError when auth token is missing", async () => {
    reseedMemorySecureKeys(mockSecureKeys);
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio credentials not configured/,
    );
  });

  test("throws ConfigError when phone number is missing", async () => {
    setConfig("twilio", {
      accountSid: "AC_test_sid",
      phoneNumber: "",
    });
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio phone number not configured/,
    );
  });

  test("throws ConfigError when twilio config section is absent", async () => {
    setConfig("twilio", {});
    expect(getTwilioConfig()).rejects.toThrow(
      /Twilio credentials not configured/,
    );
  });
});
