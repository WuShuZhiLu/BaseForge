import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(path.resolve(__dirname, "../../App.tsx"), "utf8");
const routeSyncSource = readFileSync(path.resolve(__dirname, "../AppRouteSync.tsx"), "utf8");
const appRouteSource = readFileSync(path.resolve(__dirname, "../../lib/appRoute.ts"), "utf8");

/**
 * 回归：/mindmaps 与 /mindmaps/:id 的消费者。
 *
 * 曾经只有 pushMindMapAppPath（导图块「进入思维导图」/ 列表选中导图）会改 URL，
 * 而消费端没有任何代码把导图路由映射回视图状态——
 * 于是 URL 变成 /mindmaps/:id 但模块不切换，看起来"点了没反应"。
 *
 * 统一路由所有者（AppRouteSync，见 .cmp/PLAN-ROUTE-OWNER.md）后：
 * 解析收敛到 lib/appRoute.ts，分发收敛到 AppRouteSync，视图消费 state.route。
 */
describe("App mind map route wiring", () => {
  it("parses the mind map route in the unified route model", () => {
    expect(appRouteSource).toContain('kind: "mindmap"');
    expect(appRouteSource).toContain("parseMindMapAppPath");
  });

  it("dispatches the mind map route into the view mode via the route owner", () => {
    expect(routeSyncSource).toContain('actions.setViewMode("mindmaps")');
  });

  it("passes the routed id into MindMapCenter so the requested map is selected", () => {
    expect(appSource).toContain("routeMindMapId=");
    expect(appSource).toContain("documentMode=");
    expect(appSource).toContain('route.kind === "mindmap"');
  });

  it("keeps the URL and the mind map module in sync in both directions", () => {
    // 离开导图模块时清 /mindmaps（AppRouteSync 写侧 B 规则），且命令式入口仍可 push。
    expect(routeSyncSource).toContain('write("/mindmaps", "replace")');
    expect(routeSyncSource).toContain('write("/", "replace")');
    // pendingOpenMindMapId 由 MindMapEditor 独占消费（读后即删）；App 不得再读（子 effect
    // 先于父 effect，App 端读到的一律是空值）。契约锁定单一所有者。
    expect(appSource).not.toContain('sessionStorage.getItem("pendingOpenMindMapId")');
  });
});
