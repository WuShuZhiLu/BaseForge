/**
 * AppErrorBoundary —— 应用顶层渲染兜底。
 * 捕获子树渲染期异常，降级为可恢复面板（此前无顶层边界时表现为整页白屏）。
 */
import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("[AppErrorBoundary] caught:", error, info);
    // 与 main.tsx 的 window.error 上报共用通道（仅开发模式）
    if (import.meta.env.DEV) {
      fetch("/api/pm/client-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "app-error-boundary",
          message: (error.message || "unknown").slice(0, 500),
          stack: (error.stack || "").slice(0, 3000),
        }),
      }).catch(() => {});
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-[100dvh] w-screen flex-col items-center justify-center gap-3 bg-app-bg p-6 text-center">
          <p className="text-sm font-semibold text-tx-primary">页面渲染出现问题</p>
          <p className="max-w-md break-all text-xs text-tx-secondary">{this.state.error.message}</p>
          <button
            type="button"
            className="rounded-md bg-accent-primary px-3 py-1.5 text-xs font-medium text-white"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default AppErrorBoundary;
