/**
 * 远程投影笔记 —— 本地笔记与远程文件的双向同步（内核能力，非插件）。
 *
 * 目标（用户需求）：远程设备上的文档**不导入副本**，直接用我们的编辑器读写。
 * 做法：远程文本文件在知识库里表现为一条普通笔记（本地缓存正文 + 链接映射），
 * 编辑保存后自动写回远程；打开时若远程被别人改过，按三态处理：
 *
 *   远程未变            → 什么都不做
 *   远程变了、本地没变  → 自动拉取远程内容（本地无改动，覆盖是安全的）
 *   两边都变了          → 弹窗让用户选方向（用远程覆盖本地 / 保留本地并写回远程）
 *
 * 写回是防抖的：本地保存本来就只在显式入口发生（Ctrl+S / 状态区 / 定时保存），
 * 这里再合并 1.2s 内的连续保存，避免一次编辑产生多次远程写入。
 *
 * 失败绝不静默：写不进去时弹一次明确提示「改动只保存在本地」，用户知道远程没同步。
 */
import { useEffect, useSyncExternalStore } from "react";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/lib/toast";
import { api } from "@/lib/api";
import { markdownToTiptapJSON, normalizeToMarkdown } from "@/lib/contentFormat";
import type { Note, RemoteNoteLink } from "@/types";

/** FNV-1a 32bit：与 RemoteFilesPanel 同口径，用于三态判断 */
export function remoteHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + text.length.toString(16);
}

let linkCache: RemoteNoteLink[] | null = null;
let linkLoading: Promise<RemoteNoteLink[]> | null = null;
const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pushPending = new Map<string, string>();
const warnedNotes = new Set<string>();

export function invalidateRemoteNoteLinks(): void {
  linkCache = null;
  linkLoading = null;
}

// ---------------------------------------------------------------------------
// 远程来源标记：知识库的笔记列表 / 知识树要能一眼看出哪些笔记是远程投影
// ---------------------------------------------------------------------------
let linkedIdsSnapshot: ReadonlySet<string> = new Set();
const linkedIdsListeners = new Set<() => void>();

function publishLinkedIds(): void {
  const next = new Set<string>();
  for (const link of linkCache ?? []) next.add(link.noteId);
  // 引用稳定：内容没变就不通知，避免 useSyncExternalStore 无限重渲染
  let changed = next.size !== linkedIdsSnapshot.size;
  if (!changed) {
    for (const id of next) {
      if (!linkedIdsSnapshot.has(id)) { changed = true; break; }
    }
  }
  if (!changed) return;
  linkedIdsSnapshot = next;
  for (const listener of linkedIdsListeners) listener();
}

function subscribeRemoteLinkedNotes(listener: () => void): () => void {
  linkedIdsListeners.add(listener);
  return () => { linkedIdsListeners.delete(listener); };
}

function getRemoteLinkedNoteIds(): ReadonlySet<string> {
  return linkedIdsSnapshot;
}

/** 面板自己拉了链接表时同步进来，标记能立刻跟着变（连接 / 解除链接） */
export function setRemoteNoteLinksCache(links: RemoteNoteLink[]): void {
  linkCache = links;
  publishLinkedIds();
}

/**
 * 知识库里判断「这条笔记是不是远程投影」用。
 * 首次挂载触发一次链接表拉取，之后靠快照 + 订阅更新。
 */
export function useRemoteLinkedNoteIds(): ReadonlySet<string> {
  const ids = useSyncExternalStore(subscribeRemoteLinkedNotes, getRemoteLinkedNoteIds, getRemoteLinkedNoteIds);
  useEffect(() => {
    void ensureLinks().then(publishLinkedIds);
  }, []);
  return ids;
}

async function ensureLinks(): Promise<RemoteNoteLink[]> {
  if (linkCache) return linkCache;
  if (!linkLoading) {
    linkLoading = api.getRemoteNoteLinks()
      .then((res) => {
        linkCache = res.links;
        publishLinkedIds();
        return linkCache;
      })
      .catch(() => {
        linkCache = [];
        return [];
      })
      .finally(() => { linkLoading = null; });
  }
  return linkLoading;
}

export function linkForNoteSync(noteId: string): RemoteNoteLink | undefined {
  return linkCache?.find((link) => link.noteId === noteId);
}

/** 远程文件当前内容（读失败返回 null，调用方按「远程不可用」处理） */
async function readRemote(link: RemoteNoteLink): Promise<string | null> {
  try {
    const res = await api.readRemoteFile(link.sourceId, link.remotePath);
    return res.content;
  } catch (error) {
    console.warn("[remote-note-sync] read remote failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function refreshBaselines(link: RemoteNoteLink, markdown: string): Promise<void> {
  const hash = remoteHash(markdown);
  try {
    const res = await api.updateRemoteNoteLinkSync({
      sourceId: link.sourceId,
      remotePath: link.remotePath,
      baseRemoteHash: hash,
      baseNoteHash: hash,
    });
    link.baseRemoteHash = hash;
    link.baseNoteHash = hash;
    link.syncedAt = res.link?.syncedAt ?? new Date().toISOString();
  } catch (error) {
    console.warn("[remote-note-sync] refresh baseline failed:", error instanceof Error ? error.message : error);
  }
}

/** 立即把笔记正文写回远程（内部用，已被防抖包一层） */
async function pushNow(noteId: string): Promise<void> {
  const content = pushPending.get(noteId);
  pushPending.delete(noteId);
  if (content === undefined) return;

  const links = await ensureLinks();
  const link = links.find((item) => item.noteId === noteId);
  if (!link) return;

  let markdown = "";
  try {
    markdown = normalizeToMarkdown(content) || "";
  } catch {
    markdown = content;
  }
  // 内容与上次同步基准一致 → 不必写远程（省一次 NAS 往返）
  if (remoteHash(markdown) === link.baseNoteHash) return;

  try {
    await api.writeRemoteFile(link.sourceId, link.remotePath, markdown);
    await refreshBaselines(link, markdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    console.warn("[remote-note-sync] push failed:", message);
    // 每个笔记每次会话只提示一次，避免定时保存反复弹窗
    if (!warnedNotes.has(noteId)) {
      warnedNotes.add(noteId);
      toast.error(`远程写回失败，改动只保存在本地：${message}`);
    }
  }
}

/** 调度写回：合并 1.2s 内的多次保存 */
export function scheduleRemoteNotePush(noteId: string, content: string | undefined): void {
  if (!noteId || content === undefined) return;
  pushPending.set(noteId, content);
  const existing = pushTimers.get(noteId);
  if (existing) clearTimeout(existing);
  pushTimers.set(noteId, setTimeout(() => {
    pushTimers.delete(noteId);
    void pushNow(noteId);
  }, 1200));
}

/**
 * 打开笔记时对齐远程：
 * - 返回 null：没链接 / 远程没变 / 读不到远程（离线时不打扰）；
 * - { status: "pulled", note }：已用远程内容覆盖本地，调用方把 note 灌回编辑器状态；
 * - { status: "kept-local" }：冲突时用户选择保留本地（已写回远程）。
 */
export async function pullRemoteNote(
  note: Pick<Note, "id" | "content">,
): Promise<{ status: "pulled"; note: Note } | { status: "kept-local" } | null> {
  const links = await ensureLinks();
  const link = links.find((item) => item.noteId === note.id);
  if (!link) return null;

  const remoteContent = await readRemote(link);
  if (remoteContent === null) return null; // 离线：不打扰，本地继续可用
  if (remoteHash(remoteContent) === link.baseRemoteHash) return null; // 远程没变

  const localMarkdown = (() => {
    try { return normalizeToMarkdown(note.content) || ""; } catch { return String(note.content ?? ""); }
  })();
  const localChanged = remoteHash(localMarkdown) !== link.baseNoteHash;

  if (!localChanged) {
    // 本地没改过 → 直接拉取，安全
    const json = markdownToTiptapJSON(remoteContent);
    const updated = await api.updateNote(note.id, {
      content: JSON.stringify(json),
      contentFormat: "tiptap-json",
    } as any);
    await refreshBaselines(link, remoteContent);
    return { status: "pulled", note: updated as Note };
  }

  const takeRemote = await confirm({
    title: "远程文件已更新",
    description: "这个笔记对应的远程文件在别处被修改过，本地也有未同步的改动。要用远程内容覆盖本地吗？",
    confirmText: "用远程覆盖",
    cancelText: "保留本地",
  });

  if (!takeRemote) {
    // 保留本地 → 直接把本地改动写回远程
    try {
      await api.writeRemoteFile(link.sourceId, link.remotePath, localMarkdown);
      await refreshBaselines(link, localMarkdown);
    } catch (error) {
      toast.error(error instanceof Error ? `写回远程失败：${error.message}` : "远程当前不可写，改动只保存在本地。");
    }
    return { status: "kept-local" };
  }

  const json = markdownToTiptapJSON(remoteContent);
  const updated = await api.updateNote(note.id, {
    content: JSON.stringify(json),
    contentFormat: "tiptap-json",
  } as any);
  await refreshBaselines(link, remoteContent);
  return { status: "pulled", note: updated as Note };
}
