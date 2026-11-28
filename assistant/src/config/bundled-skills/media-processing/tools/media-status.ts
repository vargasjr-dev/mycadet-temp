import {
  getMediaAssetByFilePath,
  getMediaAssetById,
  getMediaAssetsByStatus,
  getProcessingStagesForAsset,
  type MediaAssetStatus,
} from "../../../../persistence/media-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId =
    typeof input.asset_id === "string" ? input.asset_id : undefined;
  const filePath =
    typeof input.file_path === "string" ? input.file_path : undefined;
  const statusFilter = input.status_filter;

  // Query by asset ID
  if (assetId) {
    const asset = getMediaAssetById(assetId);
    if (!asset) {
      return { content: `Media asset not found: ${assetId}`, isError: true };
    }
    const stages = getProcessingStagesForAsset(asset.id);
    return {
      content: JSON.stringify({ asset, stages }, null, 2),
      isError: false,
    };
  }

  // Query by file path
  if (filePath) {
    const asset = getMediaAssetByFilePath(filePath);
    if (!asset) {
      return {
        content: `No media asset found for path: ${filePath}`,
        isError: true,
      };
    }
    const stages = getProcessingStagesForAsset(asset.id);
    return {
      content: JSON.stringify({ asset, stages }, null, 2),
      isError: false,
    };
  }

  // Query by status filter
  if (statusFilter) {
    const validStatuses: MediaAssetStatus[] = [
      "registered",
      "processing",
      "indexed",
      "failed",
    ];
    const status = validStatuses.find(
      (candidate) => candidate === statusFilter,
    );
    if (!status) {
      return {
        content: `Invalid status filter: ${statusFilter}. Valid values: ${validStatuses.join(", ")}`,
        isError: true,
      };
    }
    const assets = getMediaAssetsByStatus(status);
    const results = assets.map((asset) => ({
      asset,
      stages: getProcessingStagesForAsset(asset.id),
    }));
    return {
      content: JSON.stringify(
        {
          count: results.length,
          assets: results,
        },
        null,
        2,
      ),
      isError: false,
    };
  }

  return {
    content:
      "Provide at least one query parameter: asset_id, file_path, or status_filter.",
    isError: true,
  };
}
