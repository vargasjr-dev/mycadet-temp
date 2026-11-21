import { startApp } from "@mycadet/electron-desktop";

// This shell's toast-helper identity: the supervised sidecar's executable
// name, its dev-override env var, and the sidecar client name it registers
// under. startApp resolves the binary and builds the factory; absent a
// helper binary, the shared default electron.Notification path delivers
// click-only toasts. Everything else in the lifecycle — the lock, the
// schemes, the launch capture, the universal surface, the CLI provisioning,
// the second-instance focus — is startApp's.
startApp({
  helperToastExecutable: "cadet-linux-helper",
  helperToastOverrideEnvVar: "CADET_LINUX_HELPER_PATH",
  helperToastName: "linux-helper",
});
