import { createDictationEscapeMonitor } from "@mycadet/electron-desktop";

import { log } from "@mycadet/electron-desktop";
import { dispatchToMain } from "./main-window";

const monitor = createDictationEscapeMonitor({
  cancel: () => dispatchToMain({ kind: "cancelDictation" }),
  log,
});

export const setDictationRecording = monitor.setRecording;
export const installEscapeMonitor = monitor.install;
