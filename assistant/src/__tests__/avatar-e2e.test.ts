import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state — mutable variables control per-test behavior
// ---------------------------------------------------------------------------

let logInfoCalls: Array<[unknown, string]> = [];
let logErrorCalls: Array<[unknown, string]> = [];

// ---------------------------------------------------------------------------
// Gemini mock state
// ---------------------------------------------------------------------------

let geminiGenerateContentResult: unknown;
const geminiGenerateContentFn = mock(async () => geminiGenerateContentResult);

// ---------------------------------------------------------------------------
// Mock modules — must be before importing the module under test
// ---------------------------------------------------------------------------

import { credentialKey } from "../security/credential-key.js";
import { useMemorySecureKeyMap } from "./helpers/secure-keys.js";

// The REAL secure-keys module pinned to a live memory backend; the avatar
// router resolves the Gemini key through getProviderKeyAsync("gemini").
const secureKeys = useMemorySecureKeyMap();
const GEMINI_KEY = credentialKey("gemini", "api_key");

mock.module("pino", () => {
  function createLogger() {
    return {
      child: () => createLogger(),
      debug: () => {},
      info: (...args: unknown[]) => {
        logInfoCalls.push(args as [unknown, string]);
      },
      warn: () => {},
      error: (...args: unknown[]) => {
        logErrorCalls.push(args as [unknown, string]);
      },
    };
  }

  const pino = Object.assign(() => createLogger(), {
    destination: () => ({ write: () => true }),
    multistream: () => ({ write: () => true }),
  });

  return {
    default: pino,
  };
});

mock.module("pino-pretty", () => ({
  default: () => ({ write: () => true }),
}));

mock.module("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: geminiGenerateContentFn,
    };
  },
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

// Import after all mocks are set up
import { generateAvatarImage } from "../tools/system/avatar-generator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function executeAvatar(description: string) {
  return generateAvatarImage(description);
}

/** Standard successful Gemini generateContent response. */
function geminiContentResponse() {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUg==",
              },
            },
          ],
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("avatar E2E integration", () => {
  // Save original GEMINI_API_KEY to restore after each test
  const originalGeminiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    secureKeys.set(GEMINI_KEY, "test-gemini-key");
    geminiGenerateContentFn.mockClear();

    logInfoCalls = [];
    logErrorCalls = [];

    geminiGenerateContentResult = geminiContentResponse();

    // Clear env var so tests control the key entirely via config mock
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    // Restore original GEMINI_API_KEY
    if (originalGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    }
  });

  // -----------------------------------------------------------------------
  // 1. Local Gemini success
  // -----------------------------------------------------------------------

  test("local Gemini success — returns PNG bytes and success message", async () => {
    const result = await executeAvatar("a friendly robot");

    // Verify success message
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Avatar updated");

    // Verify the returned buffer content matches the base64 data. Persistence
    // is the caller's job (the route routes these bytes through the store).
    const expectedBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUg==", "base64");
    expect(result.pngBuffer).not.toBeNull();
    expect(result.pngBuffer?.equals(expectedBuffer)).toBe(true);

    // Verify Gemini was called
    expect(geminiGenerateContentFn).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 2. No Gemini key — error
  // -----------------------------------------------------------------------

  test("no Gemini key — error surfaced", async () => {
    secureKeys.delete(GEMINI_KEY);

    const result = await executeAvatar("a whimsical owl");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed");
  });

  // -----------------------------------------------------------------------
  // 3. Gemini API failure
  // -----------------------------------------------------------------------

  test("Gemini API failure — error surfaced", async () => {
    geminiGenerateContentResult = {
      candidates: [
        {
          content: {
            parts: [],
          },
        },
      ],
    };

    const result = await executeAvatar("a cat");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed");
  });
});
