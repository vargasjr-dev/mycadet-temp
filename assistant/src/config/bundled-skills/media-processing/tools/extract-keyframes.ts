import { dirname, join } from "node:path";

import {
  getKeyframesForAsset,
  getMediaAssetById,
} from "../../../../persistence/media-store.js";
import { throwIfCancelled } from "../../../../plugin-api/tool-cancellation.js";
import { isAbortLikeError } from "../../../../tools/shared/abort.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import {
  preprocessForAsset,
  type PreprocessOptions,
} from "../services/preprocess.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId =
    typeof input.asset_id === "string" ? input.asset_id : undefined;
  if (!assetId) {
    return { content: "asset_id is required.", isError: true };
  }

  const includeAudio = Boolean(input.include_audio);

  const options: PreprocessOptions = {
    intervalSeconds:
      (typeof input.interval_seconds === "number"
        ? input.interval_seconds
        : undefined) || undefined,
    segmentDuration:
      (typeof input.segment_duration === "number"
        ? input.segment_duration
        : undefined) || undefined,
    deadTimeThreshold:
      (typeof input.dead_time_threshold === "number"
        ? input.dead_time_threshold
        : undefined) || undefined,
    sectionConfigPath:
      (typeof input.section_config === "string"
        ? input.section_config
        : undefined) || undefined,
    detectDeadTime:
      input.detect_dead_time !== undefined
        ? Boolean(input.detect_dead_time)
        : undefined,
    shortEdge:
      (typeof input.short_edge === "number" ? input.short_edge : undefined) ||
      undefined,
    includeAudio,
  };

  throwIfCancelled(context);

  try {
    const manifest = await preprocessForAsset(
      assetId,
      options,
      context.onOutput,
      // Segmentation spawns ffmpeg per segment and can transcribe each one, so
      // the run is long enough that a stopped turn must not carry it on.
      context.signal ? { signal: context.signal } : undefined,
    );

    const asset = getMediaAssetById(assetId);
    const pipelineDir = join(dirname(asset!.filePath), "pipeline", assetId);
    const keyframes = getKeyframesForAsset(assetId);

    return {
      content: JSON.stringify(
        {
          message: `Preprocessed video: ${manifest.segments.length} segments, ${keyframes.length} keyframes`,
          assetId,
          segmentCount: manifest.segments.length,
          keyframeCount: keyframes.length,
          deadTimeRanges: manifest.deadTimeRanges.length,
          subjectGroups: manifest.subjectRegistry.groups.length,
          manifestPath: join(pipelineDir, "manifest.json"),
          config: manifest.config,
        },
        null,
        2,
      ),
      isError: false,
    };
  } catch (err) {
    // A cancelled turn is not a preprocess failure: let it reach the executor's
    // abort handling instead of being rendered as a tool error.
    if (isAbortLikeError(err)) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.startsWith("Media asset not found:") ||
      msg.startsWith("Preprocess requires a video asset.") ||
      msg.startsWith("Video asset has no duration") ||
      msg.startsWith("ffmpeg failed:") ||
      msg === "No frames were extracted from the video."
    ) {
      return { content: msg, isError: true };
    }
    return { content: `Preprocess failed: ${msg}`, isError: true };
  }
}
