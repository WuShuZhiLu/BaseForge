/**
 * DocFindBar —— 文档内「查找 / 替换」统一浮层（富文本与 Markdown 共用）。
 * ----------------------------------------------------------------------------
 * 纯受控 UI：不含任何搜索逻辑，只负责渲染与键盘交互；命中计算、装饰绘制、
 * 替换执行全部由调用方（ProseMirror 扩展 / CodeMirror panel）驱动。
 *
 * 结构（三行，替换收起时两行）：
 *   行1  搜索图标 + [输入 … 计数] + 上一个 / 下一个 │ 替换开关 / 关闭
 *   行2  Aa / ab / .* 三个字形开关（分区大小写 / 全字匹配 / 正则）
 *   行3  [替换为 …] + 替换（次要） + 全部（主操作）
 */
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search, X, ChevronUp, ChevronDown, ArrowLeftRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DocFindBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  replaceWith: string;
  onReplaceWithChange: (value: string) => void;
  /** 命中总数；配合 truncated 可显示 "500+" */
  matchCount: number;
  /** 当前命中下标（0 起）；-1 表示无当前项 */
  activeIndex: number;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  onToggleCaseSensitive: () => void;
  onToggleWholeWord: () => void;
  onToggleRegex: () => void;
  showReplace: boolean;
  onToggleReplace: () => void;
  onNext: () => void;
  onPrev: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
  /** 只读文档：可查找但隐藏替换入口 */
  editable?: boolean;
  /** 命中数被上限截断 */
  truncated?: boolean;
  /** 挂载时自动聚焦查询框（浮层每次打开都会重新挂载） */
  autoFocus?: boolean;
  className?: string;
}

export function DocFindBar({
  query,
  onQueryChange,
  replaceWith,
  onReplaceWithChange,
  matchCount,
  activeIndex,
  caseSensitive,
  wholeWord,
  useRegex,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleRegex,
  showReplace,
  onToggleReplace,
  onNext,
  onPrev,
  onReplace,
  onReplaceAll,
  onClose,
  editable = true,
  truncated = false,
  autoFocus = true,
  className,
}: DocFindBarProps) {
  const { t } = useTranslation();
  const queryInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // 每次打开（挂载）聚焦并全选查询词，便于直接覆盖输入。
  // CodeMirror 的 panel 可能在本帧结束时才挂到 document 上，此时 focus() 无效，
  // 所以未插入文档前逐帧重试几次。
  useEffect(() => {
    if (!autoFocus) return;
    let cancelled = false;
    let attempts = 0;
    let frame = 0;
    const tryFocus = () => {
      if (cancelled) return;
      const el = queryInputRef.current;
      if (el && el.isConnected) {
        el.focus();
        el.select();
        return;
      }
      if (attempts < 3) {
        attempts += 1;
        frame = requestAnimationFrame(tryFocus);
      }
    };
    frame = requestAnimationFrame(tryFocus);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [autoFocus]);

  const regexInvalid = useMemo(() => {
    if (!useRegex || !query) return false;
    try {
      new RegExp(query);
      return false;
    } catch {
      return true;
    }
  }, [useRegex, query]);

  const hasQuery = query.length > 0;
  const noMatch = hasQuery && !regexInvalid && matchCount === 0;
  const canNavigate = matchCount > 0 && !regexInvalid;
  const replaceEnabled = canNavigate && editable;

  const onQueryKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const onReplaceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.altKey || e.ctrlKey || e.metaKey) onReplaceAll();
      else onReplace();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-label={t("searchReplace.toolbarTitle")}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute right-3 top-3 z-30 flex w-[362px] max-w-[calc(100vw-1.5rem)] flex-col gap-1.5",
        "rounded-xl border border-app-border bg-app-elevated p-2 shadow-[0_1px_2px_rgba(24,24,20,0.05),0_10px_28px_-10px_rgba(24,24,20,0.18)]",
        className,
      )}
    >
      {/* 行1：查询 + 计数 + 导航 │ 替换 / 关闭 */}
      <div className="flex items-center gap-1">
        <div
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border bg-app-surface pl-2 pr-2",
            "transition-[border-color,box-shadow] focus-within:border-accent-primary focus-within:shadow-[0_0_0_3px_rgba(47,111,237,0.06)]",
            regexInvalid || noMatch ? "border-accent-danger" : "border-app-border",
          )}
        >
          <Search size={14} className="shrink-0 text-tx-tertiary" />
          <input
            ref={queryInputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onQueryKeyDown}
            placeholder={t("searchReplace.findPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-tx-primary outline-none placeholder:text-tx-tertiary"
          />
          <span
            className={cn(
              "shrink-0 whitespace-nowrap text-[11.5px] tabular-nums",
              regexInvalid || noMatch ? "font-semibold text-accent-danger" : "text-tx-tertiary",
            )}
          >
            {regexInvalid ? "!" : noMatch ? t("searchReplace.noMatch") : hasQuery ? (
              <>
                <b className="font-semibold text-tx-secondary">{truncated ? `${matchCount}` : activeIndex + 1}</b>
                /{truncated ? `${matchCount}+` : matchCount}
              </>
            ) : null}
          </span>
        </div>
        <IconBtn
          title={t("searchReplace.prev")}
          disabled={!canNavigate}
          onClick={onPrev}
        >
          <ChevronUp size={15} />
        </IconBtn>
        <IconBtn
          title={t("searchReplace.next")}
          disabled={!canNavigate}
          onClick={onNext}
        >
          <ChevronDown size={15} />
        </IconBtn>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-app-border" />
        {editable && (
          <IconBtn
            title={showReplace ? t("searchReplace.hideReplace") : t("searchReplace.showReplace")}
            onClick={onToggleReplace}
            active={showReplace}
          >
            <ArrowLeftRight size={15} />
          </IconBtn>
        )}
        <IconBtn title={t("searchReplace.close")} onClick={onClose}>
          <X size={15} />
        </IconBtn>
      </div>

      {/* 行2：选项开关（字形与 VS Code 一致：Aa / ab / .*） */}
      <div className="flex items-center gap-0.5 px-0.5">
        <GlyphToggle
          label="Aa"
          title={t("searchReplace.caseSensitive")}
          active={caseSensitive}
          onClick={onToggleCaseSensitive}
        />
        <GlyphToggle
          label="ab"
          title={t("searchReplace.wholeWord")}
          active={wholeWord}
          onClick={onToggleWholeWord}
        />
        <GlyphToggle
          label=".*"
          title={t("searchReplace.regex")}
          active={useRegex}
          onClick={onToggleRegex}
        />
        <span className="flex-1" />
        <span className="hidden text-[11px] text-tx-tertiary sm:inline">
          {showReplace ? t("searchReplace.replaceAllHint") : t("searchReplace.nextHint")}
        </span>
      </div>

      {/* 行3：替换（仅展开时） */}
      {editable && showReplace && (
        <div className="flex items-center gap-1">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-app-border bg-app-surface pl-2 pr-2 transition-[border-color,box-shadow] focus-within:border-accent-primary focus-within:shadow-[0_0_0_3px_rgba(47,111,237,0.06)]">
            <ArrowLeftRight size={14} className="shrink-0 text-tx-tertiary" />
            <input
              ref={replaceInputRef}
              type="text"
              value={replaceWith}
              onChange={(e) => onReplaceWithChange(e.target.value)}
              onKeyDown={onReplaceKeyDown}
              placeholder={t("searchReplace.replacePlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-tx-primary outline-none placeholder:text-tx-tertiary"
            />
          </div>
          <button
            type="button"
            onClick={onReplace}
            disabled={!replaceEnabled}
            className="h-7 shrink-0 rounded-lg px-2.5 text-[12.5px] text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
          >
            {t("searchReplace.replace")}
          </button>
          <button
            type="button"
            onClick={onReplaceAll}
            disabled={!replaceEnabled}
            className="h-7 shrink-0 rounded-lg bg-accent-primary px-2.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-35"
          >
            {t("searchReplace.replaceAll")}
          </button>
        </div>
      )}

      {regexInvalid && (
        <p className="px-1 text-[11px] text-accent-danger">{t("searchReplace.regexInvalid")}</p>
      )}
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  active,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors",
        active
          ? "bg-accent-primary/10 text-accent-primary"
          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        "disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

/** 选项开关：用字形表达（Aa / ab / .*），比图标更直观且与编辑器习惯一致 */
function GlyphToggle({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-7 min-w-7 shrink-0 rounded-lg px-1.5 font-mono text-[12px] leading-none transition-colors",
        active
          ? "bg-accent-primary/10 text-accent-primary"
          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
      )}
    >
      {label}
    </button>
  );
}
