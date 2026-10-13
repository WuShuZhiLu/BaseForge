function normalizeVersion(version) {
  return String(version || "").replace(/^v/, "").trim();
}

function requiredMacReleaseAssets(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) throw new Error("release version is required");
  return [
    `Base-Notes-${normalized}-x64.dmg`,
    `Base-Notes-${normalized}-arm64.dmg`,
    `Base-Notes-${normalized}-x64.zip`,
    `Base-Notes-${normalized}-arm64.zip`,
    "latest-mac.yml",
  ];
}

function findMissingMacReleaseAssets(assetNames, version) {
  const available = new Set(Array.from(assetNames || [], (name) => String(name)));
  return requiredMacReleaseAssets(version).filter((name) => !available.has(name));
}

function assertCompleteMacReleaseAssets(assetNames, version, source = "macOS release assets") {
  const missing = findMissingMacReleaseAssets(assetNames, version);
  if (missing.length > 0) {
    throw new Error(`${source} incomplete; missing: ${missing.join(", ")}`);
  }
  return requiredMacReleaseAssets(version);
}

function isMacManualDownloadZip(name) {
  return /^Base-Notes-\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?-(?:x64|arm64)\.zip$/i.test(String(name || ""));
}

module.exports = {
  assertCompleteMacReleaseAssets,
  findMissingMacReleaseAssets,
  isMacManualDownloadZip,
  requiredMacReleaseAssets,
};
