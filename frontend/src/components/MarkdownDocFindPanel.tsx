/**
 * MarkdownDocFindPanel —— 把统一浮层 DocFindBar 挂到 CodeMirror 的查找面板上。
 * ----------------------------------------------------------------------------
 * 背景：Markdown 侧原先直接用 `@codemirror/search` 的默认 searchPanel，它是插在
 * 文档流顶部的横条 + 原生 checkbox，与富文本侧的浮窗完全两套样式。这里通过
 * `search({ createPanel })` 换成自定义 Panel：
 *
 *   - panel 容器由主题改成浮层（见 searchPanelTheme 的 .cm-panels 覆盖），正文不位移；
 *   - DOM 里挂一个 React root，渲染与富文本侧完全相同的 DocFindBar；
 *   - 查询/替换/选项写回 CM 的 SearchQuery，命中高亮、滚动、keymap 仍由 CM 负责；
 *   - 命中计数与当前项由本类自己按 Cursor 统计（CM 不暴露这些信息）。
 */
import { createRoot, type Root } from "react-dom/client";
import { EditorView, type Command, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  closeSearchPanel,
  openSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll as cmReplaceAll,
  replaceNext as cmReplaceNext,
  searchPanelOpen,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import i18n from "@/i18n";
import { toast } from "@/lib/toast";
import { DocFindBar } from "./DocFindBar";

/** 命中统计上限：超过后显示 "500+"，避免超大文档卡住面板 */
const MATCH_LIMIT = 500;
/** 打开面板时预填的选区文本长度上限 */
const PREFILL_LIMIT = 100;

/** 模块级标志：openMarkdownFindWithReplace 置位，供下一次面板构造时读取 */
let openWithReplace = false;
/** 当前存活的面板实例（按 view 区分）：面板已打开时 Ctrl+H 直接驱动它，而不是依赖重建 */
const activePanels = new WeakMap<EditorView, MarkdownDocFindPanel>();

/**
 * 打开查找面板并直接进入替换框。
 * 面板已打开时 openSearchPanel 不会重建面板（构造函数不执行、标志不被消费，
 * 会留下脏标志污染下次普通打开），此时直接驱动现有面板展开替换行。
 */
export function openMarkdownFindWithReplace(view: EditorView): boolean {
  if (searchPanelOpen(view.state)) {
    activePanels.get(view)?.enterReplaceMode();
    return true;
  }
  openWithReplace = true;
  return openSearchPanel(view);
}

interface PanelState {
  query: string;
  replaceWith: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  showReplace: boolean;
}

export class MarkdownDocFindPanel implements Panel {
  readonly dom: HTMLDivElement;
  private readonly view: EditorView;
  private readonly root: Root;
  private state: PanelState;
  private matchCount = 0;
  private truncated = false;
  private activeIndex = -1;
  private destroyed = false;
  private mountTimer: number | null = null;
  /** 本次打开是否直接聚焦替换框（由 openMarkdownFindWithReplace 置位） */
  private focusReplace = false;

  constructor(view: EditorView) {
    this.view = view;
    const existing = getSearchQuery(view.state);
    const { from, to } = view.state.selection.main;
    const selected = from < to ? view.state.sliceDoc(from, to) : "";
    // 读取打开标志后立即复位，避免影响下次普通打开
    const withReplace = openWithReplace;
    openWithReplace = false;
    this.focusReplace = withReplace;
    this.state = {
      query: selected && selected.length <= PREFILL_LIMIT ? selected : existing.search,
      replaceWith: existing.replace,
      caseSensitive: existing.caseSensitive,
      wholeWord: existing.wholeWord,
      useRegex: existing.regexp,
      showReplace: withReplace || Boolean(existing.replace),
    };
    this.dom = document.createElement("div");
    this.dom.className = "baseforge-doc-find-panel";
    this.root = createRoot(this.dom);
    activePanels.set(view, this);
    this.recount();
    this.render();
  }

  /**
   * 面板挂载发生在 CM 自己的 update 流程里，此处不能立即 dispatch（会报
   * "update is in progress"）。延后一个宏任务再把预填词写回 CM。
   */
  mount() {
    this.mountTimer = window.setTimeout(() => {
      this.mountTimer = null;
      if (this.destroyed) return;
      this.commit(this.state);
      // 打开即定位第一处命中：否则计数显示 1/N 但选区还停在原位，首点「下一个」
      // 会看起来不推进。
      if (this.matchCount > 0) {
        findNext(this.view);
        this.recount();
      }
      this.render();
    }, 0);
  }

  update(update: ViewUpdate) {
    // 文档或选区变化（含 CM 自带 keymap 的 F3 导航）后刷新计数与当前项
    if (!update.docChanged && !update.selectionSet) return;
    this.recount();
    this.render();
  }

  destroy() {
    this.destroyed = true;
    if (activePanels.get(this.view) === this) activePanels.delete(this.view);
    if (this.mountTimer !== null) {
      window.clearTimeout(this.mountTimer);
      this.mountTimer = null;
    }
    this.root.unmount();
  }

  /** 面板已打开时再次触发 Ctrl+H：展开替换行并聚焦替换框（不重建面板，不产生脏标志） */
  enterReplaceMode() {
    this.focusReplace = true;
    if (this.state.showReplace) {
      // 已展开：DocFindBar 的聚焦 effect 依赖未变化，直接聚焦兜底
      this.render();
      this.dom.querySelector<HTMLInputElement>("input[data-replace-input]")?.focus();
      return;
    }
    // 展开 → DocFindBar 的聚焦 effect 随 showReplace/focusTarget 变化落到替换框
    this.patch({ showReplace: true });
  }

  /** 把状态写回 CM：高亮、选区与后续导航都基于它 */
  private commit(next: PanelState) {
    this.state = next;
    const query = new SearchQuery({
      search: next.query,
      caseSensitive: next.caseSensitive,
      regexp: next.useRegex,
      wholeWord: next.wholeWord,
      replace: next.replaceWith,
    });
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    this.recount();
  }

  private patch(patch: Partial<PanelState>) {
    this.commit({ ...this.state, ...patch });
    this.render();
  }

  private recount() {
    if (!this.state.query) {
      this.matchCount = 0;
      this.truncated = false;
      this.activeIndex = -1;
      return;
    }
    const starts: number[] = [];
    let truncated = false;
    try {
      const cursor = getSearchQuery(this.view.state).getCursor(this.view.state);
      for (let i = 0; i <= MATCH_LIMIT; i += 1) {
        const next = cursor.next();
        if (next.done) break;
        if (i === MATCH_LIMIT) {
          truncated = true;
          break;
        }
        starts.push(next.value.from);
      }
    } catch {
      // 非法正则：CM 在取游标时抛错，降级成「无命中」，错误提示交给 DocFindBar
      this.matchCount = 0;
      this.truncated = false;
      this.activeIndex = -1;
      return;
    }
    this.matchCount = starts.length;
    this.truncated = truncated;
    const selFrom = this.view.state.selection.main.from;
    const index = starts.indexOf(selFrom);
    this.activeIndex = index >= 0 ? index : starts.length > 0 ? 0 : -1;
  }

  private step(command: Command) {
    if (command(this.view)) {
      this.recount();
      this.render();
    }
  }

  private replaceCurrent() {
    if (cmReplaceNext(this.view)) {
      this.recount();
      this.render();
    }
  }

  private replaceEvery() {
    const replaced = this.matchCount;
    if (!cmReplaceAll(this.view)) return;
    if (replaced > 0) {
      toast.success(i18n.t("searchReplace.replacedCount", { count: replaced }));
    }
    this.recount();
    this.render();
  }

  private render() {
    if (this.destroyed) return;
    const editable = this.view.state.facet(EditorView.editable);
    this.root.render(
      <DocFindBar
        query={this.state.query}
        onQueryChange={(value) => this.patch({ query: value })}
        replaceWith={this.state.replaceWith}
        onReplaceWithChange={(value) => this.patch({ replaceWith: value })}
        matchCount={this.matchCount}
        activeIndex={this.activeIndex}
        caseSensitive={this.state.caseSensitive}
        wholeWord={this.state.wholeWord}
        useRegex={this.state.useRegex}
        onToggleCaseSensitive={() => this.patch({ caseSensitive: !this.state.caseSensitive })}
        onToggleWholeWord={() => this.patch({ wholeWord: !this.state.wholeWord })}
        onToggleRegex={() => this.patch({ useRegex: !this.state.useRegex })}
        showReplace={this.state.showReplace}
        onToggleReplace={() => this.patch({ showReplace: !this.state.showReplace })}
        onNext={() => this.step(findNext)}
        onPrev={() => this.step(findPrevious)}
        onReplace={this.replaceCurrent}
        onReplaceAll={this.replaceEvery}
        onClose={() => closeSearchPanel(this.view)}
        editable={editable}
        truncated={this.truncated}
        focusTarget={this.focusReplace ? "replace" : "query"}
      />
    );
  }
}

/** `search({ createPanel })` 的工厂 */
export function createMarkdownFindPanel(view: EditorView): Panel {
  return new MarkdownDocFindPanel(view);
}
