import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { helperClient } from "@mycadet/electron-desktop/dictation";

import { getMacHelperAppPath } from "./sidecar/mac-helper-path";

export type MacHelperPermissionKind =
  | "speechRecognition"
  | "inputMonitoring"
  | "screen";

export type MacHelperPermissionStatus =
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

export const queryMacHelperPermission = async (
  kind: MacHelperPermissionKind,
): Promise<MacHelperPermissionStatus> => {
  const result = await helperClient().call("permission.status", { kind });
  return HELPER_PERMISSION_STATUS_SCHEMA.parse(result).status;
};

export const queryFreshMacHelperPermission = async (
  kind: MacHelperPermissionKind,
): Promise<MacHelperPermissionStatus> => {
  const result = await queryBundledMacHelperPermission(kind);
  return HELPER_PERMISSION_STATUS_SCHEMA.parse(result).status;
};

export const requestMacHelperSpeechRecognitionPermission =
  async (): Promise<void> => {
    await openMacHelperApp(["--request-speech-recognition"]);
  };

export const requestMacHelperInputMonitoringPermission =
  async (): Promise<void> => {
    await openMacHelperApp(["--request-input-monitoring"]);
  };

export const requestMacHelperScreenRecordingPermission =
  async (): Promise<void> => {
    await openMacHelperApp(["--request-screen-recording"]);
  };

const queryBundledMacHelperPermission = async (
  kind: MacHelperPermissionKind,
): Promise<unknown> => {
  const tempDir = await mkdtemp(
    path.join(tmpdir(), "cadet-mac-helper-permission-"),
  );
  const outputPath = path.join(tempDir, "status.json");

  try {
    await openMacHelperApp([
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

const openMacHelperApp = async (helperArgs: string[]): Promise<void> => {
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
