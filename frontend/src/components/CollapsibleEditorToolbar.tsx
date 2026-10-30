import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export const EDITOR_TOOLBAR_COLLAPSED_KEY = "nowen.editor.toolbarCollapsed.v1";
const CHANGED_EVENT = "nowen:editor-toolbar-collapsed-changed";
let memoryCollapsed = false;

/** 与 Tailwind 的 md 断点保持一致：只有桌面端才把工具栏交出去。 */
const DESKTOP_TOOLBAR_MEDIA_QUERY = "(min-width: 768px)";

interface ToolbarHostValue {
  /** 实际生效的落点：header（分屏全宽行）优先于 tabs（页签行内的空位）。 */
  target: HTMLSpanElement | null;
  /** 登记落点元素；同一位置重复登记同一个元素会直接忽略，避免 ref 回调自我循环。 */
  registerSlot: (location: "tabs" | "header", element: HTMLSpanElement | null) => void;
  mobileLeadingTarget: HTMLSpanElement | null;
  setMobileLeadingTarget: (target: HTMLSpanElement | null) => void;
  mobileTrailingTarget: HTMLSpanElement | null;
  setMobileTrailingTarget: (target: HTMLSpanElement | null) => void;
  /** 认领唯一的工具栏宿主：返回 token = 认领成功，null = 已被别的编辑器实例占用。 */
  claimSlot: () => object | null;
  /** 归还认领；只有 token 匹配（仍是自己）时才真正释放。 */
  releaseSlot: (token: object) => void;
}

const ToolbarHostContext = createContext<ToolbarHostValue | null>(null);

/**
 * 工具栏宿主：分屏时把“唯一的桌面格式工具栏”放到全宽位置。
 *
 * 一个宿主只接受**一个**编辑器实例接管（先认领者得）。分屏参考栏整棵子树用
 * `EditorToolbarDetached` 包住 → 它读不到宿主上下文，永远不会认领，
 * 所以宿主里不会同时出现两套工具栏。
 *
 * 落点可以有多处（页签行内的旧空位 + 分屏的全宽行），header 优先。
 */
export function EditorToolbarHost({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState<{
    tabs: HTMLSpanElement | null;
    header: HTMLSpanElement | null;
  }>({ tabs: null, header: null });
  const [mobileLeadingTarget, setMobileLeadingTarget] = useState<HTMLSpanElement | null>(null);
  const [mobileTrailingTarget, setMobileTrailingTarget] = useState<HTMLSpanElement | null>(null);
  const claimantRef = useRef<object | null>(null);
  const registerSlot = useCallback((location: "tabs" | "header", element: HTMLSpanElement | null) => {
    // 同一个元素重复登记时原样返回旧 state：ref 回调不会因此进入无限重渲染。
    setSlots((previous) => (previous[location] === element ? previous : { ...previous, [location]: element }));
  }, []);
  const claimSlot = useCallback(() => {
    if (claimantRef.current) return null;
    const token = {};
    claimantRef.current = token;
    return token;
  }, []);
  const releaseSlot = useCallback((token: object) => {
    if (claimantRef.current === token) claimantRef.current = null;
  }, []);
  const target = slots.header ?? slots.tabs;
  const value = useMemo(
    () => ({
      target,
      registerSlot,
      mobileLeadingTarget,
      setMobileLeadingTarget,
      mobileTrailingTarget,
      setMobileTrailingTarget,
      claimSlot,
      releaseSlot,
    }),
    [target, registerSlot, mobileLeadingTarget, mobileTrailingTarget, claimSlot, releaseSlot],
  );
  return <ToolbarHostContext.Provider value={value}>{children}</ToolbarHostContext.Provider>;
}

/**
 * 显式声明“本子树不接管工具栏宿主”：参考栏用它把宿主上下文切断，
 * 栏内编辑器于是就地渲染自己的工具栏（再由宿主侧样式在桌面隐藏），不会和主栏抢位置。
 * 不产生任何 DOM 包裹层，可以直接塞进 flex 布局里。
 */
export function EditorToolbarDetached({ children }: { children: ReactNode }) {
  return <ToolbarHostContext.Provider value={null}>{children}</ToolbarHostContext.Provider>;
}

function useDesktopViewport(): boolean {
  const [desktop, setDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP_TOOLBAR_MEDIA_QUERY).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_TOOLBAR_MEDIA_QUERY);
    const sync = () => setDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return desktop;
}

/**
 * 编辑器侧取“桌面工具栏落点”：返回宿主内的 span 就 portal 过去，返回 null 就地渲染。
 *
 * 三种 null 情形：
 *  1. 没有宿主（普通单栏编辑、分屏参考栏）；
 *  2. 宿主已被别的编辑器实例认领（唯一接管）；
 *  3. 视口 < 768px —— 移动端 compact 工具栏与它的“更多”展开行必须留在编辑器内，
 *     而宿主落点是 `hidden md:flex`，交出去会让手机上工具栏消失。
 */
export function useEditorToolbarSlot(): HTMLSpanElement | null {
  const host = useContext(ToolbarHostContext);
  const desktop = useDesktopViewport();
  const claimSlot = host?.claimSlot;
  const releaseSlot = host?.releaseSlot;
  const [token, setToken] = useState<object | null>(null);

  // 认领放在 layout effect：首帧就把工具栏搬到宿主，不会先画一份再跳走。
  useLayoutEffect(() => {
    if (!claimSlot || !releaseSlot || !desktop) {
      setToken(null);
      return;
    }
    const claimed = claimSlot();
    setToken(claimed);
    return () => {
      if (!claimed) return;
      releaseSlot(claimed);
      setToken(null);
    };
  }, [claimSlot, releaseSlot, desktop]);

  if (!host || !desktop || !token) return null;
  return host.target;
}

/** 有落点就 portal 过去，没有就原地渲染（Fragment 不产生 DOM）。 */
export function EditorToolbarPortal({
  target,
  children,
}: {
  target: HTMLElement | null;
  children: ReactNode;
}) {
  return target ? <>{createPortal(children, target)}</> : <>{children}</>;
}

export function EditorToolbarExpandSlot({
  location,
  className,
}: {
  location: "tabs" | "header";
  className?: string;
}) {
  const host = useContext(ToolbarHostContext);
  // 只用稳定的 registerSlot 组 ref 回调：依赖 host 对象会让回调每次渲染都换身份，
  // ref 反复 detach/attach → registerSlot(null)/registerSlot(el) 抖成无限重渲染。
  const registerSlot = host?.registerSlot;
  const setRef = useCallback(
    (element: HTMLSpanElement | null) => {
      registerSlot?.(location, element);
    },
    [registerSlot, location],
  );
  if (!host) return null;
  return (
    <span
      ref={setRef}
      data-editor-toolbar-expand-slot={location}
      className={cn("hidden shrink-0 items-center empty:hidden md:flex md:empty:hidden", className)}
    />
  );
}


export function MobileEditorToolbarSlot({ location }: { location: "leading" | "trailing" }) {
  const host = useContext(ToolbarHostContext);
  if (!host) return null;
  return (
    <span
      ref={location === "leading" ? host.setMobileLeadingTarget : host.setMobileTrailingTarget}
      data-mobile-editor-toolbar-slot={location}
      className="flex shrink-0 items-center empty:hidden md:hidden"
    />
  );
}

export function MobileEditorToolbarPortal({
  location,
  children,
}: {
  location: "leading" | "trailing";
  children: ReactNode;
}) {
  const host = useContext(ToolbarHostContext);
  const target = location === "leading" ? host?.mobileLeadingTarget : host?.mobileTrailingTarget;
  return target ? createPortal(children, target) : null;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(EDITOR_TOOLBAR_COLLAPSED_KEY) === "true";
  } catch {
    return memoryCollapsed;
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === EDITOR_TOOLBAR_COLLAPSED_KEY || event.key === null) onChange();
  };
  window.addEventListener(CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export default function CollapsibleEditorToolbar({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const controlsId = useId();
  const host = useContext(ToolbarHostContext);
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, () => false);
  const label = t(collapsed ? "tiptap.expandToolbar" : "tiptap.collapseToolbar");

  const toggle = () => {
    memoryCollapsed = !collapsed;
    try {
      window.localStorage.setItem(EDITOR_TOOLBAR_COLLAPSED_KEY, String(memoryCollapsed));
    } catch {
      // Keep the choice usable when this browser cannot persist preferences.
    }
    window.dispatchEvent(new Event(CHANGED_EVENT));
  };

  const toggleButton = (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls={controlsId}
      title={label}
      className={cn(
        "hidden h-6 w-6 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover hover:text-tx-primary md:flex",
        (!collapsed || !host?.target) && "absolute right-1 top-1 z-40 bg-app-surface/95",
      )}
    >
      {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
    </button>
  );

  return (
    <div
      data-editor-toolbar-collapsed={collapsed ? "true" : "false"}
      className={cn("relative shrink-0 md:sticky md:top-0 md:z-20", collapsed && "md:h-0")}
    >
      {collapsed && host?.target ? createPortal(toggleButton, host.target) : toggleButton}
      <div id={controlsId} className={collapsed ? "md:hidden" : undefined}>
        {children}
      </div>
    </div>
  );
}
