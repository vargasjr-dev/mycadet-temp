import { readAttributionParams } from "@app/domains/account/attribution";
import { captureInstallReferrer } from "@app/runtime/install-referrer";

export async function resolveNativeAttribution(
  override: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  const current = override ?? readAttributionParams(window.location.search);
  if (Object.keys(current).length > 0) {
    return current;
  }
  const referrer = await captureInstallReferrer();
  return Object.keys(referrer).length > 0 ? referrer : undefined;
}
