import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { PmItemTypeConfig } from "@/types";

/** 预设色板（M3 决策 3：零依赖，模块内常量） */
const PM_TYPE_PALETTE = ["#0ea5e9", "#10b981", "#ef4444", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

/**
 * 工单类型管理区（M3 B5 · 项目设置抽屉内使用）
 *
 * - typeConfig 数组顺序 = 看板列/表单下拉/筛选器顺序（上移/下移即交换）；
 * - key 生成后不可编辑（已有工单按 key 关联，改 key 断链）；
 * - 被工单引用的类型禁止删除（usedCounts 由父层按当前项目工单统计），至少保留 1 个类型；
 * - 修改不立即保存：由父层（项目设置抽屉）统一提交到 updatePmProject。
 */
export default function PmTypeSettings({
  typeConfig,
  usedCounts,
  onChange,
}: {
  typeConfig: PmItemTypeConfig[];
  usedCounts: Record<string, number>;
  onChange: (next: PmItemTypeConfig[]) => void;
}) {
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState(PM_TYPE_PALETTE[0]);

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= typeConfig.length) return;
    const next = [...typeConfig];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const remove = (index: number) => {
    if (typeConfig.length <= 1) return;
    onChange(typeConfig.filter((_, i) => i !== index));
  };

  const add = () => {
    const label = newLabel.trim();
    if (!label) return;
    const key = `t_${Math.random().toString(36).slice(2, 8)}`;
    onChange([...typeConfig, { key, label: label.slice(0, 24), color: newColor }]);
    setNewLabel("");
    setNewColor(PM_TYPE_PALETTE[(PM_TYPE_PALETTE.indexOf(newColor) + 1) % PM_TYPE_PALETTE.length]);
  };

  return (
    <div className="space-y-1.5">
      {typeConfig.map((type, index) => {
        const used = usedCounts[type.key] ?? 0;
        const deletable = used === 0 && typeConfig.length > 1;
        return (
          <div key={type.key} className="flex items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1 dark:border-zinc-700">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: type.color || "#6b7280" }} />
            <input
              className="min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none"
              value={type.label}
              maxLength={24}
              onChange={(e) =>
                onChange(typeConfig.map((t, i) => (i === index ? { ...t, label: e.target.value.slice(0, 24) } : t)))
              }
            />
            <span className="shrink-0 font-mono text-[9px] text-zinc-400" title="类型 key 生成后不可修改（已有工单按 key 关联）">
              {type.key}
            </span>
            {used > 0 ? <span className="shrink-0 text-[9px] text-zinc-400">{used} 单</span> : null}
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-app-hover hover:text-tx-primary disabled:opacity-30"
              disabled={index === 0}
              title="上移"
              onClick={() => move(index, -1)}
            >
              <ArrowUp size={11} />
            </button>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-app-hover hover:text-tx-primary disabled:opacity-30"
              disabled={index === typeConfig.length - 1}
              title="下移"
              onClick={() => move(index, 1)}
            >
              <ArrowDown size={11} />
            </button>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-app-hover hover:text-red-500 disabled:opacity-30"
              disabled={!deletable}
              title={used > 0 ? `仍被 ${used} 个工单使用，无法删除` : typeConfig.length <= 1 ? "至少保留一个类型" : "删除类型"}
              onClick={() => remove(index)}
            >
              <Trash2 size={11} />
            </button>
          </div>
        );
      })}

      {/* 新增类型：label + 色板 */}
      <div className="flex items-center gap-1.5 rounded-md border border-dashed border-zinc-300 px-2 py-1 dark:border-zinc-600">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: newColor }} />
        <input
          className="min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none placeholder:text-zinc-400"
          placeholder="新类型名称（如：评审）"
          maxLength={24}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <div className="flex shrink-0 items-center gap-0.5">
          {PM_TYPE_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              className={`h-3.5 w-3.5 rounded-full ${newColor === c ? "ring-2 ring-offset-1 ring-accent-primary" : ""}`}
              style={{ backgroundColor: c }}
              title={c}
              onClick={() => setNewColor(c)}
            />
          ))}
        </div>
        <button
          type="button"
          className="flex shrink-0 items-center gap-0.5 rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] text-tx-secondary hover:border-accent-primary hover:text-accent-primary disabled:opacity-40 dark:border-zinc-700"
          disabled={!newLabel.trim()}
          onClick={add}
        >
          <Plus size={10} /> 新增
        </button>
      </div>
      <p className="text-[10px] leading-4 text-zinc-400">
        顺序即看板列内类型下拉的顺序；类型 key 生成后不可改（已有工单按 key 关联）。
      </p>
    </div>
  );
}
