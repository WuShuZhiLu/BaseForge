import React, { useCallback } from "react";
import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { useTabNoteOpener } from "@/hooks/useTabNoteOpener";
import { PanelBody, PanelEmpty, PanelLoading, PanelRow, usePanelData, usePanelRefresh } from "@/components/sidebar/panels/shared";

/** 收藏面板（内容层新实现）：数据源与 NoteList 收藏视图一致（api.getNotes({ isFavorite })）。 */
export default function FavoritesPanel() {
  const { t } = useTranslation();
  const openNote = useTabNoteOpener();
  const load = useCallback(
    async () => ((await api.getNotes({ isFavorite: "1" } as never)) ?? []) as Array<{ id: string; title: string }>,
    [],
  );
  const { data: items, loading, reload } = usePanelData<Array<{ id: string; title: string }>>(load, []);
  usePanelRefresh("fav", reload);

  return (
    <PanelBody>
      {loading ? (
        <PanelLoading />
      ) : items.length === 0 ? (
        <PanelEmpty text={t("sidebar.noFavorites")} />
      ) : (
        items.map((note) => (
          <PanelRow
            key={note.id}
            onClick={() => void openNote(note.id)}
            leading={<Star size={13} className="shrink-0 text-amber-500" />}
          >
            {note.title || t("noteList.untitled")}
          </PanelRow>
        ))
      )}
    </PanelBody>
  );
}
