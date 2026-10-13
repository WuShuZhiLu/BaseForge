import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(path.resolve(__dirname, "../../App.tsx"), "utf8");

/**
 * 回归：/mindmaps 与 /mindmaps/:id 的消费者。
 *
 * 曾经只有 pushMindMapAppPath（导图块「进入思维导图」/ 列表选中导图）会改 URL，
 * 而 App 只订阅了 /sheets 路由，没有任何代码把导图路由映射回视图状态——
 * 于是 URL 变成 /mindmaps/:id 但模块不切换，看起来"点了没反应"。
 */
describe("App mind map route wiring", () => {
  it("consumes the mind map route so entering a mind map actually switches modules", () => {
    expect(appSource).toContain("getCurrentMindMapAppRoute");
    expect(appSource).toContain("parseMindMapAppPath");
    expect(appSource).toContain('actions.setViewMode("mindmaps")');
  });

  it("passes the routed id into MindMapCenter so the requested map is selected", () => {
    expect(appSource).toContain(
      "routeMindMapId={mindMapRoute.matched ? mindMapRoute.mindMapId : undefined}",
    );
    expect(appSource).toContain(
      "documentMode={mindMapRoute.matched && mindMapRoute.mindMapId !== null}",
    );
  });

  it("keeps the URL and the mind map module in sync in both directions", () => {
    expect(appSource).toContain("replaceMindMapAppPath");
    expect(appSource).toContain('sessionStorage.getItem("pendingOpenMindMapId")');
    // 离开导图模块时必须把 /mindmaps 从 URL 清掉，否则刷新会被旧 URL 拽回导图。
    expect(appSource).toContain('replaceAppPathState("/")');
  });
});
