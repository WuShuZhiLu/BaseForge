/**
 * electron-builder 配置
 * @type {import('electron-builder').Configuration}
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const {
  verifySyncNotificationUi,
} = require("../scripts/verify-sync-notification-ui.cjs");

// ===== 目标平台 / 架构推断（用于定位内嵌 Node 二进制） =====
// argv 中可能包含 --win / --mac / --linux（electron-builder 的平台开关）；
// 没有则按 process.platform 推断。
function inferTargetPlatformFromArgv() {
  const argv = process.argv.join(" ");
  if (/\s--win(\s|=|$)/.test(argv)) return "win32";
  if (/\s--mac(\s|=|$)/.test(argv)) return "darwin";
  if (/\s--linux(\s|=|$)/.test(argv)) return "linux";
  return process.platform;
}

function inferTargetArch(targetPlatform) {
  const explicit = process.env.npm_config_target_arch || process.env.TARGET_ARCH;
  if (explicit) return explicit;
  if (targetPlatform === "darwin" && process.env.NOWEN_MAC_ARCH) {
    return process.env.NOWEN_MAC_ARCH === "arm64" ? "arm64" : "x64";
  }
  return process.arch;
}

/**
 * 内嵌 node 二进制所在目录名，与 scripts/fetch-node.mjs 的 TARGETS key 保持一致。
 * 目录结构：electron/node/<platform>-<arch>/node[.exe]
 */
function embeddedNodePlatformDir() {
  const platform = inferTargetPlatformFromArgv();
  const arch = inferTargetArch(platform);
  if (platform === "win32") return "win32-x64";
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64";
  return `${platform}-${arch}`;
}

/** 内嵌 node 的最低版本：node:sqlite 自 22.5.0 起提供。 */
const MIN_EMBED_NODE_MAJOR = 22;

/**
 * 校验内嵌 node 存在且版本够新。
 * 少了它打包不会报错，但装到用户机上后端会因为 `Cannot find module 'node:sqlite'`
 * 直接启动失败——所以在打包前拦住。
 */
function checkEmbeddedNode() {
  const dirName = embeddedNodePlatformDir();
  const targetPlatform = dirName.split("-")[0];
  const exeName = targetPlatform === "win32" ? "node.exe" : "node";
  const nodeFile = path.resolve(__dirname, "node", dirName, exeName);
  if (!fs.existsSync(nodeFile)) {
    throw new Error(
      `[builder] 未找到内嵌 Node 二进制：${nodeFile}\n` +
        `后端依赖内建 node:sqlite，打包必须内嵌 Node ${MIN_EMBED_NODE_MAJOR}+。\n` +
        `修复：npm run fetch:node（跨平台打包用 npm run fetch:node:all）`
    );
  }

  // 跨平台打包时目标二进制在本机跑不起来（Windows exe 不能在 Linux 上执行），
  // 只校验文件存在；同平台时才真的问它版本。
  if (targetPlatform !== process.platform) {
    console.log(`[builder] ✓ embedded node found (${dirName}, cross-compiling, version unverified)`);
    return;
  }

  const probe = require("child_process").spawnSync(nodeFile, ["-p", "process.versions.node"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    throw new Error(
      `[builder] 内嵌 Node 无法执行：${nodeFile}\n${(probe.stderr || "").trim()}`
    );
  }
  const version = (probe.stdout || "").trim();
  const major = Number.parseInt(version.split(".")[0], 10);
  if (!Number.isFinite(major) || major < MIN_EMBED_NODE_MAJOR) {
    throw new Error(
      `[builder] 内嵌 Node 版本过低：v${version}（要求 >= ${MIN_EMBED_NODE_MAJOR}）\n` +
        `后端需要 node:sqlite。修复：执行 npm run fetch:node 重新下载。`
    );
  }
  console.log(`[builder] ✓ embedded node v${version} (${dirName})`);
}

// 允许把输出目录放到工作区外，避免 IDE / Defender 对打包产物做文件监听锁
// 用法：set NOWEN_BUILD_OUT=1 && npm run electron:build
const OUT_DIR = process.env.NOWEN_BUILD_OUT
  ? path.join(os.tmpdir(), "nowen-note-build")
  : "dist-electron";

// ===== 跨平台打 Windows 目标时的 rcedit / 代码签名处理 =====
//
// 背景：
//   在 Linux（Debian）上跨平台打 Windows exe 时，electron-builder 会：
//     1) 通过 wine 调 rcedit.exe 修改 exe 的图标、版本号、产品名
//     2) 如果提供了 CSC_LINK，用 osslsigncode 或 signtool 做代码签名
//   rcedit 本身没问题，但首次会从 GitHub 下载 winCodeSign 压缩包（~60MB），
//   国内网络可能卡很久甚至失败。
//
// 环境变量：
//   NOWEN_SKIP_RCEDIT=1         完全跳过 rcedit（exe 图标/版本信息用 electron 默认）
//                               （适合没配 CSC、且首次 debian 打包想快速出包时）
//   CSC_LINK / CSC_KEY_PASSWORD 有则正常签名；没配则 electron-builder 自动跳过
//
// 判定策略：
//   - 显式 NOWEN_SKIP_RCEDIT=1  -> 强制 false
//   - 否则默认 true（保持原行为：注入图标、版本元信息、走签名流程）
const SKIP_RCEDIT = process.env.NOWEN_SKIP_RCEDIT === "1";
const SIGN_AND_EDIT_EXECUTABLE = !SKIP_RCEDIT;

// ===== Linux 包元信息（deb 必填，否则 electron-builder 会 warn）=====
// 这些字段同时被 AppImage 和 deb 使用
const LINUX_MAINTAINER =
  process.env.NOWEN_LINUX_MAINTAINER || "BaseForge <noreply@baseforge.local>";
const LINUX_VENDOR = process.env.NOWEN_LINUX_VENDOR || "BaseForge";
const LINUX_HOMEPAGE =
  process.env.NOWEN_LINUX_HOMEPAGE || "https://github.com/cropflre/nowen-note";

// ===== 体积优化：精简后端 node_modules =====
// 后端通过 esbuild bundle 成单文件（backend/dist/index.js），
// 但仍有少量"必须保留为 external"的包：
//   - sqlite-vec / sqlite-vec-{platform}-{arch}  平台二进制 .so/.dll/.dylib
//   - bonjour-service           涉及 multicast-dns 的动态行为，传递依赖较深
// 其他业务依赖已全部 inline 进 bundle，运行时不再需要。
//
// 我们用"白名单顶层目录"的方式精准保留这些包及其运行时传递依赖。
const BACKEND_KEEP_PACKAGES = [
  // sqlite-vec + 全平台二进制（让同一份 backend/node_modules 可跨平台打包）
  "sqlite-vec",
  "sqlite-vec-windows-x64",
  "sqlite-vec-darwin-x64",
  "sqlite-vec-darwin-arm64",
  "sqlite-vec-linux-x64",
  "sqlite-vec-linux-arm64",
  // bonjour-service + 运行时传递依赖
  "bonjour-service",
  "multicast-dns",
  "dns-packet",
  "@leichtgewicht",        // 整个 scope (含 ip-codec)
  "thunky",
];

// 生成 electron-builder filter 规则（路径相对 from 目录，即 backend/node_modules 根）
//
// 策略：
//   1. 先用 "!**" 排除一切
//   2. 对白名单包的整棵子树重新加回
//   3. 再去掉每个包里的 docs / tests / *.md / *.ts 等非运行时文件
function buildBackendNodeModulesFilter() {
  const rules = [];
  // 第一步：排除一切
  rules.push("!**/*");
  // 第二步：白名单包的顶层目录整个加回
  for (const pkg of BACKEND_KEEP_PACKAGES) {
    // 对 @scope/xxx 这种路径，electron-builder 的 glob 能正确处理 "@xxx/**"
    rules.push(`${pkg}/**/*`);
  }
  // 第三步：在保留的包里，剔除显然不需要的文件/目录
  rules.push("!**/{test,tests,docs,doc,examples,example,benchmark,benchmarks}/**");
  rules.push("!**/*.{md,markdown,ts,map}");
  // 注意：不能排除 *.d.ts ？其实 d.ts 和 .ts 已被上一条覆盖
  rules.push("!**/CHANGELOG*");
  rules.push("!**/LICENSE*");
  rules.push("!**/{AUTHORS,CONTRIBUTORS,HISTORY}*");
  return rules;
}

module.exports = {
  appId: "com.nowen.note",
  productName: "BaseForge",
  // 打包前校验内嵌 Node 与前端产物，避免装到用户机后才崩
  beforeBuild() {
    // 后端要跑在内嵌的 Node 22 上（node:sqlite），这是硬前提
    checkEmbeddedNode();
    verifySyncNotificationUi();
    return true; // 返回 true 表示继续打包
  },
  directories: {
    output: OUT_DIR,
    // 图标、entitlements 等打包资源统一放 build/ 下
    buildResources: "build",
  },
  // 仅打包中英两种语言；默认会有 100+ 种 locale，约占 36MB
  electronLanguages: ["en-US", "zh-CN"],
  // GitHub Releases 作为自动更新 feed
  // 发布时需设置 GH_TOKEN 环境变量；私有仓库需 private: true
  //
  // Channel 策略：
  //   full 版发布走 electron-builder 默认的 "latest" channel（latest.yml），
  //   lite 版在 builder.lite.config.js 显式声明 channel: "lite"（latest-lite.yml）。
  //   两者完整互不影响：
  //     - full 客户端只从 latest*.yml 拉取 → 永远收不到 lite 增量
  //     - lite 客户端只从 latest-lite*.yml 拉取 → 永远收不到 full 增量
  //   这样即便同一 GitHub Release 同时上传了 full + lite 二进制，自动更新
  //   也不会出现"full 安装包被误升级成 lite"的灾难。
  publish: [
    {
      provider: "github",
      owner: "WuShuZhiLu",
      repo: "BaseForge",
      releaseType: "release",
      // channel 省略 = "latest"（保留 electron-builder 默认行为）
    },
  ],
  files: [
    "electron/**/*",
    "!electron/builder.config.js",
    "!electron/builder.lite.config.js",
    "!electron/node/**/*",
    // package.json 用于 electron-builder 读取 dependencies 并自动收集运行时依赖
    "package.json",
    // node_modules/**/* 已删除：electron-builder 会自动从 package.json 的 dependencies
    // 收集运行时依赖，无需手动指定整个 node_modules 目录
  ],
  // ==== 文件关联：双击 .md / .markdown / .txt 用 BaseForge 打开 ====
  // 注意：AppImage 构建器不支持 ext 为数组，必须拆成多个独立条目
  fileAssociations: [
    {
      ext: "md",
      name: "Markdown Document",
      description: "Markdown Document",
      role: "Editor",
    },
    {
      ext: "markdown",
      name: "Markdown Document",
      description: "Markdown Document",
      role: "Editor",
    },
    {
      ext: "txt",
      name: "Plain Text Document",
      description: "Plain Text Document",
      role: "Editor",
    },
  ],
  // 内嵌一份真正的 Node 22 二进制（scripts/fetch-node.mjs 下载 → electron/node/<platform>/）。
  // 后端用内建 node:sqlite，而 Electron 33 基于 Node 20 没有这个模块，
  // 所以打包后必须用内嵌 node 跑后端，不能用 ELECTRON_RUN_AS_NODE 兜底。
  extraResources: [
    {
      from: `electron/node/${embeddedNodePlatformDir()}`,
      to: `node/${embeddedNodePlatformDir()}`,
      filter: ["**/*"],
    },
    {
      from: "backend/dist",
      to: "backend/dist",
      filter: ["**/*"],
    },
    {
      from: "backend/node_modules",
      to: "backend/node_modules",
      filter: buildBackendNodeModulesFilter(),
    },
    {
      from: "backend/package.json",
      to: "backend/package.json",
    },
    {
      from: "backend/templates",
      to: "backend/templates",
      filter: ["**/*"],
    },
    {
      from: "frontend/dist",
      to: "frontend/dist",
      filter: ["**/*"],
    },
  ],
  win: {
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ],
    icon: "electron/icon.png",
    // ==== Windows 代码签名（EV 证书推荐） ====
    // 通过环境变量传入，避免把敏感信息写进仓库：
    //   CSC_LINK        - 证书文件 (base64 或本地路径)
    //   CSC_KEY_PASSWORD- 证书密码
    // CI 未提供证书时 electron-builder 会自动跳过签名。
    //
    // signAndEditExecutable：
    //   默认 true -> 通过 rcedit 修改 exe 图标/版本号，并在有证书时签名
    //   设 NOWEN_SKIP_RCEDIT=1 则跳过（跨平台首次打 Win 不想等 winCodeSign 下载时可用）
    signAndEditExecutable: SIGN_AND_EDIT_EXECUTABLE,
    signDlls: false,
    // 若使用 Azure Code Signing / Cloud HSM，可改用 signingHashAlgorithms + signtoolOptions
    signingHashAlgorithms: ["sha256"],
    verifyUpdateCodeSignature: true,
    publisherName: "BaseForge",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "BaseForge",
  },
  portable: {
    artifactName: "BaseForge-${version}-portable.${ext}",
  },
  mac: {
    // ==== mac 架构选择 ====
    // 每次只打一个架构，由外层脚本 (release.sh) 跑两遍，通过环境变量
    // NOWEN_MAC_ARCH=x64|arm64 控制；默认 x64（覆盖 Intel + 走 Rosetta）。
    target: [
      {
        target: "dmg",
        arch: [process.env.NOWEN_MAC_ARCH === "arm64" ? "arm64" : "x64"],
      },
      {
        target: "zip",
        arch: [process.env.NOWEN_MAC_ARCH === "arm64" ? "arm64" : "x64"],
      },
    ],
    // 两个 mac 架构分两次构建，文件名必须带 ${arch}，否则后一次会覆盖前一次，
    // Release 资产看似有 Intel/Apple Silicon，实际可能指向同一份错架构包。
    artifactName: "BaseForge-${version}-${arch}.${ext}",
    icon: "electron/icon.png",
    category: "public.app-category.productivity",
    // ==== macOS 代码签名 + 公证 ====
    // 通过环境变量提供（推荐用 GitHub Actions secrets）：
    //   CSC_LINK / CSC_KEY_PASSWORD               - Developer ID Application 证书
    //   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD    - 公证所需（或用 APPLE_API_KEY）
    //   APPLE_TEAM_ID                             - 团队 ID
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: false, // 交给 afterSign 钩子处理；本地缺少 Apple 凭据时会自动跳过
  },
  // macOS 公证钩子。仅 darwin 生效；本地缺少 Apple 凭据时不会阻断构建。
  afterSign: "build/afterSign.js",
  linux: {
    target: ["AppImage", "deb"],
    icon: "electron/icon.png",
    // FreeDesktop 规范分类：https://specifications.freedesktop.org/menu-spec/latest/apa.html
    // Office 是顶级分类；笔记类一般还加 TextTools / Utility
    category: "Office",
    // Linux mimeType 绑定：系统双击 .md 时会优先提示用 BaseForge 打开
    mimeTypes: ["text/markdown", "text/plain"],
    // deb 需要 maintainer；AppImage 也会读 vendor 写进 metadata
    // 可通过环境变量 NOWEN_LINUX_MAINTAINER / NOWEN_LINUX_VENDOR / NOWEN_LINUX_HOMEPAGE 覆盖
    maintainer: LINUX_MAINTAINER,
    vendor: LINUX_VENDOR,
    synopsis: "Modern note-taking application",
    description:
      "BaseForge — 一个现代化的笔记应用，支持 Markdown、全文搜索、跨设备局域网同步。",
    // 桌面文件额外字段
    desktop: {
      entry: {
        StartupWMClass: "BaseForge",
        Keywords: "note;markdown;editor;nowen;",
      },
    },
    // Linux x64 / arm64 会分两次构建；文件名必须带架构，避免互相覆盖。
    artifactName: "BaseForge-${version}-${arch}.${ext}",
  },
  // deb 专属字段（maintainer/description 已在上面 linux 里兜底，这里补 priority / section）
  deb: {
    priority: "optional",
    // section 对应 Debian 软件分类：https://packages.debian.org/sections
    // editors / utils / text 都可；editors 更贴合
    // （注意：deb.category 字段不存在，分类用 fpm 的 section）
  },
  appImage: {
    // AppImage 一般不需要额外配；保留空对象方便以后加
  },
};
