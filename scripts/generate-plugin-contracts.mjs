#!/usr/bin/env node
/**
 * 从 contribution-contract.json 生成两处"生成物"，消除手工同步漂移。
 *
 * 背景：这两个文件此前由 scripts/generate-plugin-host-api.mjs 生成，但该脚本已不在仓库内
 * （文件头仍在引用它），导致每次契约变更都要手改生成物：SDK 侧靠"手工同步注明"，
 * backend 侧的能力目录一度落后到契约 v4。现在以契约 JSON 为唯一真相重新生成。
 *
 * 用法：
 *   node scripts/generate-plugin-contracts.mjs            # 写入
 *   node scripts/generate-plugin-contracts.mjs --check    # 只校验是否最新（CI 用，落后则退出码 1）
 *
 * 产出：
 *   1) packages/baseforge-plugin-sdk/src/contributions.generated.ts
 *   2) backend/src/plugins/capabilityCatalog.generated.ts 的 contributions 段 + 摘要
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const contractPath = path.join(rootDir, "packages", "baseforge-plugin-sdk", "contribution-contract.json")
const sdkOutPath = path.join(rootDir, "packages", "baseforge-plugin-sdk", "src", "contributions.generated.ts")
const catalogPath = path.join(rootDir, "backend", "src", "plugins", "capabilityCatalog.generated.ts")

const checkOnly = process.argv.includes("--check")
const contract = JSON.parse(readFileSync(contractPath, "utf8"))

/** 契约里的 limits 键 → SDK 导出常量名 */
const LIMITS_EXPORTS = [
  ["noteTheme", "NOTE_THEME_CONTRIBUTION_LIMITS"],
  ["noteTemplate", "NOTE_TEMPLATE_CONTRIBUTION_LIMITS"],
  ["promptPack", "PROMPT_PACK_CONTRIBUTION_LIMITS"],
  ["activityBadge", "ACTIVITY_BADGE_CONTRIBUTION_LIMITS"],
  ["sidebarPanel", "SIDEBAR_PANEL_CONTRIBUTION_LIMITS"],
  ["uiComponent", "UI_COMPONENT_CONTRIBUTION_LIMITS"],
  ["editorCommand", "EDITOR_COMMAND_CONTRIBUTION_LIMITS"],
]

const json = (value) => JSON.stringify(value, null, 2).split("\n").join("\n")

function buildSdkFile() {
  const types = [...contract.types].sort((a, b) => a.id.localeCompare(b.id))
  const runtimeUnion = contract.runtimes.map((runtime) => `"${runtime}"`).join(" | ")
  const typeUnion = types.map((entry) => `"${entry.id}"`).join(" | ")

  const limits = LIMITS_EXPORTS
    .filter(([key]) => contract[key] !== undefined)
    .map(([key, name]) => `export const ${name} = deepFreeze(${json(contract[key])} as const);`)
    .join("\n")

  return `// 此文件由 scripts/generate-plugin-contracts.mjs 根据 packages/baseforge-plugin-sdk/contribution-contract.json 生成，请勿手动修改。
// 重新生成：node scripts/generate-plugin-contracts.mjs
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type PluginContributionRuntime = ${runtimeUnion};
export type PluginContributionType = ${typeUnion};

export interface PluginContributionContractEntry {
  id: PluginContributionType;
  since: string;
  runtimes: readonly PluginContributionRuntime[];
  declarative: boolean;
  description: string;
}

export const CONTRIBUTION_CONTRACT_VERSION = ${contract.contractVersion} as const;
export const CONTRIBUTION_NAMESPACE_TEMPLATE = ${JSON.stringify(contract.namespaceTemplate)} as const;
export const CONTRIBUTION_CONTRACT: readonly PluginContributionContractEntry[] = deepFreeze(${json(types)});
${limits}
`
}

/** 从 catalog 文本里截出 contributions 对象（按大括号配平），返回 [start, end) 区间 */
function findContributionsBlock(text) {
  const marker = '  "contributions": {'
  const start = text.indexOf(marker)
  if (start < 0) throw new Error('capabilityCatalog.generated.ts 里找不到 "contributions" 段')
  let index = start + marker.length - 1
  let depth = 0
  for (; index < text.length; index += 1) {
    const char = text[index]
    if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) {
        index += 1
        break
      }
    }
  }
  return [start, index]
}

/**
 * 能力目录里的 contributions 段是契约的裁剪快照（只保留 id/since/runtimes/declarative/description），
 * 保持与 SDK 生成物同源，避免两处演进节奏不一致。
 */
function buildCatalogContributions() {
  return {
    contractVersion: contract.contractVersion,
    namespaceTemplate: contract.namespaceTemplate,
    runtimes: contract.runtimes,
    types: [...contract.types]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => ({
        id: entry.id,
        since: entry.since,
        runtimes: entry.runtimes,
        declarative: entry.declarative,
        description: entry.description,
      })),
  }
}

function buildCatalogFile() {
  const original = readFileSync(catalogPath, "utf8")
  const [start, end] = findContributionsBlock(original)
  const contributionsText = JSON.stringify(buildCatalogContributions(), null, 2)
  // 段内的缩进与文件其余部分一致（每行前导两空格）
  const indented = contributionsText.split("\n").map((line, i) => (i === 0 ? `  "contributions": ${line}` : `  ${line}`)).join("\n")
  let next = `${original.slice(0, start)}${indented}${original.slice(end)}`

  // 摘要覆盖整份目录对象文本（从 deepFreeze( 到配对的 )），保证"改了内容就换摘要"
  const openIndex = next.indexOf("EXTENSION_CAPABILITY_CATALOG = deepFreeze(")
  const bodyStart = next.indexOf("{", openIndex)
  let depth = 0
  let bodyEnd = bodyStart
  for (; bodyEnd < next.length; bodyEnd += 1) {
    const char = next[bodyEnd]
    if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) {
        bodyEnd += 1
        break
      }
    }
  }
  const digest = createHash("sha256").update(next.slice(bodyStart, bodyEnd)).digest("hex")
  next = next.replace(/export const EXTENSION_CAPABILITY_CATALOG_DIGEST = "[0-9a-f]+" as const;/, `export const EXTENSION_CAPABILITY_CATALOG_DIGEST = "${digest}" as const;`)
  return { text: next, digest }
}

const sdkText = buildSdkFile()
const { text: catalogText, digest } = buildCatalogFile()
const currentSdk = readFileSync(sdkOutPath, "utf8")
const currentCatalog = readFileSync(catalogPath, "utf8")

const sdkStale = currentSdk !== sdkText
const catalogStale = currentCatalog !== catalogText

if (checkOnly) {
  if (sdkStale || catalogStale) {
    console.error(`[generate-plugin-contracts] 生成物落后于契约（contractVersion=${contract.contractVersion}）：`)
    if (sdkStale) console.error("  - packages/baseforge-plugin-sdk/src/contributions.generated.ts")
    if (catalogStale) console.error("  - backend/src/plugins/capabilityCatalog.generated.ts")
    console.error("  运行 node scripts/generate-plugin-contracts.mjs 重新生成后提交。")
    process.exit(1)
  }
  console.log("[generate-plugin-contracts] ✓ 生成物与契约一致")
  process.exit(0)
}

if (sdkStale) writeFileSync(sdkOutPath, sdkText)
if (catalogStale) writeFileSync(catalogPath, catalogText)
console.log(`[generate-plugin-contracts] contractVersion=${contract.contractVersion}，类型 ${contract.types.length} 个`)
console.log(`  SDK 生成物：${sdkStale ? "已更新" : "无变化"}`)
console.log(`  能力目录：${catalogStale ? `已更新（摘要 ${digest.slice(0, 12)}…）` : "无变化"}`)
