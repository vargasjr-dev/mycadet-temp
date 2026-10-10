import { getDisablePlatform, getIsCloud } from "../config/env-registry.js";

export function arePlatformFeaturesEnabled(): boolean {
  if (getIsCloud()) {
    return true;
  }
  return !getDisablePlatform();
}
