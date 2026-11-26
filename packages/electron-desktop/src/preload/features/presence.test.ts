import { expect, mock, test } from "bun:test";

import { electronMock } from "../../../test-setup";

import type { CadetBridge } from "@mycadet/ipc-contract";
import { BridgeCapabilityRegistry } from "../../capability-registry";

const listeners = new Map<string, (...args: unknown[]) => void>();
const send = mock((_channel: string, ..._args: unknown[]) => undefined);
const invoke = mock((channel: string) =>
  Promise.resolve(channel === "cadet:connectivity:get" ? "online" : null),
);
const off = mock(() => undefined);

mock.module("electron", () =>
  electronMock({
    ipcRenderer: {
      invoke,
      off,
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, listener);
      },
      send,
    },
  }),
);

const { install: presenceInstall } = await import("./presence");

// A real registry, so the test holds the feature to its actual
// contribution contract rather than a stub's.
const freshRegistry = () => new BridgeCapabilityRegistry<CadetBridge>({});

test("contributes the complete presence bridge", () => {
  const registry = freshRegistry();
  presenceInstall(registry);

  expect(Object.keys(registry.build()).sort()).toEqual([
    "connectivity",
    "dock",
    "icon",
    "identity",
    "power",
    "status",
  ]);
});

test("publishes status, identity, avatar, and unread state", () => {
  const registry = freshRegistry();
  presenceInstall(registry);
  const bridge = registry.build();

  bridge.status?.setConnection("thinking");
  bridge.identity?.setName("Example Assistant");
  bridge.icon?.setAvatar(null);
  bridge.icon?.setCharacter(null);
  bridge.dock?.setBadge(3);

  expect(send.mock.calls.map((call) => call[0])).toEqual([
    "cadet:status:connection",
    "cadet:identity:name",
    "cadet:icon:setAvatar",
    "cadet:icon:setCharacter",
    "cadet:dock:setBadge",
  ]);
});

test("delivers power and current connectivity state with cleanup", async () => {
  const registry = freshRegistry();
  presenceInstall(registry);
  const bridge = registry.build();
  const powerEvents: unknown[] = [];
  const states: unknown[] = [];

  const stopPower = bridge.power?.onEvent((event) => powerEvents.push(event));
  const stopConnectivity = bridge.connectivity?.onState((state) =>
    states.push(state),
  );
  listeners.get("cadet:power:event")?.({}, { kind: "resume" });
  await Promise.resolve();
  stopPower?.();
  stopConnectivity?.();

  expect(powerEvents).toEqual([{ kind: "resume" }]);
  expect(states).toEqual(["online"]);
  expect(off).toHaveBeenCalledTimes(2);
});
