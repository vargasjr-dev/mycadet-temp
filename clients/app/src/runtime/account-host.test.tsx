import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import type { CadetCommand } from "@mycadet/ipc-contract";

import { useOnboardingWindowSize } from "@app/hooks/use-onboarding-window-size";
import { useCadetCommands } from "@app/runtime/cadet-commands";
import { getElectronBridge } from "@app/runtime/electron-bridge";
import { setMenuCloudSession } from "@app/runtime/menu";
import { ensureMainWindowVisible } from "@app/runtime/main-window";

const original = Object.getOwnPropertyDescriptor(window, "cadet");
const unsubscribe = mock(() => {});
const setOnboarding = mock(async (_active: boolean) => {});
const ensureVisible = mock(async () => {});
const setCloudSession = mock(async (_has: boolean) => {});
let listener: ((command: CadetCommand) => void) | undefined;
const on = mock((callback: (command: CadetCommand) => void) => {
  listener = callback;
  return unsubscribe;
});

function installHost() {
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      menu: { setCloudSession },
      commands: { on },
      mainWindow: { setOnboarding, ensureVisible },
    },
  });
}

afterEach(() => {
  cleanup();
  if (original) Object.defineProperty(window, "cadet", original);
  else Reflect.deleteProperty(window, "cadet");
  listener = undefined;
  for (const callback of [
    on,
    unsubscribe,
    setOnboarding,
    ensureVisible,
    setCloudSession,
  ])
    callback.mockClear();
});

test("tray commands use the latest handler and unsubscribe on unmount", () => {
  installHost();
  const first = mock(() => {});
  const second = mock(() => {});
  const hook = renderHook(
    ({ handler }) => useCadetCommands({ createAssistant: handler }),
    { initialProps: { handler: first } },
  );
  listener?.({ kind: "createAssistant" });
  expect(first).toHaveBeenCalledTimes(1);
  hook.rerender({ handler: second });
  listener?.({ kind: "createAssistant" });
  expect(second).toHaveBeenCalledTimes(1);
  expect(on).toHaveBeenCalledTimes(1);
  hook.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test("account screens request compact host windows", async () => {
  installHost();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={["/account/login"]}>{children}</MemoryRouter>
  );
  renderHook(useOnboardingWindowSize, { wrapper });
  expect(setOnboarding).toHaveBeenCalledWith(true);
  await ensureMainWindowVisible();
  expect(ensureVisible).toHaveBeenCalledTimes(1);
});

test("ordinary browser renders do not subscribe or invoke native controls", async () => {
  Reflect.deleteProperty(window, "cadet");
  expect(getElectronBridge()).toBeUndefined();
  renderHook(() => useCadetCommands({ createAssistant: () => {} }));
  await ensureMainWindowVisible();
  expect(on).not.toHaveBeenCalled();
  expect(ensureVisible).not.toHaveBeenCalled();
});

test("cloud session changes reach the host menu and no-op in a browser", async () => {
  installHost();
  await setMenuCloudSession(true);
  await setMenuCloudSession(false);
  expect(setCloudSession.mock.calls).toEqual([[true], [false]]);
  Reflect.deleteProperty(window, "cadet");
  await setMenuCloudSession(true);
  expect(setCloudSession).toHaveBeenCalledTimes(2);
});
