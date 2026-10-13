import React, { useState } from "react";
import { ArrowLeft } from "lucide-react";

import BackupCenter from "@/components/dataManagement/BackupCenter";
import DataTransferCenter from "@/components/dataManagement/DataTransferCenter";
import RemoteImageLocalizationPanel from "@/components/RemoteImageLocalizationPanel";
import { DesktopDataSafetyCard, DataFileSection } from "@/components/DataManager";

type SubTab = "center" | "import" | "export";

/**
 * 设置弹窗「备份中心」Tab 的包装层。
 * 复用 1.5.1 的 BackupCenter + DataTransferCenter 组合，advanced 区块沿用
 * 本地 DataManager 中已有的卡片（桌面数据安全 / 远程图片本地化 / 数据文件）。
 * 不改动 DataManager 自身的「数据管理」Tab 行为。
 */
export default function BackupCenterTab() {
  const [subTab, setSubTab] = useState<SubTab>("center");

  if (subTab !== "center") {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setSubTab("center")}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          <ArrowLeft size={14} />
          返回备份中心
        </button>
        <DataTransferCenter onImport={() => setSubTab("import")} onExport={() => setSubTab("export")} />
      </div>
    );
  }

  return (
    <BackupCenter
      migration={<DataTransferCenter onImport={() => setSubTab("import")} onExport={() => setSubTab("export")} />}
      advanced={
        <>
          <DesktopDataSafetyCard />
          <RemoteImageLocalizationPanel />
          <DataFileSection />
        </>
      }
    />
  );
}
