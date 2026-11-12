/**
 * 内嵌 Node 二进制目录（`<platform>-<arch>`）相关的纯函数，供 builder 配置与测试共用。
 */

/**
 * 内嵌 node 能否在本机直接执行。
 *
 * 只有「同平台 + 同架构」才可执行：arm64 macOS 上跑 x64 node 依赖 Rosetta，
 * 而 GitHub 的 arm64 runner 并不保证安装；跨平台（如 Linux 上备 win32 二进制）
 * 更是必然无法执行。这类情况下只能校验文件存在，不能拿执行结果做门禁。
 */
function shouldVerifyEmbeddedNodeVersion(dirName, platform = process.platform, arch = process.arch) {
  const [targetPlatform, targetArch] = String(dirName).split("-");
  return targetPlatform === platform && targetArch === arch;
}

module.exports = { shouldVerifyEmbeddedNodeVersion };
