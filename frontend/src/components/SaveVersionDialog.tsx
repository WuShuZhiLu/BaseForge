import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { NoteVersion } from "@/types";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";

/** 手动版本名称上限（契约：≤80 字，可空） */
export const MAX_SAVE_VERSION_LABEL_LENGTH = 80;
/** 手动版本描述上限（契约：≤500 字，可空） */
export const MAX_SAVE_VERSION_DESCRIPTION_LENGTH = 500;

/**
 * 名称/描述长度校验。两者均可空（留空时服务端用默认名称）。
 * 返回错误文案的 i18n key；合法返回 null。
 * （maxLength 属性挡不住 IME 组合输入等场景，提交前仍需校验。）
 */
export function validateSaveVersionInput(label: string, description: string): string | null {
  if (label.length > MAX_SAVE_VERSION_LABEL_LENGTH) return "versions.saveDialog.labelTooLong";
  if (description.length > MAX_SAVE_VERSION_DESCRIPTION_LENGTH) return "versions.saveDialog.descriptionTooLong";
  return null;
}

interface SaveVersionDialogProps {
  open: boolean;
  noteId: string;
  onClose: () => void;
  /** 创建版本前确保笔记已保存（编辑器有未保存修改时先落盘）；缺省直接调接口。 */
  ensureSaved?: () => Promise<void>;
  onCreated?: (version: NoteVersion) => void;
}

/**
 * 保存版本弹窗（版本历史 v2 手动备份）。
 * 复用 VersionHistoryPanel 的居中弹窗模式；编辑器「⋯」菜单与版本面板共用。
 */
export default function SaveVersionDialog({ open, noteId, onClose, ensureSaved, onCreated }: SaveVersionDialogProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  // 每次打开都重置输入，避免残留上一次的内容。
  useEffect(() => {
    if (open) {
      setLabel("");
      setDescription("");
    }
  }, [open]);

  const handleSave = async () => {
    if (saving) return;
    const errorKey = validateSaveVersionInput(label, description);
    if (errorKey) {
      toast.error(t(errorKey));
      return;
    }
    setSaving(true);
    try {
      // 快照对象是当前已保存内容：先触发保存（有未保存修改则落盘），再建版本。
      if (ensureSaved) await ensureSaved();
      const version = await api.saveNoteVersion(noteId, {
        label: label.trim() || undefined,
        description: description.trim() || undefined,
      });
      toast.success(t("versions.saveDialog.saveSuccess"));
      onCreated?.(version);
      onClose();
    } catch (e: any) {
      console.error("[SaveVersionDialog] save version failed:", e);
      toast.error(t("versions.saveDialog.saveFailed") + (e?.message ? `: ${e.message}` : ""));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-md mx-4 bg-app-elevated rounded-xl shadow-2xl border border-app-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-accent-primary/10 flex items-center justify-center flex-shrink-0">
                  <Save size={16} className="text-accent-primary" />
                </div>
                <h2 className="text-sm font-semibold text-tx-primary">{t("versions.saveDialog.title")}</h2>
              </div>
              <button
                onClick={() => { if (!saving) onClose(); }}
                className="p-1.5 rounded-lg hover:bg-app-hover text-tx-tertiary hover:text-tx-secondary transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-tx-secondary">{t("versions.saveDialog.nameLabel")}</label>
                  <span className="text-[10px] text-tx-tertiary">
                    {label.length}/{MAX_SAVE_VERSION_LABEL_LENGTH}
                  </span>
                </div>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={MAX_SAVE_VERSION_LABEL_LENGTH}
                  placeholder={t("versions.saveDialog.namePlaceholder")}
                  disabled={saving}
                  className="w-full px-3 py-2 rounded-lg border border-app-border bg-app-bg text-sm text-tx-primary placeholder:text-tx-tertiary/60 outline-none focus:border-accent-primary/50 focus:ring-2 focus:ring-accent-primary/20 transition-colors disabled:opacity-50"
                />
                <p className="mt-1 text-[10px] text-tx-tertiary/70">{t("versions.saveDialog.nameHint")}</p>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-tx-secondary">{t("versions.saveDialog.descriptionLabel")}</label>
                  <span className="text-[10px] text-tx-tertiary">
                    {description.length}/{MAX_SAVE_VERSION_DESCRIPTION_LENGTH}
                  </span>
                </div>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={MAX_SAVE_VERSION_DESCRIPTION_LENGTH}
                  placeholder={t("versions.saveDialog.descriptionPlaceholder")}
                  disabled={saving}
                  rows={4}
                  className="w-full px-3 py-2 rounded-lg border border-app-border bg-app-bg text-sm text-tx-primary placeholder:text-tx-tertiary/60 outline-none focus:border-accent-primary/50 focus:ring-2 focus:ring-accent-primary/20 transition-colors resize-none disabled:opacity-50"
                />
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-app-border">
              <Button size="sm" variant="ghost" onClick={onClose} disabled={saving} className="h-8 text-xs">
                {t("versions.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving}
                className="h-8 text-xs bg-accent-primary hover:bg-accent-primary/90 text-white"
              >
                {saving ? <Loader2 size={13} className="animate-spin mr-1" /> : <Save size={13} className="mr-1" />}
                {saving ? t("versions.saveDialog.saving") : t("versions.saveDialog.saveButton")}
              </Button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
