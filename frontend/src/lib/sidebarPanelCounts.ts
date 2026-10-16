import { useSyncExternalStore } from "react";
import type { SidebarPanelId } from "@/lib/sidebarPanels";

/**
 * 面板计数桥（面板框架 S1，A 维护）
 *
 * 面板头右侧的计数需要「面板内容自己知道的数据」（例如文档树的当前空间笔记数 ownedNoteCount），
 * 而容器不该去猜。这里提供一个极小的上报/订阅通道：
 *   内容组件 → reportPanelCount(id, n)；容器 → usePanelCount(id) 读取。
 * 只用于展示，不参与任何业务逻辑。
 */

type CountMap = Partial<Record<SidebarPanelId, number | null>>;

let counts: CountMap = {};
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function reportPanelCount(id: SidebarPanelId, count: number | null): void {
  if (counts[id] === count) return;
  counts = { ...counts, [id]: count };
  emit();
}

export function clearPanelCount(id: SidebarPanelId): void {
  if (!(id in counts)) return;
  const next = { ...counts };
  delete next[id];
  counts = next;
  emit();
}

export function readPanelCounts(): CountMap {
  return counts;
}

export function subscribePanelCounts(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function usePanelCount(id: SidebarPanelId): number | null {
  const map = useSyncExternalStore(subscribePanelCounts, readPanelCounts, readPanelCounts);
  return map[id] ?? null;
}
