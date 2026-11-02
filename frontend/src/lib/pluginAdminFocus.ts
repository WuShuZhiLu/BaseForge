/**
 * 「安装本地插件」→ 管理页「安装插件包」分区的滚动聚焦请求。
 * ---------------------------------------------------------------------------
 * 背景：侧栏「安装本地插件」此前只 dispatch nowen:plugin-group {group:"admin"}，
 * 主区落在管理分组但视口对着「检查更新」一带，看起来像跳到了「更新」。
 * 这里改为请求把「安装插件包」分区滚动到视口并聚焦。
 *
 * 时序：请求发出时 PluginAdminPanel 可能尚未挂载（分组是刚切过去的，或主区
 * 整个 PluginsWorkspace 才挂载），事件会丢；因此请求同时落到模块级 pending
 * 槽——面板已挂载则收事件处理，稍后挂载则在挂载时消费 pending。
 */

export type PluginAdminFocusSection = "install";

const EVENT = "nowen:plugin-admin-focus";

let pending: PluginAdminFocusSection | null = null;

/** 侧栏入口调用：记录请求并广播（面板已挂载时立即收到）。 */
export function requestPluginAdminFocus(section: PluginAdminFocusSection): void {
  pending = section;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { section } }));
}

/** 面板侧调用：消费落槽的请求（挂载时对齐用）；命中返回 true 并清槽。 */
export function consumePluginAdminFocus(section: PluginAdminFocusSection): boolean {
  if (pending !== section) return false;
  pending = null;
  return true;
}

/** 订阅焦点请求（面板挂载期间）；返回解绑函数。 */
export function onPluginAdminFocus(handler: (section: PluginAdminFocusSection) => void): () => void {
  const listener = (event: Event) => {
    const section = (event as CustomEvent<{ section?: PluginAdminFocusSection }>).detail?.section;
    if (section) handler(section);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
