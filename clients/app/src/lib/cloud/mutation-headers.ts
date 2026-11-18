import { ensureCsrfCookie, getCsrfToken } from "@app/lib/auth/csrf";
import { getElectronBridge } from "@app/runtime/electron-bridge";

export async function addCloudMutationHeaders(headers: Headers): Promise<void> {
  headers.set("Content-Type", "application/json");
  if (!getElectronBridge()) {
    await ensureCsrfCookie();
    const csrf = getCsrfToken();
    if (csrf) {
      headers.set("X-CSRFToken", csrf);
    }
  }
}
