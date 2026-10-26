import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Editor } from "@tiptap/react";
import { GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ColumnToolbar } from "./ColumnToolbar";
import { getSlashEditorId } from "./extensions/SlashCommandExtension";
import { addBlockBelow, convertBlock, copyBlock, cutBlock, deleteBlock, locateBlock, pasteBlock, type AddBelowType, type BlockTarget } from "./blockMenuActions";
import { api } from "@/lib/api";
import { openInternalNoteLink } from "@/lib/blockNavigation";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";

/** 嵌入块（blockEmbed）的 href 解析：mindmap/board/sheet:<uuid>。 */
function parseEmbedHref(href: string): { href: string; kind: string; id: string } | null {
  const match = /^(mindmap|board|sheet):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(href);
  return match ? { href, kind: match[1].toLowerCase(), id: match[2].toLowerCase() } : null;
}

const targets: { key: string; target: BlockTarget; insert: AddBelowType }[] = [
  { key: "paragraph", target: { type: "paragraph" }, insert: "paragraph" },
  ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({ key: `heading${level}`, target: { type: "heading" as const, level }, insert: `heading${level}` as AddBelowType })),
  ...(["bulletList", "orderedList", "taskList", "blockquote", "codeBlock", "callout", "details", "columns"] as const).map((type) => ({ key: type, target: { type }, insert: type as AddBelowType })),
];

export default function RichTextBlockControls({ editor, editable, isMobile }: { editor: Editor; editable: boolean; isMobile: boolean }) {
  const { t } = useTranslation();
  const hovered = useRef<{ pos: number; leaf: boolean } | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ from: number; top: number; left: number; doc: typeof editor.state.doc; embed: { href: string; kind: string; id: string } | null } | null>(null);
  const [panel, setPanel] = useState<"main" | "convert" | "insert">("main");

  const open = (from: number, rect: Pick<DOMRect, "right" | "bottom">) => {
    if (!editor.isEditable) return;
    setPanel("main");
    // 嵌入块识别：柄对 atom 叶子的 from 语义（before / before+1）在不同挂载点
    // 有差异，两个位置都试一次，命中 blockEmbed 时菜单展示嵌入专属操作。
    const located = locateBlock(editor, from) ?? locateBlock(editor, from + 1);
    const embed = located?.typeName === "blockEmbed"
      ? parseEmbedHref(String(located.node.attrs.href || ""))
      : null;
    setMenu({ from, doc: editor.state.doc, embed, left: Math.max(8, Math.min(rect.right + 4, window.innerWidth - 232)), top: Math.max(8, Math.min(rect.bottom, window.innerHeight - 320)) });
  };

  useEffect(() => {
    const onOpen = (event: Event) => {
      if ((event as CustomEvent).detail?.editorId !== getSlashEditorId(editor)) return;
      const from = editor.state.selection.from;
      open(from, editor.view.coordsAtPos(from));
    };
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged || !editor.isEditable) setMenu(null);
    };
    window.addEventListener("nowen:open-block-menu", onOpen);
    editor.on("transaction", onTransaction);
    return () => {
      window.removeEventListener("nowen:open-block-menu", onOpen);
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  useEffect(() => { if (!editable) setMenu(null); }, [editable]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => { if (!popup.current?.contains(event.target as Node)) setMenu(null); };
    const close = () => setMenu(null);
    const onScroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) close(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const run = async (action: "copy" | "cut" | "paste" | "delete") => {
    if (!menu || !editor.isEditable || !editor.state.doc.eq(menu.doc)) return;
    const { from } = menu;
    setMenu(null);
    if (action === "delete") { deleteBlock(editor, from); return; }
    const ok = await (action === "copy" ? copyBlock(editor, from) : action === "cut" ? cutBlock(editor, from) : pasteBlock(editor, from));
    if (!ok) toast.error(t(`richText.${action}Failed`));
  };

  if (!editable) return null;
  const buttonClass = "w-full rounded px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover focus:bg-app-hover";
  return <>
    {!isMobile && <>
      <ColumnToolbar editor={editor} editable={editable} />
      <DragHandle editor={editor} className="tiptap-drag-handle" computePositionConfig={{ placement: "left-start" }} nested={{ edgeDetection: "none" }} onNodeChange={({ node, pos }) => {
        hovered.current = node && pos >= 0 ? { pos, leaf: node.isLeaf } : null;
      }}>
        <button type="button" className="tiptap-drag-handle__grip" aria-label={t("slash.blockMenu")} onClick={(event) => {
          event.preventDefault();
          const target = hovered.current;
          if (target) open(target.pos + (target.leaf ? 0 : 1), event.currentTarget.getBoundingClientRect());
        }}><GripVertical size={16} /></button>
      </DragHandle>
    </>}
    {menu && createPortal(<div ref={popup} role="menu" aria-label={t("slash.blockMenu")} className="fixed z-[80] w-56 overflow-y-auto rounded-lg border border-app-border bg-app-elevated p-1 shadow-xl" style={{ top: menu.top, left: menu.left, maxHeight: `min(360px, calc(100dvh - ${menu.top + 8}px))` }} onMouseDown={(event) => event.preventDefault()}>
      {panel === "main" ? <>
        {menu.embed && <>
          <button type="button" role="menuitem" className={buttonClass} onClick={() => {
            openInternalNoteLink(`note:${menu.embed!.id}`);
            setMenu(null);
          }}>{t("richText.embedOpenSource") || "打开源文档"}</button>
          <button type="button" role="menuitem" className={buttonClass} onClick={async () => {
            const ok = await copyText(`![[${menu.embed!.href}]]`);
            setMenu(null);
            if (ok) toast.success(t("richText.embedRefCopied") || "已复制嵌入引用");
            else toast.error(t("richText.copyFailed") || "复制失败");
          }}>{t("richText.embedCopyRef") || "复制嵌入引用"}</button>
          <button type="button" role="menuitem" className={buttonClass} onClick={async () => {
            const { id } = menu.embed!;
            setMenu(null);
            try {
              // 转正：匿名文档进入知识树；已有名文档时后端幂等（仅按需更新标题）。
              await api.promoteNote(id);
              window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "anonymous-doc-promoted", noteId: id } }));
              toast.success(t("richText.embedPromoted") || "已转为独立文档");
            } catch (error) {
              toast.error(error instanceof Error ? error.message : t("richText.embedPromoteFailed") || "转为独立文档失败");
            }
          }}>{t("richText.embedPromote") || "转为独立文档"}</button>
        </>}
        {!menu.embed && <button type="button" className={buttonClass} onClick={() => setPanel("convert")}>{t("slash.convertTitle")}</button>}
        {(["copy", "cut", "paste", "delete"] as const).map((action) => <button type="button" role="menuitem" className={buttonClass} key={action} onClick={() => void run(action)}>{t(`slash.action${action[0].toUpperCase()}${action.slice(1)}`)}</button>)}
        <button type="button" className={buttonClass} onClick={() => setPanel("insert")}>{t("slash.actionAddBelow")}</button>
      </> : <>
        <button type="button" className={buttonClass} onClick={() => setPanel("main")}>{t("common.back")}</button>
        {targets.map(({ key, target, insert }) => <button key={key} type="button" role="menuitem" className={buttonClass} onClick={() => {
          if (!editor.isEditable || !editor.state.doc.eq(menu.doc)) return;
          if (panel === "convert") {
            if (!convertBlock(editor, target, menu.from)) toast.error(t("richText.convertUnsupported"));
          }
          else addBlockBelow(editor, insert, menu.from);
          setMenu(null);
          editor.commands.focus();
        }}>{t(`slash.convert.${key}`)}</button>)}
        {panel === "insert" && <>
          <div className="mx-2 my-1 border-t border-app-border" role="separator" />
          {/* 三类嵌入块：创建需异步建匿名文档，复用斜杠命令的事件管线
              （EditorPane 监听后插块即匿名，见 pendingAnonEmbed 副作用）。 */}
          {([
            { kind: "sheet" as const, event: "nowen:open-sheet-embed-picker", label: t("slash.sheetEmbed") || "轻量表格" },
            { kind: "mindmap" as const, event: "nowen:open-mindmap-insert", label: t("slash.mindmap") || "思维导图" },
            { kind: "board" as const, event: "nowen:open-board-embed-picker", label: t("slash.boardEmbed") || "画板" },
          ]).map(({ kind, event, label }) => <button key={kind} type="button" role="menuitem" className={buttonClass} onClick={() => {
            if (!editor.isEditable) return;
            setMenu(null);
            editor.commands.focus();
            window.dispatchEvent(new CustomEvent(event));
          }}>{label}</button>)}
        </>}
      </>}
    </div>, document.body)}
  </>;
}
