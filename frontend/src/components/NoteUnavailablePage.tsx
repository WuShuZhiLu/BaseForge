import React from "react";
import { FileWarning } from "lucide-react";

/**
 * 文档打不开时的状态页（替换原先「toast 一闪 + 跳回库根」的处理）。
 *
 * 为什么用整页而不是 toast：分享链接会长期存在于 IM / 邮件里，点开时用户需要知道
 * 「发生了什么」以及「下一步能做什么」；toast 一闪而过，且跳转会把 URL 也弄丢，
 * 无法刷新重试、也无法把链接再发给人确认。
 *
 * 说明文案刻意不区分「不存在」与「无权限」——后端对两者统一返回 404（避免泄露
 * 文档存在性），前端也不该编造更精确的结论。
 */
export interface NoteUnavailablePageProps {
  status?: number;
  onBack: () => void;
  onRetry: () => void;
}

export default function NoteUnavailablePage({ status, onBack, onRetry }: NoteUnavailablePageProps) {
  const forbidden = status === 401 || status === 403;
  const missing = status === 404;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md rounded-2xl border border-app-border bg-app-elevated px-8 py-10 text-center shadow-[0_12px_32px_rgba(15,23,42,0.08)]">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-app-hover">
          <FileWarning size={26} className="text-tx-tertiary" />
        </div>
        <h2 className="mt-4 text-[16px] font-semibold text-tx-primary">
          {missing ? "文档不存在或已被删除" : forbidden ? "你没有访问这篇文档的权限" : "无法打开这篇文档"}
        </h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-tx-tertiary">
          {missing
            ? "链接可能已经失效，或作者删除了这篇文档。如果你的账号有权限，它可能还在回收站里。"
            : forbidden
              ? "作者可能收回了共享权限，或该文档已移动到其他空间。请联系作者确认。"
              : "加载文档时出错，可能是网络或服务端问题，可以稍后重试。"}
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-full bg-accent-primary px-5 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
          >
            返回知识库
          </button>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full border border-app-border px-5 py-2 text-[12.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            重试
          </button>
        </div>
      </div>
    </div>
  );
}
