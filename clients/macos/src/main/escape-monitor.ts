import { createDictationEscapeMonitor } from "@mycadet/electron-desktop";

import log from "@mycadet/electron-desktop/app-logger";
import { dispatchToMain } from "@mycadet/electron-desktop";

const monitor = createDictationEscapeMonitor({
  cancel: () => dispatchToMain({ kind: "cancelDictation" }),
  log,
});

export const setDictationRecording = monitor.setRecording;
export const installEscapeMonitor = monitor.install;
