import {
  isAllowedOrigin,
  type AllowedOrigin,
} from "@mycadet/electron-desktop/app-origin";

import { APP_HOST, APP_PROTOCOL } from "./app-config";

export type { AllowedOrigin };
export { isAllowedOrigin };

/**
 * Dev packs the renderer dists (`bun run dev`) and serves them through
 * the same `app://mycadet.ai` protocol handler as packaged builds, so
 * the allowed origin is a build-independent constant.
 */
export const resolveAllowedOrigin = (): AllowedOrigin => ({
  protocol: `${APP_PROTOCOL}:`,
  host: APP_HOST,
});
