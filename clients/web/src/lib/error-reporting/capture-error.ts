import {
  captureError as captureSharedError,
  type CaptureErrorOptions,
} from "@mycadet/design-library/utils/capture-error";
import { isExpectedDaemonTransientError } from "@/utils/daemon-errors";


/** Web retains its daemon-specific policy around the general reporter. */
export function captureError(
  error: unknown,
  opts: CaptureErrorOptions & { bestEffort?: boolean },
): void {
  if (opts.bestEffort && isExpectedDaemonTransientError(error)) {
    return;
  }
  captureSharedError(error, opts);
}
