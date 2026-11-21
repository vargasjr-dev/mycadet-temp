import type { Session } from "electron";

export const BUNDLES_DIR_NAME = "bundles";
export const CADET_PROTOCOL = "cadet";

export interface ActiveBundleGateway {
  assistantId: string;
  baseUrl: string;
}

export interface BundleHostProvider {
  resolveActiveGateway: () => ActiveBundleGateway | null;
  acquireGatewayToken: (assistantId: string) => Promise<string | null>;
  denyAllPermissions: (targetSession: Session) => void;
}

export interface BundlePlatform extends BundleHostProvider {
  bundlesRoot: () => string;
  rendererBase: () => string;
}

let platform: BundlePlatform | undefined;

export const configureBundlePlatform = (value: BundlePlatform): void => {
  if (platform) {
    throw new Error("Bundle platform is already configured");
  }
  platform = value;
};

export const getBundlePlatform = (): BundlePlatform => {
  if (!platform) {
    throw new Error("Bundle platform is not configured");
  }
  return platform;
};

export const resetBundlePlatformForTest = (): void => {
  platform = undefined;
};
