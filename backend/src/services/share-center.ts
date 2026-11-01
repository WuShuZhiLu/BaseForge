/**
 * 分享中心（统一列表的口径来源）
 * ---------------------------------------------------------------------------
 * 产品里原本有 5 条互不相通的分享通道，各自建表、各自有 UI，互相看不见：
 *   note_share           shares                  → 分享管理页（唯一有管理界面的）
 *   attachment_share     attachment_shares       → 只在文件管理的筛选里
 *   file_share           file_shares             → 完全没有 UI，列不出也撤不掉
 *   notebook_invite      notebook_share_links    → 只在目录分享对话框里
 *   notebook_publication notebook_publications   → 只在目录分享对话框里
 * 实测后果：dev 库笔记分享 0 条、文件分享 1 条，打开「分享管理」是空白页；
 * 用户分享出去的链接有一半在任何界面都找不到，也就无法撤销。
 *
 * 本模块把五路数据收成一个列表，并做三件事：
 *   1. 归一状态（active / disabled / expired / exhausted / orphan，orphan 优先）
 *      与访问语义（access + permission + hasPassword）；
 *   2. 分组计数与列表**同源**——左栏徽标的数字必须等于点进去的条数，
 *      这条是上一轮「未引用分类恒为空」的直接教训；
 *   3. 批量处置（停用 / 设过期 / 删除），其中目录邀请链接必须连带清理经它加入的成员，
 *      否则撤了链接却留下访问权。
 *
 * 可见性判定不在这里重新实现：笔记分享复用 share-management 的 canManageShare
 * （三级角色），其余四路沿用各自表原有的属主语义（ownerId / createdBy）。
 */
import { ensureFileSharesTable } from "./file-shares";
import { ensureNotebookPublicationTables } from "../runtime/notebook-publication";
import {
  canManageShare,
  loadShareManagementRows,
  type ShareManagementRawRow,
} from "./share-management";
import { notebookShareLinksRepository, notebookMembersRepository } from "../repositories";

export type ShareCenterChannel =
  | "note_share"
  | "attachment_share"
  | "file_share"
  | "notebook_invite"
  | "notebook_publication"
  /** 附件原件自带的免登录直链：不是分享记录，只能查看/复制，不能停用或删除。 */
  | "attachment_bare";

export type ShareCenterObjectKind = "note" | "file" | "notebook";

/** orphan 优先于 disabled/expired：原对象没了，用户第一件事是清理而不是看它还「正常」。 */
export type ShareCenterStatus = "active" | "disabled" | "expired" | "exhausted" | "orphan";

/** 左栏三组：生效中 / 需要处理（过期 + 次数耗尽 + 孤儿）/ 已停用。 */
export type ShareCenterStatusGroup = "active" | "attention" | "disabled";

export type ShareCenterRisk = "open_ended" | "orphan" | "unused" | "bare";

export type ShareCenterAccess = "link" | "password" | "code" | "public" | "members";

export type ShareCenterPermission =
  | "view"
  | "comment"
  | "edit"
  | "edit_auth"
  | "download"
  | "preview"
  | "member_viewer"
  | "member_editor";

export interface ShareCenterItem {
  id: string;
  channel: ShareCenterChannel;
  objectKind: ShareCenterObjectKind;
  objectId: string;
  title: string | null;
  /** 面包屑：个人空间 / 工作空间名 / 目录名 */
  objectPath: string;
  token: string;
  /** 访客页路径（相对公开域名） */
  urlPath: string;
  access: ShareCenterAccess;
  permission: ShareCenterPermission;
  hasPassword: boolean;
  isActive: boolean;
  /** file_shares 不计数，故为 null——不能谎报成 0 次访问。 */
  viewCount: number | null;
  maxViews: number | null;
  lastSeenAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  objectMissing: boolean;
  objectTrashed: boolean;
  status: ShareCenterStatus;
  risks: ShareCenterRisk[];
  /** 仅目录公开出版有值；其它通道为 null。 */
  capabilities: { download: boolean; comment: boolean; edit: boolean; reshare: boolean } | null;
}

export interface ShareCenterQuery {
  q?: string;
  group?: ShareCenterStatusGroup;
  objectKind?: ShareCenterObjectKind;
  permission?: ShareCenterPermission;
  hasPassword?: boolean;
  risk?: ShareCenterRisk;
  expiresWithinDays?: number;
  sort?: "lastSeenAt" | "updatedAt" | "createdAt" | "expiresAt" | "viewCount" | "title";
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface ShareCenterCounts {
  total: number;
  groups: Record<ShareCenterStatusGroup, number>;
  statuses: Record<ShareCenterStatus, number>;
  objects: Record<ShareCenterObjectKind, number>;
  risks: Record<ShareCenterRisk, number>;
}

const GROUPS: Record<ShareCenterStatus, ShareCenterStatusGroup> = {
  active: "active",
  expired: "attention",
  exhausted: "attention",
  orphan: "attention",
  disabled: "disabled",
};

const STATUS_VALUES = new Set<ShareCenterStatusGroup>(["active", "attention", "disabled"]);
const OBJECT_VALUES = new Set<ShareCenterObjectKind>(["note", "file", "notebook"]);
const PERMISSION_VALUES = new Set<ShareCenterPermission>([
  "view", "comment", "edit", "edit_auth", "download", "preview", "member_viewer", "member_editor",
]);
const RISK_VALUES = new Set<ShareCenterRisk>(["open_ended", "orphan", "unused", "bare"]);
const SORT_VALUES = new Set<NonNullable<ShareCenterQuery["sort"]>>([
  "lastSeenAt", "updatedAt", "createdAt", "expiresAt", "viewCount", "title",
]);

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function parseShareCenterQuery(input: Record<string, string | undefined>): ShareCenterQuery {
  const group = STATUS_VALUES.has(input.group as ShareCenterStatusGroup)
    ? (input.group as ShareCenterStatusGroup)
    : undefined;
  const objectKind = OBJECT_VALUES.has(input.objectKind as ShareCenterObjectKind)
    ? (input.objectKind as ShareCenterObjectKind)
    : undefined;
  const permission = PERMISSION_VALUES.has(input.permission as ShareCenterPermission)
    ? (input.permission as ShareCenterPermission)
    : undefined;
  const risk = RISK_VALUES.has(input.risk as ShareCenterRisk) ? (input.risk as ShareCenterRisk) : undefined;
  const hasPassword =
    input.hasPassword === "1" || input.hasPassword === "true"
      ? true
      : input.hasPassword === "0" || input.hasPassword === "false"
        ? false
        : undefined;
  const expiresWithinDays = input.expiresWithinDays ? Number(input.expiresWithinDays) : undefined;
  return {
    q: input.q?.trim() || undefined,
    group,
    objectKind,
    permission,
    hasPassword,
    risk,
    expiresWithinDays:
      expiresWithinDays !== undefined && Number.isFinite(expiresWithinDays) && expiresWithinDays > 0
        ? expiresWithinDays
        : undefined,
    sort: SORT_VALUES.has(input.sort as NonNullable<ShareCenterQuery["sort"]>)
      ? (input.sort as NonNullable<ShareCenterQuery["sort"]>)
      : "updatedAt",
    order: input.order === "asc" ? "asc" : "desc",
    page: positiveInt(input.page, 1, 1_000_000),
    pageSize: positiveInt(input.pageSize, 50, 200),
  };
}

function isPast(value: string | null | undefined, nowMs: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

function resolveStatus(
  input: {
    isActive: boolean;
    expiresAt: string | null;
    viewCount: number | null;
    maxViews: number | null;
    objectMissing: boolean;
    objectTrashed: boolean;
  },
  nowMs: number,
): ShareCenterStatus {
  if (input.objectMissing || input.objectTrashed) return "orphan";
  if (!input.isActive) return "disabled";
  if (isPast(input.expiresAt, nowMs)) return "expired";
  if (input.maxViews !== null && (input.viewCount || 0) >= input.maxViews) return "exhausted";
  return "active";
}

function resolveRisks(item: {
  access: ShareCenterAccess;
  hasPassword: boolean;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number | null;
}, status: ShareCenterStatus): ShareCenterRisk[] {
  const risks: ShareCenterRisk[] = [];
  // 只给「当前真的能用」的链接贴风险标签：已失效 / 已停用 / 原对象没了的行
  // 该走的是清理，把它们混进「无密码永久链」里会让风险筛选失去行动含义。
  if (status === "active") {
    // 「无密码且永久」= 任何拿到链接的人可以无限期反复访问，是最该被处置的一条。
    if (
      !item.hasPassword
      && !item.expiresAt
      && item.maxViews === null
      && (item.access === "link" || item.access === "public")
    ) {
      risks.push("open_ended");
    }
    if (item.viewCount === 0) risks.push("unused");
  }
  if (status === "orphan") risks.push("orphan");
  return risks;
}

function buildObjectPath(workspaceName: string | null, notebookName: string | null): string {
  const head = workspaceName || "个人空间";
  return notebookName ? `${head} / ${notebookName}` : head;
}

function finalize(
  draft: Omit<ShareCenterItem, "status" | "risks">,
  nowMs: number,
): ShareCenterItem {
  const status = resolveStatus(draft, nowMs);
  return { ...draft, status, risks: resolveRisks(draft, status) };
}

// ===== 五路数据源 =====

/** 笔记分享：复用分享管理的三级角色可见性判定，避免再造一套口径。 */
function collectNoteShares(db: any, userId: string, nowMs: number): ShareCenterItem[] {
  const { rows, access } = loadShareManagementRows(db, userId);
  const manageable = rows.filter((row) => canManageShare(row, userId, access));
  const sessions = loadLastSeenByShare(db, manageable.map((row) => row.id));
  return manageable.map((row: ShareManagementRawRow) =>
    finalize(
      {
        id: row.id,
        channel: "note_share",
        objectKind: "note",
        objectId: row.noteId,
        title: row.noteTitle,
        objectPath: buildObjectPath(row.workspaceName, row.notebookName),
        token: row.shareToken,
        urlPath: `/share/${row.shareToken}`,
        access: row.password ? "password" : "link",
        permission: row.permission as ShareCenterPermission,
        hasPassword: Boolean(row.password),
        isActive: Boolean(Number(row.isActive)),
        viewCount: Number(row.viewCount || 0),
        maxViews: row.maxViews,
        lastSeenAt: sessions.get(row.id) || null,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        objectMissing: !row.noteOwnerId,
        objectTrashed: Boolean(row.noteIsTrashed),
        capabilities: null,
      },
      nowMs,
    ),
  );
}

/** 附件可控分享（文件管理里的分享）：沿用 `/api/attachment-shares` 的属主语义。 */
function collectAttachmentShares(db: any, userId: string, nowMs: number): ShareCenterItem[] {
  const rows = db.prepare(`
    SELECT s.*, a.filename, a.noteId, n.title AS noteTitle, n.isTrashed AS noteIsTrashed,
           n.workspaceId AS workspaceId, nb.name AS notebookName, w.name AS workspaceName
    FROM attachment_shares s
    JOIN attachments a ON a.id = s.attachmentId
    LEFT JOIN notes n ON n.id = a.noteId
    LEFT JOIN notebooks nb ON nb.id = n.notebookId
    LEFT JOIN workspaces w ON w.id = n.workspaceId
    WHERE s.ownerId = ?
  `).all(userId) as any[];

  return rows.map((row) =>
    finalize(
      {
        id: row.id,
        channel: "attachment_share",
        objectKind: "file",
        objectId: row.attachmentId,
        title: row.filename || null,
        // 附件仍由某篇笔记持有，面包屑显示持有者位置，便于用户判断"这文件在哪"
        objectPath: row.noteTitle
          ? `${buildObjectPath(row.workspaceName, row.notebookName)} / ${row.noteTitle}`
          : buildObjectPath(row.workspaceName, row.notebookName),
        token: row.shareToken,
        urlPath: `/fs/${row.shareToken}`,
        access: row.password ? "password" : "link",
        permission: "download",
        hasPassword: Boolean(row.password),
        isActive: Boolean(Number(row.isActive)),
        viewCount: Number(row.viewCount || 0),
        maxViews: row.maxViews ?? null,
        lastSeenAt: null,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        objectMissing: !row.noteId,
        objectTrashed: Boolean(row.noteIsTrashed),
        capabilities: null,
      },
      nowMs,
    ),
  );
}

/** 运行时稳定文件直链：此前没有任何 UI，能列出但完全不计数，所以 viewCount 留 null。 */
function collectFileShares(db: any, userId: string, nowMs: number): ShareCenterItem[] {
  ensureFileSharesTable();
  const rows = db.prepare(`
    SELECT fs.*, a.filename, n.id AS existsNoteId, n.title AS noteTitle, n.isTrashed AS noteIsTrashed,
           n.workspaceId AS workspaceId, nb.name AS notebookName, w.name AS workspaceName
    FROM file_shares fs
    JOIN attachments a ON a.id = fs.attachmentId
    LEFT JOIN notes n ON n.id = fs.noteId
    LEFT JOIN notebooks nb ON nb.id = n.notebookId
    LEFT JOIN workspaces w ON w.id = n.workspaceId
    WHERE fs.ownerId = ?
  `).all(userId) as any[];

  return rows.map((row) =>
    finalize(
      {
        id: row.id,
        channel: "file_share",
        objectKind: "file",
        objectId: row.attachmentId,
        title: row.filename || null,
        objectPath: row.noteTitle
          ? `${buildObjectPath(row.workspaceName, row.notebookName)} / ${row.noteTitle}`
          : buildObjectPath(row.workspaceName, row.notebookName),
        token: row.token,
        urlPath: `/api/attachments/${encodeURIComponent(row.attachmentId)}?share=${encodeURIComponent(row.token)}`,
        access: "link",
        permission: Number(row.allowDownload) === 0 ? "preview" : "download",
        hasPassword: false,
        isActive: Boolean(Number(row.isActive)),
        viewCount: null,
        maxViews: null,
        lastSeenAt: null,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        objectMissing: !row.existsNoteId,
        objectTrashed: Boolean(row.noteIsTrashed),
        capabilities: null,
      },
      nowMs,
    ),
  );
}

/** 目录邀请链接：字段名与其它通道不同（enabled / maxUses / useCount），在这里映射。 */
function collectNotebookInvites(db: any, userId: string, nowMs: number): ShareCenterItem[] {
  const rows = db.prepare(`
    SELECT l.*, nb.name AS notebookName, nb.isDeleted AS notebookDeleted, nb.userId AS notebookOwnerId,
           w.name AS workspaceName
    FROM notebook_share_links l
    JOIN notebooks nb ON nb.id = l.notebookId
    LEFT JOIN workspaces w ON w.id = nb.workspaceId
    WHERE l.createdBy = ? OR nb.userId = ?
  `).all(userId, userId) as any[];

  return rows.map((row) =>
    finalize(
      {
        id: row.id,
        channel: "notebook_invite",
        objectKind: "notebook",
        objectId: row.notebookId,
        title: row.notebookName,
        objectPath: buildObjectPath(row.workspaceName, null),
        token: row.token,
        urlPath: `/notebook-share/${row.token}`,
        access: "members",
        permission: row.role === "editor" ? "member_editor" : "member_viewer",
        hasPassword: false,
        isActive: Boolean(Number(row.enabled)),
        viewCount: Number(row.useCount || 0),
        maxViews: row.maxUses ?? null,
        lastSeenAt: null,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        objectMissing: Boolean(row.notebookDeleted),
        objectTrashed: false,
        capabilities: null,
      },
      nowMs,
    ),
  );
}

/** 目录公开出版：4 个 capability 原样带出，UI 才能解释「允许下载 / 评论」。 */
function collectPublications(db: any, userId: string, nowMs: number): ShareCenterItem[] {
  ensureNotebookPublicationTables();
  const rows = db.prepare(`
    SELECT p.*, nb.name AS notebookName, nb.isDeleted AS notebookDeleted, w.name AS workspaceName
    FROM notebook_publications p
    JOIN notebooks nb ON nb.id = p.notebookId
    LEFT JOIN workspaces w ON w.id = nb.workspaceId
    WHERE p.ownerId = ?
  `).all(userId) as any[];

  return rows.map((row) =>
    finalize(
      {
        id: row.id,
        channel: "notebook_publication",
        objectKind: "notebook",
        objectId: row.notebookId,
        title: row.notebookName,
        objectPath: buildObjectPath(row.workspaceName, null),
        token: row.token,
        urlPath: `/public/${row.token}`,
        access: row.accessMode as ShareCenterAccess,
        permission: row.permission === "write" ? "edit" : row.permission === "comment" ? "comment" : "view",
        hasPassword: row.accessMode === "password",
        isActive: Boolean(Number(row.isActive)),
        viewCount: null,
        maxViews: null,
        lastSeenAt: null,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        objectMissing: Boolean(row.notebookDeleted),
        objectTrashed: false,
        capabilities: {
          download: Boolean(Number(row.allowDownload)),
          comment: Boolean(Number(row.allowComment)),
          edit: Boolean(Number(row.allowEdit)),
          reshare: Boolean(Number(row.allowReshare)),
        },
      },
      nowMs,
    ),
  );
}

function loadLastSeenByShare(db: any, shareIds: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (shareIds.length === 0) return result;
  const placeholders = shareIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT shareId, MAX(lastSeenAt) AS lastSeenAt
    FROM share_view_sessions
    WHERE shareId IN (${placeholders})
    GROUP BY shareId
  `).all(...shareIds) as Array<{ shareId: string; lastSeenAt: string }>;
  for (const row of rows) result.set(row.shareId, row.lastSeenAt);
  return result;
}

// ===== 聚合 =====

function collectShareCenterItems(db: any, userId: string, nowMs: number): ShareCenterItem[] {
  return [
    ...collectNoteShares(db, userId, nowMs),
    ...collectAttachmentShares(db, userId, nowMs),
    ...collectFileShares(db, userId, nowMs),
    ...collectNotebookInvites(db, userId, nowMs),
    ...collectPublications(db, userId, nowMs),
  ];
}

/**
 * 附件裸直链：`/api/attachments/:id` 是笔记插图自带的免登录直链，不是分享记录。
 * 它不计数、不能停用、不能撤销（关掉会让笔记里的图裂），所以独立成一路数据源，
 * 只在「附件裸直链」风险分类下进列表 —— 混进默认列表会让「全部分享」的条数变假。
 */
function collectBareAttachments(db: any, userId: string): ShareCenterItem[] {
  const rows = db.prepare(`
    SELECT a.id, a.filename, a.size, a.createdAt, n.title AS noteTitle
    FROM attachments a
    LEFT JOIN notes n ON n.id = a.noteId
    WHERE a.userId = ?
    ORDER BY a.createdAt DESC
  `).all(userId) as Array<{ id: string; filename: string; size: number; createdAt: string; noteTitle: string | null }>;

  return rows.map((row) => ({
    id: row.id,
    channel: "attachment_bare" as const,
    objectKind: "file" as const,
    objectId: row.id,
    title: row.filename || null,
    objectPath: row.noteTitle ? `附件原件 / ${row.noteTitle}` : "附件原件",
    token: row.id,
    urlPath: `/api/attachments/${row.id}`,
    access: "link" as const,
    permission: "download" as const,
    hasPassword: false,
    isActive: true,
    viewCount: null,
    maxViews: null,
    lastSeenAt: null,
    expiresAt: null,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    objectMissing: false,
    objectTrashed: false,
    // 它只以「附件裸直链」分类出现，本身永久有效（不可停用/撤销）
    status: "active" as const,
    risks: ["bare"] as ShareCenterRisk[],
    capabilities: null,
  }));
}

function buildCounts(items: ShareCenterItem[]): ShareCenterCounts {
  const counts: ShareCenterCounts = {
    total: items.length,
    groups: { active: 0, attention: 0, disabled: 0 },
    statuses: { active: 0, disabled: 0, expired: 0, exhausted: 0, orphan: 0 },
    objects: { note: 0, file: 0, notebook: 0 },
    risks: { open_ended: 0, orphan: 0, unused: 0, bare: 0 },
  };
  for (const item of items) {
    counts.groups[GROUPS[item.status]] += 1;
    counts.statuses[item.status] += 1;
    counts.objects[item.objectKind] += 1;
    for (const risk of item.risks) counts.risks[risk] += 1;
  }
  return counts;
}

function matchesQuery(item: ShareCenterItem, query: ShareCenterQuery, nowMs: number, needle: string): boolean {
  if (query.group && GROUPS[item.status] !== query.group) return false;
  if (query.objectKind && item.objectKind !== query.objectKind) return false;
  if (query.permission && item.permission !== query.permission) return false;
  if (query.hasPassword !== undefined && item.hasPassword !== query.hasPassword) return false;
  if (query.risk && !item.risks.includes(query.risk)) return false;
  if (query.expiresWithinDays !== undefined) {
    if (!item.expiresAt) return false;
    const deadline = nowMs + query.expiresWithinDays * 86_400_000;
    const at = Date.parse(item.expiresAt);
    if (!Number.isFinite(at) || at <= nowMs || at > deadline) return false;
  }
  if (needle) {
    const haystack = [item.title, item.objectPath, item.token].join(" ").toLocaleLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function compareItems(a: ShareCenterItem, b: ShareCenterItem, sort: NonNullable<ShareCenterQuery["sort"]>, direction: number): number {
  if (sort === "title") {
    return String(a.title || "").localeCompare(String(b.title || ""), "zh-CN") * direction;
  }
  if (sort === "viewCount") {
    // 不计数的通道（file_shares / publication）不等于"0 次访问"，
    // 与 lastSeenAt / expiresAt 同理：不管升序降序都沉底。
    const an = a.viewCount === null ? null : a.viewCount;
    const bn = b.viewCount === null ? null : b.viewCount;
    if (an === null && bn === null) return a.id.localeCompare(b.id);
    if (an === null) return 1;
    if (bn === null) return -1;
    return ((an - bn) * direction) || a.id.localeCompare(b.id);
  }
  const left = a[sort];
  const right = b[sort];
  if (sort === "lastSeenAt") {
    const at = left ? Date.parse(left) : Number.NaN;
    const bt = right ? Date.parse(right) : Number.NaN;
    const an = Number.isFinite(at);
    const bn = Number.isFinite(bt);
    if (!an && !bn) return a.id.localeCompare(b.id);
    if (!an) return 1;
    if (!bn) return -1;
    return ((at - bt) * direction) || a.id.localeCompare(b.id);
  }
  if (sort === "expiresAt") {
    // 永久（null）在降序时排到最后，升序时仍是"最近到期"排最前——与列表语义一致
    const at = left ? Date.parse(left) : Number.NaN;
    const bt = right ? Date.parse(right) : Number.NaN;
    const an = Number.isFinite(at);
    const bn = Number.isFinite(bt);
    if (!an && !bn) return a.id.localeCompare(b.id);
    if (!an) return 1;
    if (!bn) return -1;
    return ((at - bt) * direction) || a.id.localeCompare(b.id);
  }
  return (Date.parse(String(left)) - Date.parse(String(right))) * direction || a.id.localeCompare(b.id);
}

export function queryShareCenter(db: any, userId: string, query: ShareCenterQuery, nowMs = Date.now()) {
  const items = collectShareCenterItems(db, userId, nowMs);
  // 徽标数与列表同源：counts 从完整集合统计，再按筛选条件切片，绝不另算一套。
  const counts = buildCounts(items);
  // 裸直链是附件原件，不在分享记录集合里：单独成池，只在「附件裸直链」分类下
  // 当列表用（其余筛选条件照常生效），计数回填到左栏徽标。
  const bareItems = collectBareAttachments(db, userId);
  counts.risks.bare = bareItems.length;
  const needle = query.q?.toLocaleLowerCase() || "";
  const pool = query.risk === "bare" ? bareItems : items;
  const filtered = pool.filter((item) => matchesQuery(item, query, nowMs, needle));
  const direction = query.order === "asc" ? 1 : -1;
  const sort = query.sort || "updatedAt";
  filtered.sort((a, b) => compareItems(a, b, sort, direction));

  const page = Math.max(1, query.page || 1);
  const pageSize = Math.max(1, Math.min(200, query.pageSize || 50));
  const start = (page - 1) * pageSize;

  return {
    items: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageSize,
    counts,
    bareAttachmentUrls: { count: bareItems.length, revocable: false },
  };
}

/**
 * 按「通道 + 被分享对象」精确定位一条分享项。
 * 附件/文件列表里的「分享」入口跳分享中心时要直接打开对应抽屉，
 * 不能靠列表分页碰运气；口径直接复用 collectShareCenterItems，不另算一套。
 */
export function queryShareCenterItem(
  db: any,
  userId: string,
  channel: ShareCenterChannel,
  objectId: string,
  nowMs = Date.now(),
): ShareCenterItem | null {
  if (channel === "attachment_bare") {
    return collectBareAttachments(db, userId).find((item) => item.objectId === objectId) || null;
  }
  return collectShareCenterItems(db, userId, nowMs)
    .find((item) => item.channel === channel && item.objectId === objectId) || null;
}

export interface ShareCenterVisit {
  /** 会话哈希前 6 位：同一个浏览器算一个会话，前端用它区分不同访客。 */
  session: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ipPrefix: string | null;
}

/** 密码爆破失败次数：两个通道各自在审计日志里留了一条失败事件，按 share id 数节点即可。 */
function countCredentialFailures(db: any, channel: ShareCenterChannel, id: string): number {
  const actions = channel === "note_share"
    ? ["credential_failure"]
    : channel === "attachment_share"
      ? ["attachment_share_credential_failure"]
      : [];
  if (actions.length === 0) return 0;
  try {
    return Number((db.prepare(
      `SELECT COUNT(*) AS n FROM audit_logs
       WHERE category = 'share' AND targetId = ? AND action IN (${actions.map(() => "?").join(",")})`,
    ).get(id, ...actions) as { n: number }).n || 0);
  } catch {
    // audit_logs 由审计服务懒建表：旧库/测试库还没建时按「无失败记录」处理
    return 0;
  }
}

/**
 * 单条分享的访问明细（抽屉「访问记录」）。
 * 只有笔记分享有会话表；其余通道的访问计数不在 share_view_sessions 里，
 * 返回 supported=false 而不是编造数据。失败尝试次数走审计日志，两通道都能给。
 */
export function queryShareVisits(
  db: any,
  userId: string,
  channel: ShareCenterChannel,
  id: string,
  limit = 5,
): { total: number; visits: ShareCenterVisit[]; supported: boolean; failedAttempts: number } {
  if (channel === "attachment_share") {
    const owned = db.prepare(
      "SELECT id FROM attachment_shares WHERE id = ? AND ownerId = ?",
    ).get(id, userId) as { id: string } | undefined;
    return { total: 0, visits: [], supported: false, failedAttempts: owned ? countCredentialFailures(db, channel, id) : 0 };
  }
  if (channel !== "note_share") {
    return { total: 0, visits: [], supported: false, failedAttempts: 0 };
  }
  const { rows, access } = loadShareManagementRows(db, userId);
  const row = rows.find((entry) => entry.id === id);
  if (!row || !canManageShare(row, userId, access)) {
    return { total: 0, visits: [], supported: true, failedAttempts: 0 };
  }
  const total = Number((db.prepare(
    "SELECT COUNT(*) AS n FROM share_view_sessions WHERE shareId = ?",
  ).get(id) as { n: number }).n || 0);
  const visits = db.prepare(`
    SELECT sessionHash, createdAt, lastSeenAt, userAgent, ipPrefix
    FROM share_view_sessions
    WHERE shareId = ?
    ORDER BY lastSeenAt DESC
    LIMIT ?
  `).all(id, Math.max(1, Math.min(20, limit))) as Array<{
    sessionHash: string; createdAt: string; lastSeenAt: string;
    userAgent: string | null; ipPrefix: string | null;
  }>;
  return {
    total,
    supported: true,
    failedAttempts: countCredentialFailures(db, channel, id),
    visits: visits.map((visit) => ({
      session: String(visit.sessionHash).slice(0, 6),
      createdAt: visit.createdAt,
      lastSeenAt: visit.lastSeenAt,
      userAgent: visit.userAgent || null,
      ipPrefix: visit.ipPrefix || null,
    })),
  };
}

// ===== 批量处置 =====

export type ShareCenterBatchAction = "disable" | "delete" | "expire";

export interface ShareCenterBatchTarget {
  channel: ShareCenterChannel;
  id: string;
}

const CHANNELS = new Set<ShareCenterChannel>([
  "note_share", "attachment_share", "file_share", "notebook_invite", "notebook_publication",
]);

/**
 * 批量停用 / 删除 / 设过期。
 * 只按属主写自己那行的语义，跨表的复杂权限（如目录成员继承）沿用各自既有入口，
 * 这里不复制一份判定逻辑——避免又造出第二个口径。
 */
export function applyShareCenterBatchAction(
  db: any,
  userId: string,
  action: ShareCenterBatchAction,
  targets: ShareCenterBatchTarget[],
  expiresAt: string | null = null,
): { succeeded: number; failed: number } {
  let succeeded = 0;
  let failed = 0;
  for (const target of targets) {
    if (!CHANNELS.has(target.channel) || !target.id) { failed += 1; continue; }
    try {
      if (applyOne(db, userId, action, target, expiresAt)) succeeded += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { succeeded, failed };
}

function applyOne(
  db: any,
  userId: string,
  action: ShareCenterBatchAction,
  target: ShareCenterBatchTarget,
  expiresAt: string | null,
): boolean {
  const id = target.id;
  switch (target.channel) {
    case "attachment_bare":
      // 附件裸直链不是分享记录：没有可停用/可删除的对象，只能告知
      return false;
    case "note_share": {
      if (action === "delete") {
        return db.prepare("DELETE FROM shares WHERE id = ? AND ownerId = ?").run(id, userId).changes > 0;
      }
      if (action === "disable") {
        return db.prepare("UPDATE shares SET isActive = 0, updatedAt = datetime('now') WHERE id = ? AND ownerId = ?")
          .run(id, userId).changes > 0;
      }
      return db.prepare("UPDATE shares SET expiresAt = ?, updatedAt = datetime('now') WHERE id = ? AND ownerId = ?")
        .run(expiresAt, id, userId).changes > 0;
    }
    case "attachment_share": {
      if (action === "delete") {
        return db.prepare("DELETE FROM attachment_shares WHERE id = ? AND ownerId = ?").run(id, userId).changes > 0;
      }
      if (action === "disable") {
        return db.prepare("UPDATE attachment_shares SET isActive = 0, updatedAt = datetime('now') WHERE id = ? AND ownerId = ?")
          .run(id, userId).changes > 0;
      }
      return db.prepare("UPDATE attachment_shares SET expiresAt = ?, updatedAt = datetime('now') WHERE id = ? AND ownerId = ?")
        .run(expiresAt, id, userId).changes > 0;
    }
    case "file_share": {
      if (action === "delete") {
        return db.prepare("DELETE FROM file_shares WHERE id = ? AND ownerId = ?").run(id, userId).changes > 0;
      }
      if (action === "disable") {
        return db.prepare("UPDATE file_shares SET isActive = 0, updatedAt = datetime('now') WHERE id = ? AND ownerId = ?")
          .run(id, userId).changes > 0;
      }
      return db.prepare("UPDATE file_shares SET expiresAt = ?, updatedAt = datetime('now') WHERE id = ? AND ownerId = ?")
        .run(expiresAt, id, userId).changes > 0;
    }
    case "notebook_invite": {
      // 邀请链接经它加入的成员是真实授权，撤销链接必须同步移除来源为 invite_link 的成员，
      // 否则"链接撤了但人还在"。语义与 DELETE /:id/share-link 一致。
      const link = notebookShareLinksRepository.getById(id);
      if (!link || link.createdBy !== userId) return false;
      if (action === "expire") {
        notebookShareLinksRepository.update(id, { expiresAt });
        return true;
      }
      notebookShareLinksRepository.update(id, { enabled: 0 });
      notebookMembersRepository.removeBySource("invite_link", id);
      if (action === "delete") {
        return db.prepare("DELETE FROM notebook_share_links WHERE id = ? AND createdBy = ?").run(id, userId).changes > 0;
      }
      return true;
    }
    case "notebook_publication": {
      if (action === "delete") {
        return db.prepare("DELETE FROM notebook_publications WHERE id = ? AND ownerId = ?").run(id, userId).changes > 0;
      }
      if (action === "disable") {
        return db.prepare("UPDATE notebook_publications SET isActive = 0, updatedAt = datetime('now') WHERE id = ? AND ownerId = ?")
          .run(id, userId).changes > 0;
      }
      return db.prepare("UPDATE notebook_publications SET expiresAt = ?, updatedAt = datetime('now') WHERE id = ? AND ownerId = ?")
        .run(expiresAt, id, userId).changes > 0;
    }
  }
}
