import {
  BridgeCapabilityRegistry,
  installCapabilityModules,
  type CapabilityModuleExport,
} from "@mycadet/electron-desktop/capability-registry";
import type { CadetBridge } from "@mycadet/ipc-contract";

const modules = import.meta.glob<
  CapabilityModuleExport<BridgeCapabilityRegistry<CadetBridge>>
>("./features/*.ts", { eager: true });

export const composePreloadFeatures = (
  base: Partial<CadetBridge>,
): Partial<CadetBridge> => {
  const registry = new BridgeCapabilityRegistry<CadetBridge>(base);
  installCapabilityModules(registry, modules);
  return registry.build();
};
