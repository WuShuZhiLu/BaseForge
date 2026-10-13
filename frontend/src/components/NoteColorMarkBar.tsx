import React from "react";
import type { NoteColorMark } from "@/types";
import { cn } from "@/lib/utils";
import { getNoteColorMarkHex } from "@/lib/noteColorMark";

/**
 * 色标竖线（原小圆点的替代）。
 *
 * 产品口径（2026-10-13，用户定）：色标只保留"竖线"，不再画圆点——圆点在密集列表里
 * 不够显眼，且和左侧指示条/色条重复。
 *
 * 两种用法：
 *   - 默认：绝对定位贴在 relative 容器左边缘（树行用），不参与布局、不改变缩进；
 *   - inline：作为普通行内元素（标签栏用），由调用方给高度。
 */
export default function NoteColorMarkBar({
  value,
  className,
  inline = false,
}: {
  value?: NoteColorMark | null;
  className?: string;
  inline?: boolean;
}) {
  const color = getNoteColorMarkHex(value);
  if (!color) return null;
  return (
    <span
      data-note-color-mark-bar={value}
      aria-hidden="true"
      className={cn(
        "w-[3px] shrink-0 rounded-full",
        inline ? "relative" : "pointer-events-none absolute inset-y-0.5 left-0.5",
        className,
      )}
      style={{ backgroundColor: color }}
    />
  );
}
