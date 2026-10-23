import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyTaskWorkspace = React.lazy(() => import("./TaskWorkspace"));

export default function LazyTaskWorkspaceRuntime(props: { hideSidebar?: boolean } = {}) {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载任务中心…" />}>
      <LazyTaskWorkspace {...props} />
    </Suspense>
  );
}
