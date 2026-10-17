import { readInjectedConfig } from "@/lib/injected-config";
import { isElectron } from "@/runtime/is-electron";

let cached: string | null | undefined;

export function getDeviceId(): string | null {
  if (!isElectron()) {
    return null;
  }
  if (cached === undefined) {
    cached = readInjectedConfig()?.deviceId ?? null;
  }
  return cached;
}
