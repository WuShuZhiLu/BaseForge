import React, { useCallback, useEffect } from "react";
import { Paperclip } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, resolveAttachmentUrl } from "@/lib/api";
import { reportPanelCount } from "@/lib/sidebarPanelCounts";
import { PanelBody, PanelEmpty, PanelLoading, PanelRow, usePanelData, usePanelRefresh } from "@/components/sidebar/panels/shared";

interface AttachmentRow { id: string; filename: string; size?: number; url?: string }

/** 附件面板（内容层新实现）：数据源 = api.files.list（与附件管理页一致）。 */
export default function AttachmentsPanel() {
  const { t } = useTranslation();
  const load = useCallback(async () => {
    const res = (await api.files.list({ limit: 30, offset: 0 } as never)) as { items?: AttachmentRow[] };
    return res?.items ?? [];
  }, []);
  const { data: items, loading, reload } = usePanelData<AttachmentRow[]>(load, []);
  usePanelRefresh("files", reload);
  useEffect(() => {
    reportPanelCount("files", items.length);
  }, [items.length]);

  const humanSize = (size?: number) => {
    if (!size) return "";
    if (size < 1024) return size + " B";
    if (size < 1024 * 1024) return Math.round(size / 1024) + " KB";
    return (size / 1024 / 1024).toFixed(1) + " MB";
  };

  return (
    <PanelBody>
      {loading ? (
        <PanelLoading />
      ) : items.length === 0 ? (
        <PanelEmpty text={t("sidebar.noAttachments")} />
      ) : (
        items.map((item) => (
          <PanelRow
            key={item.id}
            title={item.filename}
            leading={
              item.url ? (
                <img src={resolveAttachmentUrl(item.url)} alt="" loading="lazy" decoding="async" className="h-5 w-5 shrink-0 rounded object-cover" />
              ) : (
                <Paperclip size={13} className="shrink-0 text-tx-tertiary" />
              )
            }
            trailing={<span className="shrink-0 text-[10.5px] tabular-nums text-tx-quaternary">{humanSize(item.size)}</span>}
          >
            {item.filename}
          </PanelRow>
        ))
      )}
    </PanelBody>
  );
}
