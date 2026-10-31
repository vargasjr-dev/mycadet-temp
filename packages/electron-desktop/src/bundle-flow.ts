/**
 * Bundle-open orchestration: file-open -> assistant scan -> confirm -> unpack -> render.
 *
 * When the user double-clicks a `.cadet` file in Finder, this module coordinates
 * the full flow: resolves the gateway port, asks the assistant to
 * scan the bundle, shows the confirmation dialog, unpacks the bundle on acceptance,
 * and opens the sandboxed renderer window.
 */
import { dialog, net } from "electron";

import {
  openBundleConfirmation,
  installBundleConfirmation,
} from "./bundle-confirmation";
import { unpackBundle, type BundleScanData } from "./bundle-manager";
import { getBundlePlatform, type ActiveBundleGateway } from "./bundle-platform";
import { openBundleWindow } from "./bundle-window";

export function resolveActiveGateway(): ActiveBundleGateway | null {
  return getBundlePlatform().resolveActiveGateway();
}

async function acquireGatewayToken(
  assistantId: string,
): Promise<string | null> {
  return getBundlePlatform().acquireGatewayToken(assistantId);
}

export async function scanBundleViaGateway(
  filePath: string,
  gatewayUrl: string,
  token: string | null,
): Promise<BundleScanData | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const response = await net.fetch(`${gatewayUrl}/v1/apps/open-bundle`, {
      method: "POST",
      body: JSON.stringify({ filePath }),
      headers,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as BundleScanData;
  } catch {
    return null;
  }
}

export async function handleBundleFile(filePath: string): Promise<void> {
  const platform = getBundlePlatform();
  const gateway = resolveActiveGateway();
  if (!gateway) {
    dialog.showErrorBox(
      "Cannot open bundle",
      "Cadet assistant is not running. Please start Cadet first.",
    );
    return;
  }

  const token = await acquireGatewayToken(gateway.assistantId);
  const scanData = await scanBundleViaGateway(filePath, gateway.baseUrl, token);
  if (!scanData) {
    dialog.showErrorBox("Cannot open bundle", "Failed to scan bundle.");
    return;
  }

  if (!scanData.scanResult.passed) {
    const blocked = scanData.scanResult.blocked
      .map((msg) => `• ${msg}`)
      .join("\n");
    dialog.showErrorBox(
      "Bundle blocked",
      `This bundle cannot be opened due to security findings:\n\n${blocked}`,
    );
    return;
  }

  const accepted = await openBundleConfirmation(scanData);
  if (!accepted) {
    return;
  }

  let metadata;
  try {
    metadata = await unpackBundle(platform.bundlesRoot(), filePath, scanData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    dialog.showErrorBox(
      "Cannot open bundle",
      `Failed to unpack bundle: ${message}`,
    );
    return;
  }

  openBundleWindow(
    metadata.uuid,
    scanData.manifest.entry,
    scanData.manifest.name,
  );
}

export function installBundleFlow(): void {
  installBundleConfirmation();
}
