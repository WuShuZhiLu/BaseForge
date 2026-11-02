/**
 * 契约同步守卫：能力目录与 SDK 生成物都必须跟得上 contribution-contract.json。
 *
 * 背景：两个 .generated 文件此前靠手工同步（生成脚本已丢失），结果 backend 的能力目录
 *  一度停在契约 v4，而 SDK 已到 v6 —— 后端按旧目录判定"不支持的贡献点"，新插件
 *  装得上但行为缺失。现在生成物由 scripts/generate-plugin-contracts.mjs 产出，这个测试
 *  负责在 CI 里拦住"改了契约没重新生成"的提交。
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test";
import { EXTENSION_CAPABILITY_CATALOG } from "../src/plugins/capabilityCatalog.generated.js"

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const contract = JSON.parse(
  readFileSync(path.join(rootDir, "packages", "nowen-plugin-sdk", "contribution-contract.json"), "utf8"),
) as {
  contractVersion: number
  namespaceTemplate: string
  runtimes: string[]
  types: Array<{ id: string; since: string; runtimes: string[]; declarative: boolean; description: string }>
}

const catalogContributions = (EXTENSION_CAPABILITY_CATALOG as { contributions: typeof contract }).contributions

test("能力目录的 contributions 与契约版本一致", () => {
  assert.equal(
    catalogContributions.contractVersion,
    contract.contractVersion,
    "能力目录落后于契约：运行 node scripts/generate-plugin-contracts.mjs",
  )
  assert.equal(catalogContributions.namespaceTemplate, contract.namespaceTemplate)
  assert.deepEqual(catalogContributions.runtimes, contract.runtimes)
})

test("能力目录的贡献点类型集合与契约完全一致", () => {
  const catalogIds = catalogContributions.types.map((entry) => entry.id).sort()
  const contractIds = contract.types.map((entry) => entry.id).sort()
  assert.deepEqual(catalogIds, contractIds, "能力目录的贡献点集合与契约不一致")
})

test("每个贡献点的 since / runtimes / declarative 与契约一致", () => {
  for (const expected of contract.types) {
    const actual = catalogContributions.types.find((entry) => entry.id === expected.id)
    assert.ok(actual, `能力目录缺少贡献点 ${expected.id}`)
    assert.equal(actual.since, expected.since, `${expected.id} 的 since 不一致`)
    assert.deepEqual(actual.runtimes, expected.runtimes, `${expected.id} 的 runtimes 不一致`)
    assert.equal(actual.declarative, expected.declarative, `${expected.id} 的 declarative 不一致`)
  }
})
