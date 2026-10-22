import { useState } from "react";
import { Trash2, X } from "lucide-react";
import type { PmItemTypeConfig, PmProject } from "@/types";
import { api } from "@/lib/api";
import PmTypeSettings from "@/components/pm/PmTypeSettings";

/**
 * 项目设置抽屉（M3 B5）：基本信息 + 工单类型管理，统一保存到 updatePmProject。
 * 替代旧「编辑项目」小对话框；删除项目入口保留（非破坏性：需 confirm，逻辑在父层）。
 */
export default function PmProjectSettingsDrawer({
  project,
  usedTypeCounts,
  onClose,
  onSaved,
  onDeleteRequest,
}: {
  project: PmProject;
  usedTypeCounts: Record<string, number>;
  onClose: () => void;
  onSaved: (project: PmProject) => void;
  onDeleteRequest: (project: PmProject) => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [color, setColor] = useState(project.color ?? "#3b82f6");
  const [typeConfig, setTypeConfig] = useState<PmItemTypeConfig[]>(project.typeConfig ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const PM_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

  const save = async () => {
    if (!name.trim()) {
      setError("项目名称不能为空");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await api.updatePmProject(project.id, {
        name: name.trim(),
        description,
        color,
        typeConfig,
      });
      onSaved(res.project);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-[440px] flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
          <p className="text-sm font-semibold text-tx-primary">项目设置</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex items-center gap-1 text-[11px] text-red-500 hover:text-red-600"
              onClick={() => onDeleteRequest(project)}
            >
              <Trash2 size={11} /> 删除项目
            </button>
            <button type="button" className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* 基本信息 */}
          <p className="text-[11px] font-semibold text-tx-secondary">基本信息</p>
          <div className="mt-1.5 space-y-2">
            <input
              className="h-8 w-full rounded border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"
              placeholder="项目名称"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
            <textarea
              className="min-h-16 w-full resize-y rounded border border-zinc-200 bg-transparent p-2 text-xs dark:border-zinc-700"
              placeholder="项目描述（可选）"
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-400">颜色</span>
              {PM_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`h-4 w-4 rounded-full ${color === c ? "ring-2 ring-offset-1 ring-accent-primary" : ""}`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>

          {/* 工单类型管理 */}
          <p className="mt-4 text-[11px] font-semibold text-tx-secondary">工单类型</p>
          <div className="mt-1.5">
            <PmTypeSettings typeConfig={typeConfig} usedCounts={usedTypeCounts} onChange={setTypeConfig} />
          </div>

          {error ? <p className="mt-3 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-500">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
          <button
            type="button"
            className="rounded-md border border-zinc-200 px-3 py-1 text-xs text-tx-secondary dark:border-zinc-700"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            className="rounded-md bg-accent-primary px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存设置"}
          </button>
        </div>
      </div>
    </div>
  );
}
