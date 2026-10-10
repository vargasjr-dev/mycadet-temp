import { getDisableCloud, getIsCloud } from "../config/env-registry.js";

export function areCloudFeaturesEnabled(): boolean {
  if (getIsCloud()) {
    return true;
  }
  return !getDisableCloud();
}
