/**
 * The app bundle's error reporter: the design library's shared capture
 * (Sentry when configured, console otherwise). The web bundle's wrapper
 * adds a daemon-transient filter around the same reporter; the app's
 * doctor surface has no daemon dependency, so the reporter rides alone.
 */

export {
  captureError,
  type CaptureErrorOptions,
} from "@design/utils/capture-error";
