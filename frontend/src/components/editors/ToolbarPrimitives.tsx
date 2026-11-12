import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 编辑器工具栏的原子组件。
 *
 * 富文本编辑器（TiptapEditor）与 PDF 文档编辑器（PdfDocEditor）共用同一套，
 * 保证两条工具栏在按钮尺寸、圆角、激活态、分隔线上完全一致——否则同一种笔记
 * 切过去就像换了个产品。
 */
export interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  children: ReactNode;
  title?: string;
  compact?: boolean;
  className?: string;
}

export function ToolbarButton({ onClick, isActive, disabled, children, title, compact, className }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      // 阻止 mousedown 抢焦点：PDF 里点气泡按钮不能把文本选区清掉，富文本里同理
      onMouseDown={(event) => event.preventDefault()}
      disabled={disabled}
      title={title}
      className={cn(
        // 统一固定高度：行高不随"哪个按钮被换行到第几行"变化，
        // 保证折叠单行与展开态第一行高度一致
        "flex h-7 shrink-0 items-center justify-center rounded-full transition-colors",
        compact ? "p-1" : "p-1.5",
        isActive
          ? "bg-accent-primary/20 text-accent-primary"
          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        disabled && "opacity-30 cursor-not-allowed",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function ToolbarDivider() {
  return <div className="h-5 w-px shrink-0 bg-app-border mx-1" />;
}
