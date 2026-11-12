import {
  createBaseForgePackageExport,
  type PreparedMarkdownPackageNote,
} from "./baseforgePackageExport";
import { ensureBaseForgeInstanceEnvironment } from "./baseforgeInstanceIdentity";
import { addPermissionsToBaseForgePackageExport } from "./roundTripPermissionTransfer";

export type { PreparedMarkdownPackageNote };

type StableExportParams = Parameters<typeof createBaseForgePackageExport>[0] & {
  includePermissions?: boolean;
};

/**
 * Ensure all user-facing Round-trip packages carry a stable sourceInstanceId.
 * Permission/member data remains an explicit admin-only extension and is omitted by default.
 */
export async function createStableBaseForgePackageExport(
  params: StableExportParams,
): Promise<Awaited<ReturnType<typeof createBaseForgePackageExport>>> {
  ensureBaseForgeInstanceEnvironment();
  const { includePermissions = false, ...baseParams } = params;
  const result = await createBaseForgePackageExport(baseParams);
  if (!includePermissions) return result;
  if (!baseParams.workspaceId) throw new Error("成员与权限只能随工作区 BaseForge 无损包导出");
  return addPermissionsToBaseForgePackageExport({
    result,
    userId: baseParams.userId,
    workspaceId: baseParams.workspaceId,
  });
}
