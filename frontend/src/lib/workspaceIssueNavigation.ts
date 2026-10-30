import { getCurrentWorkspace, setCurrentWorkspace } from "./api";
import { pushAppPathState } from "./appPathNavigation";

export const OPEN_NOTIFICATIONS_EVENT = "nowen:open-notifications";
export const NOTIFICATIONS_CHANGED_EVENT = "nowen:notifications-changed";

export interface IssueAppRoute { matched: boolean; issueId: string | null }

/** 构造 issue 路径：issues 天生属于协作空间（workspace_issues.workspaceId NOT NULL），
 *  URL 必须带空间段（/issues/:space[/:issueId]）。 */
export function buildIssueAppPath(issueId: string | null, workspaceId: string): string {
  const space = encodeURIComponent(workspaceId);
  return issueId ? `/issues/${space}/${encodeURIComponent(issueId)}` : `/issues/${space}`;
}

/** 兼容读侧：仅匹配模块根 /issues（空间段与 issue 资源的解析由 parseAppRoute 负责，
 *  两段 /issues/:x 语义已归空间段）。 */
export function parseIssueAppPath(path: string): IssueAppRoute {
  if (/^\/issues\/?$/.test(path)) return { matched: true, issueId: null };
  return { matched: false, issueId: null };
}

export function openWorkspaceIssue(issueId: string | null, workspaceId?: string) {
  const targetWorkspace = workspaceId ?? getCurrentWorkspace();
  if (getCurrentWorkspace() !== targetWorkspace) {
    setCurrentWorkspace(targetWorkspace);
    window.dispatchEvent(new CustomEvent("nowen:workspace-changed", { detail: { workspaceId: targetWorkspace } }));
  }
  pushAppPathState(buildIssueAppPath(issueId, targetWorkspace));
}
