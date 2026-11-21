import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  getMacHelperAppPath,
  getSharedHelperClient,
} from "../native-helper-client";

export type HelperPermissionKind =
  | "speechRecognition"
  | "inputMonitoring"
  | "screen";

export type HelperPermissionStatus =
  | "unknown"
  | "restricted"
  | "denied"
  | "not-determined"
  | "granted";

const HELPER_PERMISSION_STATUS_SCHEMA = z.object({
  status: z.enum([
    "unknown",
    "restricted",
    "denied",
    "not-determined",
    "granted",
  ]),
});

const REQUEST_FLAGS: Record<HelperPermissionKind, string> = {
  speechRecognition: "--request-speech-recognition",
  inputMonitoring: "--request-input-monitoring",
  screen: "--request-screen-recording",
};

/** The helper's own status over the shared client. */
export const queryHelperPermission = async (
  kind: HelperPermissionKind,
): Promise<HelperPermissionStatus> => {
  const result = await getSharedHelperClient().call("permission.status", {
    kind,
  });
  return HELPER_PERMISSION_STATUS_SCHEMA.parse(result).status;
};

/**
 * A freshly spawned helper instance re-reads its own TCC status — the answer
 * to give right after the user flips a toggle in System Settings.
 */
export const queryFreshHelperPermission = async (
  kind: HelperPermissionKind,
): Promise<HelperPermissionStatus> => {
  const result = await queryBundledHelperPermission(kind);
  return HELPER_PERMISSION_STATUS_SCHEMA.parse(result).status;
};

/** Launches the helper app so its prompt (or its grant) takes. */
export const requestHelperPermission = async (
  kind: HelperPermissionKind,
): Promise<void> => {
  await openHelperApp([REQUEST_FLAGS[kind]]);
};

const queryBundledHelperPermission = async (
  kind: HelperPermissionKind,
): Promise<unknown> => {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), "cadet-mac-helper-permission-"),
  );
  const outputPath = path.join(tempDir, "status.json");

  try {
    await openHelperApp([
      "--permission-status",
      kind,
      "--status-output",
      outputPath,
    ]);
    return await readPermissionStatusFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

const openHelperApp = async (helperArgs: string[]): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const args = ["-n", getMacHelperAppPath(), "--args", ...helperArgs];
    const child = spawn("open", args, { stdio: "ignore" });
    let settled = false;

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    child.once("error", settle);
    child.once("exit", (code) => {
      if (code === 0) {
        settle();
      } else {
        settle(new Error(`open exited with code ${code ?? "unknown"}`));
      }
    });
  });
};

const readPermissionStatusFile = async (
  outputPath: string,
): Promise<unknown> => {
  const deadline = Date.now() + 5_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(outputPath, "utf8"));
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("mac helper permission status did not appear");
};
