import { useSyncExternalStore } from "react";

/** PM 主区模块（侧栏导航 ↔ 主区内容共享态） */
export type PmModule = "overview" | "board" | "list" | "settings";

const MODULE_KEY = "nowen.pm.module";
const PROJECT_KEY = "nowen.pm.activeProject";
const MODULES: PmModule[] = ["overview", "board", "list", "settings"];

let currentModule: PmModule = "overview";
let activeProjectId = "";
try {
  const savedModule = localStorage.getItem(MODULE_KEY) as PmModule | null;
  if (savedModule && MODULES.includes(savedModule)) currentModule = savedModule;
  activeProjectId = localStorage.getItem(PROJECT_KEY) || "";
} catch {
  /* storage 不可用时保持默认 */
}

const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}

export interface PmUiState {
  module: PmModule;
  activeProjectId: string;
}

// useSyncExternalStore 要求 getSnapshot 返回稳定引用：快照对象只在状态变更时重建，
// 否则每次对比都判定"已变化"，触发无限重渲染（Maximum update depth exceeded）。
let snapshot: PmUiState = { module: currentModule, activeProjectId };

function commitSnapshot(): void {
  snapshot = { module: currentModule, activeProjectId };
}

export function getPmUi(): PmUiState {
  return snapshot;
}

export function setPmModule(value: PmModule): void {
  if (currentModule === value) return;
  currentModule = value;
  try {
    localStorage.setItem(MODULE_KEY, value);
  } catch {
    /* ignore */
  }
  commitSnapshot();
  emit();
}

export function setPmActiveProject(id: string): void {
  if (activeProjectId === id) return;
  activeProjectId = id;
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {
    /* ignore */
  }
  commitSnapshot();
  emit();
}

export function subscribePmUi(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function usePmUi(): PmUiState {
  return useSyncExternalStore(subscribePmUi, getPmUi, getPmUi);
}
