import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { isWindows } from "../../../../util/os.js";

const PANES = {
  microphone: {
    label: "Microphone privacy",
    urls: {
      macos:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      windows: "ms-settings:privacy-microphone",
    },
  },
  speech_recognition: {
    label: "Speech Recognition privacy",
    urls: {
      macos:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
      windows: "ms-settings:privacy-speech",
    },
  },
} as const;

type PaneName = keyof typeof PANES;
type SettingsPlatform = keyof (typeof PANES)[PaneName]["urls"];

const VALID_PLATFORMS: SettingsPlatform[] = ["macos", "windows"];
const VALID_PANES = Object.keys(PANES);

function isPaneName(value: unknown): value is PaneName {
  return typeof value === "string" && Object.hasOwn(PANES, value);
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const requestedPlatform =
    typeof input.platform === "string" ? input.platform : undefined;
  const selectedPlatform = VALID_PLATFORMS.find(
    (platform) => platform === requestedPlatform,
  );
  if (requestedPlatform !== undefined && selectedPlatform === undefined) {
    return {
      content: `Error: unknown platform "${requestedPlatform}". Valid platforms: ${VALID_PLATFORMS.join(
        ", ",
      )}`,
      isError: true,
    };
  }

  const pane = input.pane;
  if (!isPaneName(pane)) {
    return {
      content: `Error: unknown pane "${pane}". Valid panes: ${VALID_PANES.join(
        ", ",
      )}`,
      isError: true,
    };
  }

  const platform = selectedPlatform ?? (isWindows() ? "windows" : "macos");
  const meta = PANES[pane];

  throwIfCancelled(context);

  if (context.sendToClient) {
    context.sendToClient({
      type: "open_url",
      url: meta.urls[platform],
      conversationId: context.conversationId,
    });
  }

  const settingsName =
    platform === "windows" ? "Windows Settings" : "System Settings";
  return {
    content: `Opened ${settingsName} to ${meta.label}. Please enable Cadet.`,
    isError: false,
  };
}
