/**
 * 插件侧栏面板注册表（复刻 pluginUiRegistry 模式）。
 *
 * 数据源：/api/plugins/contributions 的 sidebarPanels 字段。
 * 校验通过后按 runtimeId（pluginId/panelId）存入；供 PluginPanelHost 渲染。
 */
import type { PluginUiIcon } from "@/lib/pluginApi";

export interface RegisteredPluginSidebarPanel {
  pluginId: string;
  id: string;
  runtimeId: string;
  title: string;
  icon: PluginUiIcon;
  kind: "builtin" | "static-card";
  builtinId?: string;
  cards?: Array<{
    id: string;
    title: string;
    description?: string;
    link?: { label: string; target: string };
  }>;
}

const PANEL_TITLE_MAX = 100;
const CARDS_MAX = 20;

let registry: RegisteredPluginSidebarPanel[] = [];

function isValidIcon(icon: unknown): icon is PluginUiIcon {
  return typeof icon === "string" && ["home", "star", "files", "tasks", "mindmap", "ai", "shares", "settings"].includes(icon);
}

function validPanel(raw: unknown, pluginId: string): RegisteredPluginSidebarPanel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const { id, title, icon, kind } = record as Partial<RegisteredPluginSidebarPanel>;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) return null;
  if (typeof title !== "string" || !title || title.length > PANEL_TITLE_MAX) return null;
  if (!isValidIcon(icon)) return null;
  if (kind !== "builtin" && kind !== "static-card") return null;
  if (kind === "builtin" && typeof record.builtinId !== "string") return null;

  const cards: RegisteredPluginSidebarPanel["cards"] = [];
  if (Array.isArray(record.cards)) {
    for (const rawCard of record.cards.slice(0, CARDS_MAX)) {
      if (typeof rawCard !== "object" || rawCard === null) continue;
      const card = rawCard as Record<string, unknown>;
      if (typeof card.id !== "string" || typeof card.title !== "string") continue;
      cards.push({
        id: card.id,
        title: card.title,
        description: typeof card.description === "string" ? card.description : undefined,
        link: typeof card.link === "object" && card.link !== null
          ? {
              label: String((card.link as Record<string, unknown>).label ?? ""),
              target: String((card.link as Record<string, unknown>).target ?? "all"),
            }
          : undefined,
      });
    }
  }
  if (kind === "static-card" && cards.length === 0) return null;

  return {
    pluginId,
    id,
    runtimeId: `${pluginId}/${id}`,
    title,
    icon,
    kind,
    builtinId: typeof record.builtinId === "string" ? record.builtinId : undefined,
    cards: kind === "static-card" ? cards : undefined,
  };
}

/** 用最新 contributions 替换注册表（非法项静默丢弃） */
export function replacePluginSidebarPanels(contributions: Array<Record<string, unknown>>): void {
  const next: RegisteredPluginSidebarPanel[] = [];
  for (const record of contributions) {
    const pluginId = record.pluginId;
    if (typeof pluginId !== "string") continue;
    if (!Array.isArray(record.sidebarPanels)) continue;
    for (const raw of record.sidebarPanels) {
      const panel = validPanel(raw, pluginId);
      if (panel) next.push(panel);
    }
  }
  registry = next;
}

export function listPluginSidebarPanels(): RegisteredPluginSidebarPanel[] {
  return registry;
}

export function getPluginSidebarPanel(runtimeId: string): RegisteredPluginSidebarPanel | null {
  return registry.find((panel) => panel.runtimeId === runtimeId) ?? null;
}
