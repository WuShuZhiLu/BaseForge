/**
 * Stable release wrapper around the Lite desktop builder configuration.
 *
 * Lite uses an explicit latest-lite channel so release.sh can collect the
 * metadata without mixing it with the full latest channel.
 */
const base = require("./builder.lite.base.config.js");

const WINDOWS_PUBLISHER_NAME = process.env.NOWEN_WINDOWS_PUBLISHER_NAME?.trim() || "";
const { artifactName: _legacyWindowsArtifactName, ...baseWin } = base.win || {};
const win = {
  ...baseWin,
  ...(WINDOWS_PUBLISHER_NAME ? { publisherName: WINDOWS_PUBLISHER_NAME } : {}),
};

module.exports = {
  ...base,
  publish: (base.publish || []).map((provider) => ({
    ...provider,
    channel: "latest-lite",
  })),
  files: [
    ...(Array.isArray(base.files) ? base.files : []),
    "!electron/builder.base.config.js",
    "!electron/builder.lite.base.config.js",
  ],
  win,
  nsis: {
    ...(base.nsis || {}),
    artifactName: "BaseForge-${version}-lite-setup.${ext}",
  },
  portable: {
    ...(base.portable || {}),
    artifactName: "BaseForge-${version}-lite-portable.${ext}",
  },
  mac: {
    ...(base.mac || {}),
    artifactName: "BaseForge-${version}-lite-${arch}.${ext}",
  },
  dmg: {
    ...(base.dmg || {}),
    artifactName: "BaseForge-${version}-lite-${arch}.${ext}",
  },
  linux: {
    ...(base.linux || {}),
    artifactName: "BaseForge-${version}-lite-${arch}.${ext}",
  },
  appImage: {
    ...(base.appImage || {}),
    artifactName: "BaseForge-${version}-lite-${arch}.${ext}",
  },
};
