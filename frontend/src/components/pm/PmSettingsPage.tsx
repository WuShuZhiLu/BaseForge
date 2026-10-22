import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { PmItemTypeConfig, PmProject } from "@/types";
import { api } from "@/lib/api";
import PmTypeSettings from "@/components/pm/PmTypeSettings";

/**
 * 设置模块页（Tab「设置」对应的主区页面）：
 * 基本信息 + 工单类型管理，统一保存；删除项目入口保留（父层 confirm）。
 * 与 PmProjectSettingsDrawer 同能力，页面化承载（侧栏「设置」导航对应）。
 */
export default function PmSettingsPage({
  project,
  usedTypeCounts,
  onSaved,
  onDeleteRequest,
}: {
  project: PmProject;
  usedTypeCounts: Record<string, number>;
  onSaved: (project: PmProject) => void;
  onDeleteRequest: (project: PmProject) => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [color, setColor] = useState(project.color ?? "#3b82f6");
  const [typeConfig, setTypeConfig] = useState<PmItemTypeConfig[]>(project.typeConfig ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  const PM_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

  const save = async () => {
    if (!name.trim()) {
      setError("项目名称不能为空");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await api.updatePmProject(project.id, { name: name.trim(), description, color, typeConfig });
      onSaved(res.project);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[720px] p-4 pb-10">
      <div className="rounded-xl border border-app-border bg-app-elevated/60 p-4">
        <p className="mb-3 text-[12.5px] font-semibold text-tx-primary">基本信息</p>
        <div className="space-y-2">
          <input
            className="h-8 w-full max-w-[420px] rounded-lg border border-zinc-200 bg-transparent px-2 text-xs dark:border-zinc-700"
            placeholder="项目名称"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="block min-h-16 w-full max-w-[420px] resize-y rounded-lg border border-zinc-200 bg-transparent p-2 text-xs dark:border-zinc-700"
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
      </div>

      <div className="rounded-xl border border-app-border bg-app-elevated/60 p-4">
        <p className="mb-3 text-[12.5px] font-semibold text-tx-primary">工单类型管理</p>
        <PmTypeSettings typeConfig={typeConfig} usedCounts={usedTypeCounts} onChange={setTypeConfig} />
      </div>

      {error ? <p className="rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11.5px] text-red-500">{error}</p> : null}
      {savedFlash ? <p className="text-[11px] text-emerald-500">已保存</p> : null}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !name.trim()}
          className="rounded-lg bg-accent-primary px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          onClick={() => void save()}
        >
          {busy ? "保存中…" : "保存设置"}
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs text-red-500 hover:bg-red-500/5 dark:border-zinc-700"
          onClick={() => onDeleteRequest(project)}
        >
          <Trash2 size={12} /> 删除项目
        </button>
      </div>
    </div>
  );
}
