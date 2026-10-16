/**
 * 工具页页签契约（B2 主区页签系统）共享类型。
 *
 * 工具页要能被主区页签容器直接挂载，需满足 .cmp/PLAN-B2-TWO-AGENTS.md 第四节契约：
 * 1. 根元素自适应（flex-1 min-h-0 min-w-0，禁止 h-screen / fixed inset-0）；
 * 2. 不假设全屏宽度；
 * 3. 标题自管（TOOL_PAGE_HEADER_MODE = "own"）或交由宿主（"host"）；
 * 4. 状态可保持；
 * 5. 不自行切换全局视图（禁止 actions.setViewMode 跳工具视图）。
 *
 * 各工具页导出 `TOOL_PAGE_HEADER_MODE` 声明自己的标题模式，默认 "own"：
 * 页面自带标题行，主区顶栏在 "own" 模式下不再重复渲染标题。
 */
import { useEffect, useState } from "react";
import type { RefObject } from "react";

export type ToolPageHeaderMode = "own" | "host";

export const DEFAULT_TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own";

/**
 * 工具页隐藏态治理（keepAlive 副作用，见 .cmp/COLLAB-BOARD.md 第二节 B 的批次）。
 *
 * ToolPageHost 对每个已打开页签同时挂载（keepAlive），非激活页签用 display:none 隐藏
 * 而不卸载——隐藏页签里的定时器/轮询仍在跑。宿主在每个页签容器上写入
 * `data-tool-page-active="true|false"`（属性名 A 已固定，勿改），
 * 工具页用下面的判定实现「非激活暂停、重新激活补一次」。
 */
export const TOOL_PAGE_ACTIVE_ATTRIBUTE = "data-tool-page-active";

/**
 * 判定元素是否处于激活的工具页签内。
 * 宿主外挂载（单测 / 非页签场景）视为激活，保持既有行为。
 */
export function isToolPageElementActive(element: Element | null | undefined): boolean {
  if (!element || typeof element.closest !== "function") return true;
  const container = element.closest(`[${TOOL_PAGE_ACTIVE_ATTRIBUTE}]`);
  if (!container) return true;
  return container.getAttribute(TOOL_PAGE_ACTIVE_ATTRIBUTE) === "true";
}

/**
 * 工具页激活态 Hook。页面根元素挂 ref 后调用：
 * `const pageActive = useToolPageActive(rootRef);`
 * - 返回 false 时暂停轮询/定时器；恢复 true 时依赖它的 effect 重跑＝自动补一次刷新；
 * - 通过 MutationObserver 监听宿主容器属性翻转，无轮询开销；
 * - 非宿主挂载恒为 true。
 */
export function useToolPageActive(rootRef: RefObject<HTMLElement | null>): boolean {
  const [active, setActive] = useState(() => isToolPageElementActive(rootRef.current));
  useEffect(() => {
    const container = rootRef.current?.closest(`[${TOOL_PAGE_ACTIVE_ATTRIBUTE}]`);
    if (!(container instanceof HTMLElement)) return;
    const sync = () => setActive(isToolPageElementActive(rootRef.current));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(container, { attributes: true, attributeFilter: [TOOL_PAGE_ACTIVE_ATTRIBUTE] });
    return () => observer.disconnect();
  }, [rootRef]);
  return active;
}
