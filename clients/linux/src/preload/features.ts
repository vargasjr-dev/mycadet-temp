import {
  BridgeCapabilityRegistry,
  installCapabilityModules,
  type CapabilityModuleExport,
} from "@mycadet/electron-desktop/capability-registry";
import type { VellumBridge } from "@mycadet/ipc-contract";

const modules = import.meta.glob<
  CapabilityModuleExport<BridgeCapabilityRegistry<VellumBridge>>
>("./features/*.ts", { eager: true });

export const composePreloadFeatures = (
  base: Partial<VellumBridge>,
): Partial<VellumBridge> => {
  const registry = new BridgeCapabilityRegistry<VellumBridge>(base);
  installCapabilityModules(registry, modules);
  return registry.build();
};
