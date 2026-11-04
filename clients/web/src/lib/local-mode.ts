import { readInjectedConfig } from "@/lib/injected-config";

/** Whether the served remote is the cloud proper (its own cookie scheme). */
export function isCadetCloudRemote(): boolean {
  return readInjectedConfig()?.remote === "cloud";
}
