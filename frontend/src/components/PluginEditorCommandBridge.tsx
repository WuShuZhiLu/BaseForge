import { useCallback, useEffect } from "react";

import { useApp } from "@/store/AppContext";
import { PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, pluginApi } from "@/lib/pluginApi";
import {
  clearPluginEditorCommands,
  editorCommandMatchesContext,
  executePluginEditorCommand,
  keybindingMatchesEvent,
  listPluginEditorCommandsWithKeybinding,
  primePluginActionInputs,
  replacePluginEditorCommands,
} from "@/lib/pluginEditorCommands";
import { isImeKeyEvent } from "@/lib/ime";
import { detectShortcutPlatform } from "@/lib/shortcutRegistry";
import { toast } from "@/lib/toast";

/**
 * 宿主里"编辑器已获得焦点"的判定：Tiptap / CodeMirror / 其他自研编辑根节点。
 * 与 shortcutRegistry 的 editor scope 判定保持一致。
 */
const EDITOR_SELECTOR = ".ProseMirror, .cm-editor, [data-editor-root]";

function isEditorTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || !!target.closest(EDITOR_SELECTOR);
}

/**
 * 插件编辑器命令宿主桥：
 * 1. 拉取已启用插件的 `contributes.editorCommands` 并全量替换注册表（停用/卸载即注销）；
 * 2. 在捕获阶段拦截快捷键，命中后走既有插件 Action 通道执行。
 *
 * 斜杠菜单的接入点不在这里，而是 `getDefaultSlashCommands` 读取同一个注册表。
 */
export default function PluginEditorCommandBridge() {
  const { state } = useApp();

  const load = useCallback(async () => {
    try {
      const [contributions, actions] = await Promise.all([
        pluginApi.contributions(),
        pluginApi.actions().catch(() => []),
      ]);
      primePluginActionInputs(actions);
      replacePluginEditorCommands(contributions);
    } catch {
      clearPluginEditorCommands();
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, load);
    return () => {
      window.removeEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, load);
      clearPluginEditorCommands();
    };
  }, [load]);

  const noteId = state.activeNote?.id ?? null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeKeyEvent(event)) return;
      const commands = listPluginEditorCommandsWithKeybinding();
      if (commands.length === 0) return;
      const platform = detectShortcutPlatform();
      const context = { editorFocused: isEditorTarget(event.target), noteOpen: !!noteId };
      for (const command of commands) {
        if (!command.chord) continue;
        if (!editorCommandMatchesContext(command, context)) continue;
        if (!keybindingMatchesEvent(command.chord, event, platform)) continue;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void executePluginEditorCommand(command, { noteId }).catch((error: unknown) => {
          toast.error(`插件命令执行失败：${error instanceof Error ? error.message : String(error)}`);
        });
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [noteId]);

  return null;
}
