/**
 * 数据包格式兼容层：导出始终使用 baseforge，导入额外接受 Nowen 时代的历史格式。
 * 仅用于读取兼容，不要在新导出的包或接口里使用 LEGACY_* 常量。
 */
export const PACKAGE_FORMAT = "baseforge-package";
export const LEGACY_PACKAGE_FORMAT = "nowen-package";
export const PACKAGE_APP_ID = "baseforge";
export const LEGACY_PACKAGE_APP_ID = "nowen";

export function isSupportedPackageFormat(value: unknown): boolean {
  return value === PACKAGE_FORMAT || value === LEGACY_PACKAGE_FORMAT;
}

export function isSupportedPackageApp(value: unknown): boolean {
  return value === PACKAGE_APP_ID || value === LEGACY_PACKAGE_APP_ID;
}
