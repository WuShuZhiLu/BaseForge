/**
 * 外网白名单展示 —— 插件声明 external:fetch 时，把"会访问哪些域名"直接摆在权限旁边。
 *
 * 数据来源（后端已确认）：
 * - 已安装插件：permissions[].hosts（后端 PermissionView 从 configJson 解析平铺，plugins/permissions.ts）
 * - 市场目录：versions[].permissionConfig.externalFetchHosts（plugins/ecosystemRegistry.ts）
 * - 安装确认弹窗：manifest.permissionConfig.externalFetchHosts
 *
 * 折叠阈值 6：条目更多时先显示 6 个 + 「还有 N 个」，点开展开全部。
 * 没有域名数据时不渲染，调用方无需额外判断。
 */
import { useState } from "react";
import { cn } from "@/lib/utils";

/** 超过该条数折叠 */
export const EXTERNAL_HOST_FOLD_LIMIT = 6;

export function ExternalHostList({ hosts, className }: {
  hosts: string[];
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!hosts.length) return null;
  const visible = expanded ? hosts : hosts.slice(0, EXTERNAL_HOST_FOLD_LIMIT);
  const hidden = hosts.length - visible.length;
  return (
    <div className={cn("mt-1 pl-5", className)}>
      <p className="text-[11px] text-tx-tertiary">将访问以下域名：</p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {visible.map((host) => (
          <span
            key={host}
            className="rounded-full bg-zinc-500/15 px-2 py-0.5 font-mono text-[11px] text-tx-secondary"
          >
            {host}
          </span>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded-full px-1.5 py-0.5 text-[11px] text-accent-primary hover:underline"
          >
            还有 {hidden} 个
          </button>
        )}
      </div>
    </div>
  );
}
