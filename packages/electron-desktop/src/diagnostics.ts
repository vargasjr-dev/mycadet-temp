import { z } from "zod";

import { DIAGNOSTICS_SET_SHARE } from "@mycadet/ipc-contract";

import { on } from "./ipc";

export const installDiagnosticsIpc = (
  setShareDiagnostics: (enabled: boolean) => void,
): void => {
  on(DIAGNOSTICS_SET_SHARE, z.tuple([z.boolean()]), ([enabled]) => {
    setShareDiagnostics(enabled);
  });
};
