import { useEffect, useMemo, useState } from "react";
import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getNoteAppearance, setNoteAppearance } from "@/lib/noteAppearance";
import {
  listAvailableNoteThemes,
  subscribePluginNoteThemes,
} from "@/lib/pluginNoteThemeRegistry";

/**
 * 笔记主题选择。
 *
 * 选项语义（2026-10-13 收敛）：
 *   - 「默认（跟随应用外观）」= 不设 per-note 覆盖（存 null）。账号级主题设置在上游已废弃
 *     （settings/NoteThemePicker 是空壳），所以默认就等于跟随应用外观。
 *   - 原先列表里另有「Nowen 默认」（显式 default），与本项视觉完全一致（都落 default tokens），
 *     两个看着一样的选项已合并成这一项。
 *   - 其余主题才真正换配色/版心/行距；深色由应用的深浅色模式自动选 dark tokens。
 */
export default function NoteThemeMenuSelect({ noteId, disabled = false }: { noteId: string; disabled?: boolean }) {
  const { i18n } = useTranslation();
  const [themeId, setThemeId] = useState<string | null>(null);
  const [registryRevision, setRegistryRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const isZh = i18n.language.startsWith("zh");
  const label = isZh ? "笔记主题" : "Note theme";
  const themes = useMemo(
    () => listAvailableNoteThemes(i18n.language).filter((theme) => theme.id !== "default"),
    [i18n.language, registryRevision],
  );

  useEffect(() => subscribePluginNoteThemes(() => setRegistryRevision((value) => value + 1)), []);
  useEffect(() => {
    let active = true;
    void getNoteAppearance(noteId).then((appearance) => {
      if (active) setThemeId(appearance.themeId);
    }).catch(() => {
      if (active) setThemeId(null);
    });
    return () => { active = false; };
  }, [noteId]);

  // 曾显式存过 "default" 的笔记与「默认」等价，统一显示成同一个选项。
  const selected = themeId === null || themeId === "default" ? "" : themeId;
  const selectedAvailable = selected === "" || themes.some((theme) => theme.id === selected);
  return (
    <label className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary">
      <Palette size={15} className="shrink-0 text-accent-primary" />
      <span className="shrink-0">{label}</span>
      <select
        aria-label={label}
        className="min-w-0 flex-1 rounded-md border border-app-border bg-app-bg px-2 py-1 text-xs text-tx-primary"
        value={selected}
        disabled={disabled || saving}
        onChange={async (event) => {
          const next = event.target.value || null;
          setSaving(true);
          try {
            const saved = await setNoteAppearance(noteId, next);
            setThemeId(saved.themeId);
          } catch (error) {
            window.alert(error instanceof Error ? error.message : String(error));
          } finally {
            setSaving(false);
          }
        }}
      >
        <option value="">{isZh ? "默认（跟随应用外观）" : "Default (follow app appearance)"}</option>
        {!selectedAvailable && selected && (
          <option value={selected}>{isZh ? "插件不可用（已保留选择）" : "Plugin unavailable (selection kept)"}</option>
        )}
        {themes.map((theme) => (
          <option key={theme.id} value={theme.id}>
            {theme.source === "plugin" ? `${theme.name} · ${isZh ? "插件" : "Plugin"}` : theme.name}
          </option>
        ))}
      </select>
    </label>
  );
}
