import { Extension } from "@tiptap/core";
import { Plugin, type PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
  getActiveEditorRuntimeDecision,
  subscribeEditorRuntime,
} from "@/lib/editorRuntimeStore";
import { isSearchNavigationUpdate } from "@/lib/searchMatchScroll";
import {
  SearchReplacePanel,
  searchReplacePluginKey,
} from "./SearchReplacePanel";

export { SearchReplacePanel, searchReplacePluginKey };

interface SearchMatch {
  from: number;
  to: number;
}

export interface RuntimeSearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  activeIndex: number;
  matches: SearchMatch[];
  deco: DecorationSet;
  stale: boolean;
  truncated: boolean;
}

const runtimeSearchPluginKey = searchReplacePluginKey as unknown as PluginKey<RuntimeSearchState>;

const emptyState: RuntimeSearchState = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  activeIndex: -1,
  matches: [],
  deco: DecorationSet.empty,
  stale: false,
  truncated: false,
};

const LIGHTWEIGHT_MATCH_LIMIT = 500;

function buildRegex(options: Pick<RuntimeSearchState, "query" | "caseSensitive" | "wholeWord" | "useRegex">): RegExp | null {
  if (!options.query) return null;
  let pattern = options.useRegex
    ? options.query
    : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.wholeWord) pattern = `\\b${pattern}\\b`;
  try {
    return new RegExp(pattern, options.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

function findMatches(doc: any, regex: RegExp, limit: number): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  let truncated = false;
  doc.descendants((node: any, pos: number) => {
    if (truncated || !node.isText) return !truncated;
    const text: string = node.text || "";
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      if (match.index === regex.lastIndex) {
        regex.lastIndex += 1;
        continue;
      }
      matches.push({ from: pos + match.index, to: pos + match.index + match[0].length });
      if (matches.length >= limit) {
        truncated = true;
        return false;
      }
    }
    return true;
  });
  return { matches, truncated };
}

function realtimeDecorationsEnabled(): boolean {
  return getActiveEditorRuntimeDecision().capabilities.realtimeDecorations;
}

function buildDecoSet(doc: any, matches: SearchMatch[], activeIndex: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const realtime = realtimeDecorationsEnabled();
  const visibleMatches = realtime
    ? matches.map((match, index) => ({ match, index }))
    : activeIndex >= 0 && matches[activeIndex]
      ? [{ match: matches[activeIndex], index: activeIndex }]
      : [];
  if (visibleMatches.length === 0) return DecorationSet.empty;
  return DecorationSet.create(doc, visibleMatches.map(({ match, index }) => (
    Decoration.inline(match.from, match.to, {
      class: index === activeIndex ? "search-match search-match-active" : "search-match",
    })
  )));
}

function scan(doc: any, state: RuntimeSearchState): Pick<RuntimeSearchState, "matches" | "activeIndex" | "deco" | "stale" | "truncated"> {
  const regex = buildRegex(state);
  if (!regex) {
    return {
      matches: [],
      activeIndex: -1,
      deco: DecorationSet.empty,
      stale: false,
      truncated: false,
    };
  }
  const limit = realtimeDecorationsEnabled() ? Number.POSITIVE_INFINITY : LIGHTWEIGHT_MATCH_LIMIT;
  const result = findMatches(doc, regex, limit);
  const activeIndex = result.matches.length === 0
    ? -1
    : Math.max(0, Math.min(state.activeIndex < 0 ? 0 : state.activeIndex, result.matches.length - 1));
  return {
    matches: result.matches,
    activeIndex,
    deco: buildDecoSet(doc, result.matches, activeIndex),
    stale: false,
    truncated: result.truncated,
  };
}

function mapMatches(tr: any, matches: SearchMatch[]): SearchMatch[] {
  const max = tr.doc.content.size;
  const mapped: SearchMatch[] = [];
  for (const match of matches) {
    const from = tr.mapping.mapResult(match.from, 1);
    const to = tr.mapping.mapResult(match.to, -1);
    if (from.deletedAcross || to.deletedAcross) continue;
    if (from.pos < 0 || to.pos > max || from.pos >= to.pos) continue;
    mapped.push({ from: from.pos, to: to.pos });
  }
  return mapped;
}

/**
 * Runtime-aware search extension.
 *
 * Normal/viewport modes preserve the existing exact behavior. Lightweight mode performs a bounded
 * scan only when the user changes the query/options, paints only the active match, and maps existing
 * positions while the document changes instead of synchronously traversing the whole document on
 * every keystroke.
 */
export function createSearchReplaceExtension() {
  return Extension.create({
    name: "searchReplace",
    addProseMirrorPlugins() {
      return [
        new Plugin<RuntimeSearchState>({
          key: runtimeSearchPluginKey,
          state: {
            init: () => emptyState,
            apply(tr, previous) {
              const meta = tr.getMeta(runtimeSearchPluginKey) as Record<string, unknown> | undefined;
              if (meta) {
                if (meta.runtimeRefresh === true) {
                  return {
                    ...previous,
                    deco: buildDecoSet(tr.doc, previous.matches, previous.activeIndex),
                  };
                }
                if (isSearchNavigationUpdate(meta)) {
                  const activeIndex = previous.matches.length === 0
                    ? -1
                    : Math.max(-1, Math.min(Number(meta.activeIndex), previous.matches.length - 1));
                  return {
                    ...previous,
                    activeIndex,
                    deco: buildDecoSet(tr.doc, previous.matches, activeIndex),
                  };
                }
                const next = { ...previous, ...meta } as RuntimeSearchState;
                const scanned = scan(tr.doc, next);
                const requestedIndex = typeof meta.activeIndex === "number"
                  ? Math.max(-1, Math.min(meta.activeIndex, scanned.matches.length - 1))
                  : scanned.activeIndex;
                return {
                  ...next,
                  ...scanned,
                  activeIndex: requestedIndex,
                  deco: buildDecoSet(tr.doc, scanned.matches, requestedIndex),
                };
              }

              if (tr.docChanged && previous.query) {
                // 为什么防抖：实时模式下大文档连续输入若逐事务全文扫描（scan）会卡顿。
                // apply 必须保持纯函数，不能在这里起定时器：这里只把已有命中用映射平移并标记 stale，
                // 由 view() 里的防抖定时器在停顿约 200ms 后统一安排一次全量扫描。
                const matches = mapMatches(tr, previous.matches);
                const activeIndex = matches.length === 0
                  ? -1
                  : Math.min(previous.activeIndex < 0 ? 0 : previous.activeIndex, matches.length - 1);
                return {
                  ...previous,
                  matches,
                  activeIndex,
                  stale: true,
                  deco: buildDecoSet(tr.doc, matches, activeIndex),
                };
              }

              return {
                ...previous,
                deco: previous.deco.map(tr.mapping, tr.doc),
              };
            },
          },
          props: {
            decorations(state) {
              return runtimeSearchPluginKey.getState(state)?.deco || null;
            },
          },
          view(view) {
            const unsubscribe = subscribeEditorRuntime(() => {
              if (view.isDestroyed) return;
              view.dispatch(view.state.tr.setMeta(runtimeSearchPluginKey, { runtimeRefresh: true }));
            });
            let rescanTimer: ReturnType<typeof setTimeout> | null = null;
            // 定时器句柄放在 view 闭包里（插件 state 不可变，不能存进去）；
            // 停顿期内每来一个新的文档变更事务就重置定时器，只在停顿约 200ms 后合并扫描一次。
            const scheduleRescan = () => {
              if (rescanTimer !== null) clearTimeout(rescanTimer);
              rescanTimer = setTimeout(() => {
                rescanTimer = null;
                if (view.isDestroyed) return;
                const state = runtimeSearchPluginKey.getState(view.state);
                if (!state?.stale || !state.query) return;
                view.dispatch(view.state.tr.setMeta(runtimeSearchPluginKey, {
                  query: state.query,
                  caseSensitive: state.caseSensitive,
                  wholeWord: state.wholeWord,
                  useRegex: state.useRegex,
                }));
              }, 200);
            };
            return {
              update(currentView, prevState) {
                if (currentView.state.doc === prevState.doc) return;
                const state = runtimeSearchPluginKey.getState(currentView.state);
                if (!state?.stale) {
                  if (rescanTimer !== null) {
                    clearTimeout(rescanTimer);
                    rescanTimer = null;
                  }
                  return;
                }
                // 轻量模式不安排全量重扫，保持原行为
                if (!realtimeDecorationsEnabled()) return;
                scheduleRescan();
              },
              destroy() {
                if (rescanTimer !== null) {
                  clearTimeout(rescanTimer);
                  rescanTimer = null;
                }
                unsubscribe();
              },
            };
          },
        }),
      ];
    },
  });
}
