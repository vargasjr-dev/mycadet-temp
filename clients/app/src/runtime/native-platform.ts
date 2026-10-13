import { Capacitor } from "@capacitor/core";

export function isNativePlatform(): boolean {
  return typeof window !== "undefined" && Capacitor.isNativePlatform();
}
