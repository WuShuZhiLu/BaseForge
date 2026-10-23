import React, { Suspense } from "react";
import LazyWorkspaceFallback from "./LazyWorkspaceFallback";

const LazyDiaryWorkspace = React.lazy(() => import("./DiaryWorkspace"));

export default function LazyDiaryWorkspaceRuntime() {
  return (
    <Suspense fallback={<LazyWorkspaceFallback label="正在加载日记中心…" />}>
      <LazyDiaryWorkspace />
    </Suspense>
  );
}
