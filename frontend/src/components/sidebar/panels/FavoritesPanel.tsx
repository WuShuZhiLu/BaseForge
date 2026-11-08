import React, { useCallback } from "react";
import { Star } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, getCurrentWorkspace } from "@/lib/api";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { knowledgeTreeIconFor } from "@/lib/knowledgeTreeIcons";
import { pushAppPathState, APP_PATH_CHANGED_EVENT } from "@/lib/appPathNavigation";
import { useTabNoteOpener } from "@/hooks/useTabNoteOpener";
import { PanelBody, PanelEmpty, PanelLoading, PanelRow, usePanelData, usePanelRefresh } from "@/components/sidebar/panels/shared";

interface FavRow {
  key: string;
  kind: "kb" | "note";
  /** kb = 知识库 resourceId；note = 笔记 id */
  id: string;
  title: string;
  /** 知识库根节点 id：点行时顺带在侧栏树中定位 */
  nodeId?: string;
  /** 知识库封面图标（BookMarked + 封面色） */
  icon?: ReactNode;
}

/**
 * 当前聚焦的知识库 resourceId（URL 带 ?tree=focus 时）。收藏跟随聚焦范围：
 * 聚焦某库时只显示该库内的文档收藏与该库自身的收藏项，其它库的收藏不出现。
 */
function resolveFocusKbResourceId(): string | null {
  if (new URLSearchParams(window.location.search).get("tree") !== "focus") return null;
  const match = window.location.pathname.match(/\/kb\/[^/]+\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * 收藏面板（内容层新实现）：知识库收藏（根节点 isFavorite=1）与文档收藏混排，知识库在前。
 * 不做"知识库/文档"切换——一行一个类型图标足够分辨，切换反而多一步。
 */
export default function FavoritesPanel() {
  const { t } = useTranslation();
  const openNote = useTabNoteOpener();
  const load = useCallback(async (): Promise<FavRow[]> => {
    const focusKbId = resolveFocusKbResourceId();
    const [notes, tree] = await Promise.all([
      api.getNotes({ isFavorite: "1" } as never).catch(() => [] as Array<{ id: string; title: string }>),
      knowledgeTreeApi.list().catch(() => ({ nodes: [] as KnowledgeTreeNode[] })),
    ]);
    // 文档收藏的归属库：沿父链上溯到根层知识库，聚焦时用于过滤
    const nodeById = new Map(tree.nodes.map((n) => [n.id, n]));
    const rootOf = (node: KnowledgeTreeNode): string | null => {
      let current: KnowledgeTreeNode | undefined = node;
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (current.resourceType === "notebook" && current.parentId === null) return current.resourceId;
        current = nodeById.get(current.parentId ?? "");
      }
      return null;
    };
    // 聚焦某库时该库自身就在眼前，知识库收藏条目整个隐藏，只显示该库内的文档收藏
    const kbs = focusKbId ? [] : tree.nodes.filter(
      (n) => !n.isDeleted && n.parentId === null && n.resourceType === "notebook" && n.isFavorite === 1,
    );
    const filteredNotes = (notes as Array<{ id: string; title: string }>).filter((note) => {
      if (!focusKbId) return true;
      const node = nodeById.get(note.id);
      return node ? rootOf(node) === focusKbId : false;
    });
    return [
      ...kbs.map((kb) => ({
        key: `kb-${kb.id}`,
        kind: "kb" as const,
        id: kb.resourceId,
        title: kb.title,
        nodeId: kb.id,
        icon: knowledgeTreeIconFor(kb, true),
      })),
      ...filteredNotes.map((note) => ({
        key: `note-${note.id}`,
        kind: "note" as const,
        id: note.id,
        title: note.title || t("noteList.untitled"),
      })),
    ];
  }, [t]);
  const { data: items, loading, reload } = usePanelData<FavRow[]>(load, []);
  usePanelRefresh("fav", reload);

  // 聚焦进出（URL ?tree=focus 变化）不重挂面板，监听应用内导航事件重拉；
  // 文档收藏状态变更（nowen:notes-changed）也即时重拉
  React.useEffect(() => {
    const onPathChanged = () => reload();
    const onNotesChanged = () => reload();
    window.addEventListener(APP_PATH_CHANGED_EVENT, onPathChanged);
    window.addEventListener("nowen:notes-changed", onNotesChanged);
    return () => {
      window.removeEventListener(APP_PATH_CHANGED_EVENT, onPathChanged);
      window.removeEventListener("nowen:notes-changed", onNotesChanged);
    };
  }, [reload]);

  const openKb = useCallback((row: FavRow) => {
    const space = encodeURIComponent(getCurrentWorkspace() || "personal");
    // 与侧栏收藏区段同语义：进入库 Overview 并在树中定位
    window.dispatchEvent(new CustomEvent("nowen:kb-reveal-node", { detail: { nodeId: row.nodeId } }));
    pushAppPathState(`/kb/${space}/${encodeURIComponent(row.id)}`);
  }, []);

  return (
    <PanelBody>
      {loading ? (
        <PanelLoading />
      ) : items.length === 0 ? (
        <PanelEmpty text={t("sidebar.noFavorites")} />
      ) : (
        items.map((row) => (
          <PanelRow
            key={row.key}
            onClick={() => (row.kind === "kb" ? openKb(row) : void openNote(row.id))}
            leading={row.kind === "kb"
              ? <span className="shrink-0">{row.icon}</span>
              : <Star size={13} className="shrink-0 text-amber-500" />}
          >
            {row.title}
          </PanelRow>
        ))
      )}
    </PanelBody>
  );
}
