import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type ConsumeResult = {
  sessionToken?: string;
  postAuthDestination?: string;
  error?: string;
  errorCode?: string;
};

let nativePlatform = false;
let platform = "web";
let biometricsEnabled = false;

const consumeRestoredAuth = mock(async (): Promise<ConsumeResult> => ({}));

const nativePlugins: Record<string, unknown> = {
  NativeAuth: { consumeRestoredAuth },
};

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativePlatform,
    getPlatform: () => platform,
  },
  registerPlugin: (name: string) => nativePlugins[name] ?? {},
}));

// The restore path polls the session endpoint before navigating. Answer
// "authenticated" immediately so tests don't sit through the backoff.
mock.module("@/lib/auth/allauth-client", () => ({
  getSession: async () => ({ ok: true, data: { user: { id: "user-1" } } }),
}));

// Biometric recovery is opt-in device storage, not this suite's subject.
mock.module("@/runtime/native-biometric", () => ({
  isBiometricEnabled: () => biometricsEnabled,
  setBiometricEnabled: () => {},
  storeBiometricToken: async () => true,
}));

// jsdom rejects cookies for foreign domains (`domain=.mycadet.ai`), so the
// suite backs `document.cookie` with a plain jar and exercises the real
// write/read round trip against it.
const cookieJar = new Map<string, string>();
const originalCookie = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "cookie",
);
Object.defineProperty(document, "cookie", {
  configurable: true,
  get() {
    return [...cookieJar.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  },
  set(input: string) {
    const [pair] = input.split(";");
    const idx = pair.indexOf("=");
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (/max-age\s*=\s*0/i.test(input)) {
      cookieJar.delete(name);
    } else {
      cookieJar.set(name, value);
    }
  },
});

const {
  installSessionCookies,
  getSessionTokenFromCookies,
  isNativePlatform,
  restorePendingNativeLogin,
} = await import("./native-auth");

beforeEach(() => {
  nativePlatform = false;
  platform = "web";
  biometricsEnabled = false;
});

afterEach(() => {
  consumeRestoredAuth.mockClear();
  cookieJar.clear();
});

afterEach(() => {
  if (originalCookie) {
    Object.defineProperty(Document.prototype, "cookie", originalCookie);
  }
});

describe("platform detection", () => {
  test("false before hydration and outside native shells", () => {
    expect(isNativePlatform()).toBe(false);
  });

  test("true inside a Capacitor shell", () => {
    nativePlatform = true;
    expect(isNativePlatform()).toBe(true);
  });
});

describe("session cookie hand-off", () => {
  test("installSessionCookies writes dev and prod names", () => {
    installSessionCookies("tok-123");
    expect(getSessionTokenFromCookies()).toBe("tok-123");
    expect(cookieJar.has("sessionid")).toBe(true);
    expect(cookieJar.has("__Secure-sessionid")).toBe(true);
  });
});

describe("restorePendingNativeLogin", () => {
  test("no-ops outside native shells", async () => {
    await restorePendingNativeLogin();
    expect(consumeRestoredAuth).not.toHaveBeenCalled();
  });

  test("no-ops on non-Android native platforms", async () => {
    nativePlatform = true;
    platform = "ios";
    await restorePendingNativeLogin();
    expect(consumeRestoredAuth).not.toHaveBeenCalled();
  });

  test("installs the restored token as the session cookie and navigates", async () => {
    nativePlatform = true;
    platform = "android";
    consumeRestoredAuth.mockResolvedValueOnce({
      sessionToken: "restored-tok",
      postAuthDestination: "/assistant",
    });
    let navigated = "";
    const descriptor = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        ...(descriptor?.value ?? {}),
        set href(v: string) {
          navigated = v;
        },
      },
    });
    try {
      await restorePendingNativeLogin();
    } finally {
      if (descriptor) {
        Object.defineProperty(window, "location", descriptor);
      }
    }
    expect(getSessionTokenFromCookies()).toBe("restored-tok");
    expect(navigated).toBe("/assistant");
  });

  test("surfaces a restore error with the native error code", async () => {
    nativePlatform = true;
    platform = "android";
    consumeRestoredAuth.mockResolvedValueOnce({
      error: "exchange failed",
      errorCode: "CODE_EXCHANGE",
    });
    const error = await restorePendingNativeLogin().then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code?: string }).code).toBe("CODE_EXCHANGE");
  });
});
