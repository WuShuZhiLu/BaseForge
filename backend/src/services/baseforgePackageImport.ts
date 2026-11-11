import { executeBaseForgePackageImportWithBatch } from "./roundTripImportBatches";
import {
  attachRoundTripImportLinkUndo,
  captureRoundTripImportLinkUndo,
} from "./roundTripImportLinkUndo";
import {
  applyRoundTripPermissions,
  augmentRoundTripPermissionPreview,
  type RoundTripPermissionMappings,
} from "./roundTripPermissionTransfer";
import {
  importBaseForgePackageWithSync,
  type RoundTripImportParams,
} from "./baseforgeRoundTripSync";

export interface ImportParams extends RoundTripImportParams {
  applyPermissions?: boolean;
  permissionMappings?: RoundTripPermissionMappings;
}

export async function importBaseForgePackage(zipBuffer: Buffer, params: ImportParams): Promise<any> {
  if (params.dryRun) {
    const preview = await importBaseForgePackageWithSync(zipBuffer, params);
    return augmentRoundTripPermissionPreview(zipBuffer, params, preview);
  }

  const linkSnapshot = await captureRoundTripImportLinkUndo(zipBuffer, params.userId, params.workspaceId);
  let result = await executeBaseForgePackageImportWithBatch(zipBuffer, params);
  const batchId = String(result?.importBatch?.id || "");
  if (batchId && result?.success) {
    const attached = attachRoundTripImportLinkUndo(params.userId, batchId, linkSnapshot);
    if (!attached.available) {
      result.importBatch = {
        ...(result.importBatch || {}),
        undoAvailable: false,
        reason: attached.reason ?? result.importBatch?.reason ?? null,
      };
    }
    result = await applyRoundTripPermissions(zipBuffer, params, result, batchId);
  }
  return result;
}

export type {
  RoundTripSyncImportMode as RoundTripImportMode,
  RoundTripSyncStrategy as RoundTripConflictStrategy,
} from "./baseforgeRoundTripSync";
export type { ImportConflict } from "./baseforgePackageImportV2";
