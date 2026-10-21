import { beforeEach, describe, expect, mock, test } from "bun:test";

type BeforeRequestListener = (
  details: { frame?: { origin: string } | null },
  callback: (response: { cancel?: boolean }) => void,
) => void;

let registeredFilter: { urls: string[] } | undefined;
let registeredListener: BeforeRequestListener | null | undefined;
const onBeforeRequest = mock(
  (filter: { urls: string[] }, listener: BeforeRequestListener | null) => {
    registeredFilter = filter;
    registeredListener = listener;
  },
);

mock.module("electron", () => ({
  session: { defaultSession: { webRequest: { onBeforeRequest } } },
}));

const { installGatewayRequestGuard } =
  await import("./gateway-request-guard");

const APP_ORIGIN = { protocol: "app:", host: "mycadet.ai" };

beforeEach(() => {
  registeredFilter = undefined;
  registeredListener = undefined;
  onBeforeRequest.mockClear();
});

describe("installGatewayRequestGuard", () => {
  test("gates both supported gateway proxy paths by frame origin", () => {
    const remove = installGatewayRequestGuard({
      appOrigin: APP_ORIGIN,
      resolveAllowedOrigin: () => APP_ORIGIN,
    });

    expect(registeredFilter?.urls).toEqual([
      "app://mycadet.ai/assistant/__gateway/*",
      "app://mycadet.ai/__gateway/*",
    ]);

    let cancel: boolean | undefined;
    registeredListener?.(
      { frame: { origin: "app://mycadet.ai" } },
      (response) => {
        cancel = response.cancel;
      },
    );
    expect(cancel).toBe(false);

    registeredListener?.(
      { frame: { origin: "http://127.0.0.1:9999" } },
      (response) => {
        cancel = response.cancel;
      },
    );
    expect(cancel).toBe(true);

    registeredListener?.({ frame: null }, (response) => {
      cancel = response.cancel;
    });
    expect(cancel).toBe(true);

    remove();
    expect(onBeforeRequest).toHaveBeenLastCalledWith(registeredFilter, null);
  });
});
