import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  FileText,
  FileUp,
  FolderUp,
  Loader2,
  MessageCircleQuestion,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  Upload,
  User,
  Wand2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, resolveAttachmentUrl } from "@/lib/api";
import type { ToolPageHeaderMode } from "@/lib/toolPage";

/** 页签契约：页面自带标题行（AI 对话头部），宿主顶栏无需重复渲染。 */
export const TOOL_PAGE_HEADER_MODE: ToolPageHeaderMode = "own";

import { withAbortableAiFetch } from "@/lib/abortableAiAsk";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/store/AppContext";
import AIKnowledgeScopePicker from "@/components/AIKnowledgeScopePicker";
import PluginPromptPicker from "@/components/PluginPromptPicker";

interface ChatReference {
  id: string;
  title: string;
  kind?: "note" | "attachment";
  attachmentId?: string;
  attachmentFilename?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  references?: ChatReference[];
  isStreaming?: boolean;
  stopped?: boolean;
  createdAt?: string;
}

interface KnowledgeStats {
  noteCount: number;
  ftsCount: number;
  notebookCount: number;
  tagCount: number;
  recentTopics: string[];
  indexed: boolean;
}

interface ConversationSummary {
  id: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: string | null;
  lastRole: string | null;
}

const HISTORY_LIMIT = 100;
const deriveTitleFromQuestion = (question: string) => question.trim().replace(/\s+/g, " ").slice(0, 20);

function formatMessageTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function mapHistoryMessage(message: {
  id: string;
  role: "user" | "assistant";
  content: string;
  references?: ChatReference[];
  createdAt: string;
}): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    references: message.references,
    createdAt: message.createdAt,
  };
}

const aiChatMarkdownComponents: Components = {
  pre: ({ children }) => (
    <pre className="my-2 max-w-full overflow-x-auto rounded-[8px] border border-app-border bg-app-bg p-3">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className="my-0 w-max min-w-full border-collapse text-xs">
        {children}
      </table>
    </div>
  ),
};

export default function AIChatPanel({ onClose, onNavigateToNote }: {
  onClose: () => void;
  onNavigateToNote?: (noteId: string) => void;
}) {
  const { t } = useTranslation();
  const { state: appState } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [expandedReferenceIds, setExpandedReferenceIds] = useState<Set<string>>(() => new Set());
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [nbScope, setNbScope] = useState<"all" | "notebook">("all");
  const [nbScopeId, setNbScopeId] = useState("");
  const [nbIncludeChildren, setNbIncludeChildren] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  useEffect(() => {
    const reload = () => api.getKnowledgeStats().then(setStats).catch(() => {});
    reload();
    window.addEventListener("nowen:workspace-changed", reload);
    return () => window.removeEventListener("nowen:workspace-changed", reload);
  }, []);

  const reloadConversations = useCallback(async (): Promise<ConversationSummary[]> => {
    try {
      const result = await api.aiConversations.list();
      setConversations(result.conversations);
      return result.conversations;
    } catch {
      setConversations([]);
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await reloadConversations();
      if (cancelled) return;
      const targetId = list[0]?.id || null;
      setCurrentConvId(targetId);
      if (!targetId) {
        setHistoryLoading(false);
        return;
      }
      try {
        const result = await api.getAiChatHistory(HISTORY_LIMIT, targetId);
        if (!cancelled) setMessages(result.messages.map(mapHistoryMessage));
      } catch {
        // Opening chat must still work when history is temporarily unavailable.
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadConversations]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => scrollToBottom(), [messages, scrollToBottom]);

  const handleSelectConversation = useCallback(async (conversationId: string) => {
    if (isLoading || conversationId === currentConvId) return;
    setCurrentConvId(conversationId);
    setMessages([]);
    setHistoryLoading(true);
    try {
      const result = await api.getAiChatHistory(HISTORY_LIMIT, conversationId);
      setMessages(result.messages.map(mapHistoryMessage));
    } catch {
      // Keep the selected conversation open and allow a retry by switching back.
    } finally {
      setHistoryLoading(false);
    }
  }, [currentConvId, isLoading]);

  const notifyConversationsChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent("nowen:ai-conversations-changed"));
  }, []);

  const handleNewConversation = useCallback(async () => {
    if (isLoading) return;
    try {
      const result = await api.aiConversations.create();
      setConversations((previous) => [result.conversation, ...previous]);
      setCurrentConvId(result.conversation.id);
      setMessages([]);
      notifyConversationsChanged();
    } catch {
      setCurrentConvId(null);
      setMessages([]);
    }
  }, [isLoading, notifyConversationsChanged]);

  // 侧栏会话行点击 → 加载对应会话（复用 handleSelectConversation）。
  useEffect(() => {
    const handleOpenConversation = (event: Event) => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      if (conversationId) void handleSelectConversation(conversationId);
    };
    window.addEventListener("nowen:ai-open-conversation", handleOpenConversation);
    return () => window.removeEventListener("nowen:ai-open-conversation", handleOpenConversation);
  }, [handleSelectConversation]);

  // 侧栏新建会话 → 刷新本区会话列表（标题展示依赖 conversations）。
  useEffect(() => {
    window.addEventListener("nowen:ai-conversations-changed", reloadConversations);
    return () => window.removeEventListener("nowen:ai-conversations-changed", reloadConversations);
  }, [reloadConversations]);

  // 选中态同步给侧栏（侧栏据此高亮当前会话行）。
  useEffect(() => {
    if (!currentConvId) return;
    window.dispatchEvent(new CustomEvent("nowen:ai-conversation-selected", { detail: { conversationId: currentConvId } }));
  }, [currentConvId]);

  const persistConversationSnapshot = useCallback(async (nextMessages: ChatMessage[]) => {
    if (!currentConvId) return;
    try {
      await api.clearAiChatHistory(currentConvId);
      for (const message of nextMessages) {
        if (message.isStreaming || !message.content.trim()) continue;
        await api.appendAiChatHistory({
          id: message.id,
          conversationId: currentConvId,
          role: message.role,
          content: message.content,
          references: message.references,
        });
      }
      await reloadConversations();
      notifyConversationsChanged();
    } catch {
      // Local editing remains usable offline; reopening the conversation will reconcile it.
    }
  }, [currentConvId, notifyConversationsChanged, reloadConversations]);

  const handleStopGeneration = useCallback(() => {
    if (!isLoading) return;
    stopRequestedRef.current = true;
    abortControllerRef.current?.abort();
  }, [isLoading]);

  const streamAssistantReply = useCallback(async (args: {
    question: string;
    history: { role: string; content: string }[];
    assistantMessage: ChatMessage;
    conversationId: string | null;
    baseMessages: ChatMessage[];
    replaceHistory?: boolean;
  }) => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    stopRequestedRef.current = false;
    let finalContent = "";
    let finalReferences: ChatReference[] | undefined;
    let stopped = false;

    try {
      await withAbortableAiFetch(controller, () => api.aiAsk(
        args.question,
        args.history,
        (chunk) => {
          finalContent += chunk;
          setMessages((previous) => previous.map((message) =>
            message.id === args.assistantMessage.id
              ? { ...message, content: message.content + chunk }
              : message
          ));
        },
        (references) => {
          finalReferences = references;
          setMessages((previous) => previous.map((message) =>
            message.id === args.assistantMessage.id
              ? { ...message, references }
              : message
          ));
        },
        nbScope === "notebook" ? {
          notebookId: nbScopeId,
          includeChildren: nbIncludeChildren,
        } : undefined,
      ));
    } catch (error: any) {
      stopped = stopRequestedRef.current || controller.signal.aborted || error?.name === "AbortError";
      if (!stopped) {
        finalContent = error?.message || t("ai.requestFailed");
        setMessages((previous) => previous.map((message) =>
          message.id === args.assistantMessage.id
            ? { ...message, content: finalContent }
            : message
        ));
      }
    } finally {
      const completed: ChatMessage = {
        ...args.assistantMessage,
        content: finalContent,
        references: finalReferences,
        isStreaming: false,
        stopped,
      };
      setMessages((previous) => previous.map((message) =>
        message.id === args.assistantMessage.id ? completed : message
      ));
      setIsLoading(false);
      stopRequestedRef.current = false;
      if (abortControllerRef.current === controller) abortControllerRef.current = null;

      if (args.replaceHistory) {
        const snapshot = args.baseMessages.map((message) =>
          message.id === completed.id ? completed : message
        );
        await persistConversationSnapshot(snapshot);
      } else if (finalContent.trim()) {
        api.appendAiChatHistory({
          id: completed.id,
          conversationId: args.conversationId || undefined,
          role: "assistant",
          content: finalContent,
          references: finalReferences,
        }).catch(() => {});
      }
      reloadConversations().catch(() => {});
      notifyConversationsChanged();
    }
  }, [nbIncludeChildren, nbScope, nbScopeId, notifyConversationsChanged, persistConversationSnapshot, reloadConversations, t]);

  const handleSend = useCallback(async (override?: string) => {
    const question = (override ?? input).trim();
    if (!question || isLoading) return;

    let conversationId = currentConvId;
    if (!conversationId) {
      try {
        const result = await api.aiConversations.create();
        conversationId = result.conversation.id;
        setConversations((previous) => [result.conversation, ...previous]);
        setCurrentConvId(conversationId);
        notifyConversationsChanged();
      } catch {
        // Old backends create a default conversation when history is appended.
      }
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: question,
      createdAt: now,
    };
    const assistantMessage: ChatMessage = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
      isStreaming: true,
      createdAt: now,
    };
    const baseMessages = [...messages, userMessage, assistantMessage];
    const history = messages
      .filter((message) => !message.isStreaming)
      .map((message) => ({ role: message.role, content: message.content }));

    setMessages(baseMessages);
    setInput("");
    setIsLoading(true);

    api.appendAiChatHistory({
      id: userMessage.id,
      conversationId: conversationId || undefined,
      role: "user",
      content: question,
    }).catch(() => {});

    if (conversationId) {
      const conversation = conversations.find((item) => item.id === conversationId);
      if (conversation && !conversation.title) {
        const title = deriveTitleFromQuestion(question);
        if (title) {
          api.aiConversations.update(conversationId, { title }).catch(() => {});
          setConversations((previous) => previous.map((item) =>
            item.id === conversationId ? { ...item, title } : item
          ));
          notifyConversationsChanged();
        }
      }
    }

    await streamAssistantReply({
      question,
      history,
      assistantMessage,
      conversationId,
      baseMessages,
    });
  }, [conversations, currentConvId, input, isLoading, messages, notifyConversationsChanged, streamAssistantReply]);

  const handleRegenerate = useCallback(async (assistantId: string) => {
    if (isLoading) return;
    const assistantIndex = messages.findIndex((message) => message.id === assistantId && message.role === "assistant");
    if (assistantIndex < 0) return;
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && messages[userIndex].role !== "user") userIndex -= 1;
    if (userIndex < 0) return;

    const question = messages[userIndex].content;
    const assistantMessage: ChatMessage = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
      isStreaming: true,
      createdAt: new Date().toISOString(),
    };
    const baseMessages = [...messages.slice(0, assistantIndex), assistantMessage];
    const history = messages
      .slice(0, userIndex)
      .filter((message) => !message.isStreaming)
      .map((message) => ({ role: message.role, content: message.content }));

    setMessages(baseMessages);
    setIsLoading(true);
    await streamAssistantReply({
      question,
      history,
      assistantMessage,
      conversationId: currentConvId,
      baseMessages,
      replaceHistory: true,
    });
  }, [currentConvId, isLoading, messages, streamAssistantReply]);

  const handleCopyMessage = useCallback(async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1500);
    } catch {
      // Clipboard permission may be denied in an embedded WebView.
    }
  }, []);

  const handleStartEditMessage = (message: ChatMessage) => {
    setEditingMessageId(message.id);
    setEditDraft(message.content);
  };

  const handleSaveMessageEdit = useCallback(async (messageId: string) => {
    const content = editDraft.trim();
    if (!content) return;
    const nextMessages = messages.map((message) =>
      message.id === messageId ? { ...message, content } : message
    );
    setMessages(nextMessages);
    setEditingMessageId(null);
    setEditDraft("");
    await persistConversationSnapshot(nextMessages);
  }, [editDraft, messages, persistConversationSnapshot]);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    if (isLoading) return;
    const nextMessages = messages.filter((message) => message.id !== messageId);
    setMessages(nextMessages);
    if (editingMessageId === messageId) {
      setEditingMessageId(null);
      setEditDraft("");
    }
    await persistConversationSnapshot(nextMessages);
  }, [editingMessageId, isLoading, messages, persistConversationSnapshot]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const clearChat = () => {
    setMessages([]);
    if (currentConvId) {
      api.clearAiChatHistory(currentConvId).catch(() => {});
      setConversations((previous) => previous.map((conversation) =>
        conversation.id === currentConvId
          ? { ...conversation, messageCount: 0, lastMessage: null, lastRole: null }
          : conversation
      ));
      notifyConversationsChanged();
    } else {
      api.clearAiChatHistory().catch(() => {});
    }
  };

  const [docParsing, setDocParsing] = useState(false);
  const [docResult, setDocResult] = useState<string | null>(null);
  const [docFileName, setDocFileName] = useState("");
  const docInputRef = useRef<HTMLInputElement>(null);

  const doParseDocument = useCallback(async (file: File) => {
    setDocParsing(true);
    setDocFileName(file.name);
    setDocResult(null);
    try {
      const result = await api.parseDocument(file, { formatMode: "note" });
      setDocResult(result.markdown);
    } catch (error: any) {
      setDocResult(`❌ ${error.message}`);
    } finally {
      setDocParsing(false);
      if (docInputRef.current) docInputRef.current.value = "";
    }
  }, []);

  const handleDocUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void doParseDocument(file);
  }, [doParseDocument]);

  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const doKnowledgeImport = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setImportLoading(true);
    setImportResult(null);
    try {
      const result = await api.importToKnowledge(files);
      setImportResult(t("aiChat.importSuccess", { success: result.success, failed: result.failed }));
      api.getKnowledgeStats().then(setStats).catch(() => {});
    } catch (error: any) {
      setImportResult(`❌ ${error.message}`);
    } finally {
      setImportLoading(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }, [t]);

  const handleKnowledgeImport = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files?.length) void doKnowledgeImport(Array.from(files));
  }, [doKnowledgeImport]);

  const [docDragOver, setDocDragOver] = useState(false);
  const docDragCounter = useRef(0);
  const [importDragOver, setImportDragOver] = useState(false);
  const importDragCounter = useRef(0);

  const filterByExt = useCallback((files: File[], accept: string): File[] => {
    const extensions = accept.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    return files.filter((file) => extensions.some((extension) => file.name.toLowerCase().endsWith(extension)));
  }, []);

  const makeDropHandlers = useCallback((
    setOver: (value: boolean) => void,
    counterRef: React.MutableRefObject<number>,
    onFiles: (files: File[]) => void,
    accept: string,
  ) => ({
    onDragEnter: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      counterRef.current += 1;
      setOver(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: () => {
      counterRef.current -= 1;
      if (counterRef.current <= 0) {
        counterRef.current = 0;
        setOver(false);
      }
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      counterRef.current = 0;
      setOver(false);
      const files = filterByExt(Array.from(event.dataTransfer.files || []), accept);
      if (files.length) onFiles(files);
    },
  }), [filterByExt]);

  const docDropHandlers = makeDropHandlers(
    setDocDragOver,
    docDragCounter,
    (files) => { if (files[0]) void doParseDocument(files[0]); },
    ".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm",
  );
  const importDropHandlers = makeDropHandlers(
    setImportDragOver,
    importDragCounter,
    (files) => void doKnowledgeImport(files),
    ".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm,.json",
  );

  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);

  const handleBatchFormat = useCallback(async () => {
    setBatchLoading(true);
    setBatchResult(null);
    try {
      const notes = await api.getNotes();
      const validIds = notes.filter((note) => !note.isLocked && !note.isTrashed).map((note) => note.id).slice(0, 20);
      if (!validIds.length) {
        setBatchResult("没有可格式化的笔记");
        return;
      }
      const result = await api.batchFormatNotes(validIds);
      setBatchResult(t("aiChat.formatSuccess", { success: result.success, failed: result.failed }));
    } catch (error: any) {
      setBatchResult(`❌ ${error.message}`);
    } finally {
      setBatchLoading(false);
    }
  }, [t]);

  const suggestedQuestions = [
    t("aiChat.suggestRecent"),
    t("aiChat.suggestSummary"),
    t("aiChat.suggestTodo"),
  ];

  const currentConversation = conversations.find((conversation) => conversation.id === currentConvId);

  const toggleReferences = (messageId: string) => {
    setExpandedReferenceIds((previous) => {
      const next = new Set(previous);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  const handleReferenceClick = (reference: ChatReference) => {
    const isAttachment = reference.kind === "attachment" && reference.attachmentId;
    if (isAttachment && reference.attachmentId) {
      window.open(resolveAttachmentUrl(`/api/attachments/${reference.attachmentId}?download=1`), "_blank");
    } else if (onNavigateToNote) {
      onNavigateToNote(reference.id);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 max-w-full bg-app-bg">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-14 items-center justify-between border-b border-app-border bg-app-surface/70 px-4 py-2.5 md:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-accent-primary/10">
              <Bot size={14} className="text-accent-primary" />
            </div>
            <div className="min-w-0">
              <div className="max-w-96 truncate text-sm font-semibold text-tx-primary">
                {currentConversation?.title || t("aiChat.title")}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-tx-tertiary">
                <span>{t("aiChat.title")}</span>
                {stats && <><span>·</span><span>{t("aiChat.statsNotes", { count: stats.noteCount })}</span></>}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleNewConversation()}
              disabled={isLoading}
              title={t("aiChat.newConversation")}
              className="inline-flex items-center gap-1.5 rounded-[6px] bg-accent-primary px-2.5 py-1.5 text-[11.5px] font-medium text-white transition-colors hover:bg-accent-primary/90 disabled:opacity-50"
            >
              <Plus size={14} />
              <span className="hidden lg:inline">{t("aiChat.newConversation")}</span>
            </button>
            {!!messages.length && (
              <button
                type="button"
                onClick={clearChat}
                title={t("aiChat.clearChat")}
                className="rounded-[6px] p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-red-500"
              >
                <Trash2 size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              className="rounded-[6px] p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-secondary"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <ScrollArea
          className="min-h-0 min-w-0 flex-1 bg-app-bg"
          scrollbarClassName="w-3 bg-app-surface/70"
          thumbClassName="bg-tx-tertiary/50 hover:bg-tx-secondary/70"
        >
          <div className="mx-auto w-full min-w-0 max-w-4xl space-y-4 px-5 py-6 md:px-8 md:py-8">
            {historyLoading && !messages.length && (
              <div className="flex items-center justify-center py-8 text-tx-tertiary">
                <Loader2 size={16} className="animate-spin" />
              </div>
            )}

            {!historyLoading && !messages.length && (
              <div className="flex flex-col items-center justify-center py-10 text-center md:py-16">
                <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-[10px] border border-app-border bg-accent-primary/10">
                  <Sparkles size={20} className="text-accent-primary" />
                </div>
                <p className="mb-1 text-sm font-semibold text-tx-primary">{t("aiChat.empty")}</p>
                <p className="mb-6 max-w-sm text-[11px] leading-5 text-tx-tertiary">{t("aiChat.emptyHint")}</p>

                {stats && stats.noteCount > 0 && (
                  <div className="mb-6 w-full max-w-md">
                    <div className="mb-3 grid grid-cols-3 gap-2">
                      <div className="flex flex-col items-center rounded-[10px] border border-app-border bg-app-surface px-2 py-2.5">
                        <BookOpen size={16} className="mb-1 text-accent-primary/70" />
                        <span className="text-sm font-semibold text-tx-primary">{stats.noteCount}</span>
                        <span className="text-[11px] text-tx-tertiary">{t("aiChat.statNotes")}</span>
                      </div>
                      <div className="flex flex-col items-center rounded-[10px] border border-app-border bg-app-surface px-2 py-2.5">
                        <Database size={16} className="mb-1 text-accent-primary/70" />
                        <span className="text-sm font-semibold text-tx-primary">{stats.ftsCount}</span>
                        <span className="text-[11px] text-tx-tertiary">{t("aiChat.statIndexed")}</span>
                      </div>
                      <div className="flex flex-col items-center rounded-[10px] border border-app-border bg-app-surface px-2 py-2.5">
                        <FileText size={16} className="mb-1 text-accent-primary/70" />
                        <span className="text-sm font-semibold text-tx-primary">{stats.notebookCount}</span>
                        <span className="text-[11px] text-tx-tertiary">{t("aiChat.statNotebooks")}</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="mb-6 w-full max-w-md">
                  <button
                    type="button"
                    onClick={() => setShowTools((value) => !value)}
                    className="flex w-full items-center justify-center gap-1.5 py-1.5 text-[11px] text-tx-tertiary transition-colors hover:text-accent-primary"
                  >
                    <Wand2 size={11} />
                    {t("aiChat.toolsSection")}
                    {showTools ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                  </button>

                  {showTools && (
                    <div className="mt-2 space-y-2">
                      <div
                        {...docDropHandlers}
                        className={cn(
                          "rounded-[10px] border bg-app-surface p-3 transition-colors",
                          docDragOver
                            ? "border-accent-primary/50 bg-accent-primary/5 ring-2 ring-accent-primary/30"
                            : "border-app-border",
                        )}
                      >
                        <div className="mb-1.5 flex items-center gap-2">
                          <FileUp size={14} className="text-accent-primary" />
                          <span className="text-xs font-medium text-tx-primary">{t("aiChat.docParse")}</span>
                        </div>
                        <p className="mb-2 text-[11px] text-tx-tertiary">{t("aiChat.docParseDesc")}</p>
                        <input
                          ref={docInputRef}
                          type="file"
                          accept=".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm"
                          onChange={handleDocUpload}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => docInputRef.current?.click()}
                          disabled={docParsing}
                          className="flex w-full items-center justify-center gap-1.5 rounded-[6px] border border-app-border px-3 py-1.5 text-[11.5px] text-tx-secondary transition-colors hover:border-accent-primary/30 hover:bg-accent-primary/5 hover:text-accent-primary disabled:opacity-50"
                        >
                          {docParsing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                          {docParsing ? t("aiChat.parsing") : t("aiChat.uploadDoc")}
                        </button>
                        <p className="mt-1 text-center text-[10px] text-tx-tertiary">{t("aiChat.uploadDocHint")}</p>
                        {docResult && (
                          <div className="mt-2 rounded-[8px] border border-app-border bg-app-bg">
                            <div className="flex items-center justify-between border-b border-app-border px-2 py-1">
                              <span className="truncate text-[11px] text-tx-secondary">{docFileName}</span>
                              <div className="flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => navigator.clipboard.writeText(docResult).catch(() => {})}
                                  className="rounded-[6px] p-0.5 text-tx-tertiary hover:bg-app-hover"
                                  title={t("aiChat.copyMarkdown")}
                                >
                                  <Copy size={10} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDocResult(null)}
                                  className="rounded-[6px] p-0.5 text-tx-tertiary hover:bg-app-hover"
                                  title={t("aiChat.closePreview")}
                                >
                                  <X size={10} />
                                </button>
                              </div>
                            </div>
                            <div className="max-h-40 overflow-auto whitespace-pre-wrap p-2 text-[11px] text-tx-secondary">
                              {docResult.slice(0, 1000)}{docResult.length > 1000 && "..."}
                            </div>
                          </div>
                        )}
                      </div>

                      <div
                        {...importDropHandlers}
                        className={cn(
                          "rounded-[10px] border bg-app-surface p-3 transition-colors",
                          importDragOver
                            ? "border-accent-primary/50 bg-accent-primary/5 ring-2 ring-accent-primary/30"
                            : "border-app-border",
                        )}
                      >
                        <div className="mb-1.5 flex items-center gap-2">
                          <FolderUp size={14} className="text-accent-primary" />
                          <span className="text-xs font-medium text-tx-primary">{t("aiChat.importKnowledge")}</span>
                        </div>
                        <p className="mb-2 text-[11px] text-tx-tertiary">{t("aiChat.importKnowledgeDesc")}</p>
                        <input
                          ref={importInputRef}
                          type="file"
                          accept=".doc,.docx,.csv,.tsv,.txt,.md,.html,.htm,.json"
                          multiple
                          onChange={handleKnowledgeImport}
                          className="hidden"
                        />
                        <button
                          type="button"
                          onClick={() => importInputRef.current?.click()}
                          disabled={importLoading}
                          className="flex w-full items-center justify-center gap-1.5 rounded-[6px] border border-app-border px-3 py-1.5 text-[11.5px] text-tx-secondary transition-colors hover:border-accent-primary/30 hover:bg-accent-primary/5 hover:text-accent-primary disabled:opacity-50"
                        >
                          {importLoading ? <Loader2 size={12} className="animate-spin" /> : <FolderUp size={12} />}
                          {importLoading ? t("aiChat.importing") : t("aiChat.importFiles")}
                        </button>
                        <p className="mt-1 text-center text-[10px] text-tx-tertiary">{t("aiChat.importFilesHint")}</p>
                        {importResult && (
                          <div className="mt-2 flex items-center gap-1.5 rounded-[8px] border border-app-border bg-app-hover/60 px-2 py-1.5 text-[11px] text-tx-secondary">
                            <Check size={10} />
                            {importResult}
                          </div>
                        )}
                      </div>

                      <div className="rounded-[10px] border border-app-border bg-app-surface p-3">
                        <div className="mb-1.5 flex items-center gap-2">
                          <Wand2 size={14} className="text-accent-primary" />
                          <span className="text-xs font-medium text-tx-primary">{t("aiChat.batchFormat")}</span>
                        </div>
                        <p className="mb-2 text-[11px] text-tx-tertiary">{t("aiChat.batchFormatDesc")}</p>
                        <button
                          type="button"
                          onClick={() => void handleBatchFormat()}
                          disabled={batchLoading}
                          className="flex w-full items-center justify-center gap-1.5 rounded-[6px] border border-app-border px-3 py-1.5 text-[11.5px] text-tx-secondary transition-colors hover:border-accent-primary/30 hover:bg-accent-primary/5 hover:text-accent-primary disabled:opacity-50"
                        >
                          {batchLoading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                          {batchLoading ? t("aiChat.formatting") : t("aiChat.batchFormat")}
                        </button>
                        <p className="mt-1 text-center text-[10px] text-tx-tertiary">{t("aiChat.selectNotesHint")}</p>
                        {batchResult && (
                          <div className="mt-2 flex items-center gap-1.5 rounded-[8px] border border-app-border bg-app-hover/60 px-2 py-1.5 text-[11px] text-tx-secondary">
                            <Check size={10} />
                            {batchResult}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="w-full max-w-md space-y-2">
                  <p className="mb-2 flex items-center justify-center gap-1 text-[11px] uppercase tracking-wider text-tx-tertiary">
                    <MessageCircleQuestion size={11} />
                    {t("aiChat.trySuggestions")}
                  </p>
                  {suggestedQuestions.map((question) => (
                    <button
                      key={question}
                      type="button"
                      onClick={() => { if (!isLoading) void handleSend(question); }}
                      className="group flex w-full items-center justify-between rounded-[10px] border border-app-border bg-app-surface px-3.5 py-2.5 text-left text-[11.5px] text-tx-secondary transition-colors hover:border-accent-primary/30 hover:bg-accent-primary/5 hover:text-accent-primary"
                    >
                      <span>{question}</span>
                      <ArrowRight size={12} className="ml-2 shrink-0 text-tx-tertiary transition-colors group-hover:text-accent-primary" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => {
              const isUser = message.role === "user";
              const editing = editingMessageId === message.id;
              const time = formatMessageTime(message.createdAt);
              return (
                <div
                  key={message.id}
                  className={cn(
                    "group/message flex w-full min-w-0 max-w-full gap-3",
                    isUser ? "flex-row-reverse pl-12" : "pr-4",
                  )}
                >
                  <div className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]",
                    isUser
                      ? "bg-app-hover text-tx-secondary"
                      : "bg-accent-primary/10 text-accent-primary",
                  )}>
                    {isUser ? <User size={13} /> : <Bot size={13} />}
                  </div>

                  <div className={cn("min-w-0", isUser ? "max-w-[78%] text-right" : "flex-1")}>
                    <div className={cn(
                      "inline-block min-w-0 text-left text-sm leading-6 [overflow-wrap:anywhere]",
                      isUser
                        ? "max-w-full rounded-[10px] border border-app-border bg-app-surface px-3.5 py-2.5 text-tx-primary selection:bg-accent-primary/20"
                        : "w-full rounded-[10px] border border-app-border bg-app-hover/50 px-3.5 py-2.5 text-tx-primary selection:bg-accent-primary/20",
                    )}>
                      {isUser ? (
                        editing ? (
                          <div className="min-w-0 max-w-full space-y-2">
                            <textarea
                              autoFocus
                              value={editDraft}
                              onChange={(event) => setEditDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                                  event.preventDefault();
                                  void handleSaveMessageEdit(message.id);
                                } else if (event.key === "Escape") {
                                  setEditingMessageId(null);
                                  setEditDraft("");
                                }
                              }}
                              rows={3}
                              className="w-full min-w-0 max-w-full resize-y rounded-[8px] border border-app-border bg-app-bg px-2.5 py-1.5 text-sm text-tx-primary outline-none placeholder:text-tx-tertiary focus:border-accent-primary/50 focus:ring-2 focus:ring-accent-primary/30"
                            />
                            <div className="flex justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => { setEditingMessageId(null); setEditDraft(""); }}
                                className="rounded-[6px] border border-app-border px-2 py-1 text-[11px] text-tx-secondary transition-colors hover:bg-app-hover"
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleSaveMessageEdit(message.id)}
                                disabled={!editDraft.trim()}
                                className="rounded-[6px] bg-accent-primary px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-primary/90 disabled:opacity-50"
                              >
                                保存
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.content}</div>
                        )
                      ) : (
                        <div className="markdown-body min-w-0 max-w-full break-words [overflow-wrap:anywhere] prose prose-sm dark:prose-invert
                          prose-p:my-1.5 prose-p:leading-relaxed
                          prose-headings:my-2 prose-headings:font-semibold
                          prose-h1:text-base prose-h2:text-sm prose-h3:text-sm
                          prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
                          prose-code:break-words prose-code:rounded-[4px] prose-code:bg-app-hover prose-code:px-1.5 prose-code:py-0.5 prose-code:text-xs prose-code:before:content-none prose-code:after:content-none
                          prose-blockquote:my-2 prose-blockquote:border-app-border prose-blockquote:text-tx-secondary
                          prose-hr:my-3 prose-a:text-accent-primary prose-a:no-underline hover:prose-a:underline
                          prose-strong:text-tx-primary prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1
                          [&_a]:[overflow-wrap:anywhere] [&_code]:[overflow-wrap:anywhere]
                          [&_p]:max-w-full [&_pre]:max-w-full [&_pre_code]:whitespace-pre [&_pre_code]:break-normal [&_pre_code]:[overflow-wrap:normal]"
                        >
                          {message.content && (
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={aiChatMarkdownComponents}>{message.content}</ReactMarkdown>
                          )}
                          {message.isStreaming && !message.content && (
                            <div className="flex items-center gap-2 py-0.5 text-xs text-tx-tertiary">
                              <span className="flex gap-1">
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary/60 [animation-delay:-0.3s]" />
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary/60 [animation-delay:-0.15s]" />
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent-primary/60" />
                              </span>
                              <span>{t("aiChat.thinking")}</span>
                            </div>
                          )}
                          {message.isStreaming && !!message.content && (
                            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent-primary/60 align-middle" />
                          )}
                          {message.stopped && (
                            <div className="mt-2 text-[11px] text-tx-tertiary">已停止生成</div>
                          )}
                        </div>
                      )}
                    </div>

                    {!!message.references?.length && (
                      <div className={cn("mt-3 min-w-0", isUser && "ml-auto")}>
                        <div className="overflow-hidden rounded-[10px] border border-app-border bg-app-surface">
                          <button
                            type="button"
                            onClick={() => toggleReferences(message.id)}
                            aria-expanded={expandedReferenceIds.has(message.id)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-tx-secondary transition-colors hover:bg-app-hover"
                          >
                            <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-accent-primary/10 text-accent-primary">
                              <FileText size={10} />
                            </span>
                            <span className="font-medium">{t("aiChat.references")}</span>
                            <span className="rounded-full border border-app-border px-1.5 py-0.5 text-[10px] text-tx-tertiary">
                              {message.references.length}
                            </span>
                            <span className="ml-auto text-tx-tertiary">
                              {expandedReferenceIds.has(message.id) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </span>
                          </button>
                          {expandedReferenceIds.has(message.id) && (
                            <ol className="min-w-0 max-w-full space-y-1 border-t border-app-border p-2">
                              {message.references.map((reference, index) => {
                                const isAttachment = reference.kind === "attachment" && reference.attachmentId;
                                const clickable = !!isAttachment || !!onNavigateToNote;
                                return (
                                  <li className="min-w-0 max-w-full" key={`${reference.kind || "note"}-${reference.attachmentId || reference.id}-${index}`}>
                                    <button
                                      type="button"
                                      disabled={!clickable}
                                      onClick={() => handleReferenceClick(reference)}
                                      title={isAttachment ? reference.attachmentFilename || reference.title : reference.title}
                                      className={cn(
                                        "flex w-full min-w-0 max-w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[11px] transition-colors",
                                        clickable ? "cursor-pointer hover:bg-app-hover" : "cursor-default",
                                      )}
                                    >
                                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] bg-app-hover font-semibold text-accent-primary">{index + 1}</span>
                                      {isAttachment ? <Paperclip size={11} className="shrink-0 text-tx-tertiary" /> : <FileText size={11} className="shrink-0 text-tx-tertiary" />}
                                      <span className="min-w-0 flex-1 truncate text-tx-secondary">{reference.title}</span>
                                      {clickable && <ArrowRight size={10} className="shrink-0 text-tx-tertiary" />}
                                    </button>
                                  </li>
                                );
                              })}
                            </ol>
                          )}
                        </div>
                      </div>
                    )}

                    {!editing && (
                      <div className={cn(
                        "mt-1.5 flex items-center gap-1 text-[10px] text-tx-tertiary opacity-70 transition-opacity group-hover/message:opacity-100",
                        isUser ? "justify-end" : "justify-start",
                      )}>
                        {time && <span className="mr-0.5 select-none">{time}</span>}
                        <button
                          type="button"
                          onClick={() => void handleCopyMessage(message)}
                          disabled={!message.content}
                          title="复制"
                          className="rounded-[6px] p-1 opacity-65 transition-colors hover:bg-app-hover hover:opacity-100 disabled:opacity-30"
                        >
                          {copiedMessageId === message.id ? <Check size={11} /> : <Copy size={11} />}
                        </button>
                        {isUser && (
                          <button
                            type="button"
                            onClick={() => handleStartEditMessage(message)}
                            disabled={isLoading}
                            title="编辑"
                            className="rounded-[6px] p-1 opacity-65 transition-colors hover:bg-app-hover hover:opacity-100 disabled:opacity-30"
                          >
                            <Pencil size={11} />
                          </button>
                        )}
                        {!isUser && !message.isStreaming && (
                          <button
                            type="button"
                            onClick={() => void handleRegenerate(message.id)}
                            disabled={isLoading}
                            title="重新生成"
                            className="rounded-[6px] p-1 opacity-65 transition-colors hover:bg-app-hover hover:opacity-100 disabled:opacity-30"
                          >
                            <RotateCcw size={11} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleDeleteMessage(message.id)}
                          disabled={isLoading || message.isStreaming}
                          title="删除"
                          className="rounded-[6px] p-1 opacity-65 transition-colors hover:bg-red-500/10 hover:text-red-500 hover:opacity-100 disabled:opacity-30"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        <div className="shrink-0 border-t border-app-border bg-app-surface/80 px-4 py-3 backdrop-blur md:px-6 md:py-4">
          <div className="mx-auto max-w-4xl rounded-[10px] border border-app-border bg-app-surface transition-colors focus-within:border-accent-primary/40 focus-within:ring-2 focus-within:ring-accent-primary/30">
            <div className="flex min-h-9 flex-wrap items-center gap-1.5 border-b border-app-border/70 px-2.5 py-1.5 text-[11px]">
              <div className="flex min-w-0 items-center gap-1.5 text-tx-tertiary">
                <Database size={11} className="shrink-0 text-accent-primary" />
                <span className="shrink-0">{t("aiChat.knowledgeScope") || "知识库范围"}</span>
                <AIKnowledgeScopePicker
                  notebooks={appState.notebooks}
                  value={nbScope === "all" ? "" : nbScopeId}
                  allLabel={t("aiChat.scopeAll") || "当前空间"}
                  onChange={(value) => {
                    if (!value) {
                      setNbScope("all");
                      setNbScopeId("");
                      return;
                    }
                    setNbScope("notebook");
                    setNbScopeId(value);
                  }}
                />
              </div>
              {nbScope === "notebook" && (
                <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-full border border-app-border px-2.5 py-1 text-[11px] text-tx-tertiary transition-colors hover:border-accent-primary/30 hover:text-tx-secondary">
                  <input
                    type="checkbox"
                    checked={nbIncludeChildren}
                    onChange={(event) => setNbIncludeChildren(event.target.checked)}
                    className="rounded accent-accent-primary"
                  />
                  <span>{t("aiChat.includeChildren") || "含子笔记本"}</span>
                </label>
              )}
              <PluginPromptPicker disabled={isLoading} onSelect={(value) => { setInput(value); requestAnimationFrame(() => inputRef.current?.focus()); }} />
              <span className="ml-auto hidden text-[11px] text-tx-tertiary lg:inline">Enter 发送 · Shift + Enter 换行</span>
            </div>
            <div className="flex items-end gap-2 p-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("aiChat.placeholder")}
                rows={1}
                disabled={isLoading}
                className="max-h-32 min-h-10 flex-1 resize-none rounded-[8px] border border-app-border bg-app-bg px-3 py-2 text-sm leading-6 text-tx-primary outline-none transition-colors placeholder:text-tx-tertiary focus:border-accent-primary/50 focus:ring-2 focus:ring-accent-primary/30 disabled:opacity-70"
                onInput={(event) => {
                  const target = event.target as HTMLTextAreaElement;
                  target.style.height = "auto";
                  target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
                }}
              />
              <button
                type="button"
                onClick={isLoading ? handleStopGeneration : () => void handleSend()}
                disabled={!isLoading && !input.trim()}
                title={isLoading ? "停止生成" : "发送"}
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] transition-colors",
                  isLoading
                    ? "border border-red-500/40 text-red-500 hover:bg-red-500/10"
                    : input.trim()
                      ? "bg-accent-primary text-white hover:bg-accent-primary/90"
                      : "bg-app-hover text-tx-tertiary",
                )}
              >
                {isLoading ? <Square size={13} fill="currentColor" /> : <Send size={14} />}
              </button>
            </div>
          </div>
          {isLoading && (
            <p className="mx-auto mt-1.5 max-w-4xl text-right text-[11px] text-tx-tertiary">正在生成回答，可随时停止</p>
          )}
        </div>
      </div>
    </div>
  );
}
