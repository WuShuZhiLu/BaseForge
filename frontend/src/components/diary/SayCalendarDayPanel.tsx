import React from "react";
import { MessageCircle, FileText, Image, Video, Locate } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Diary } from "@/types";
import { getCurrentWorkspace } from "@/lib/api";

function DiarySummaryRow({
  item,
  onLocateItem,
}: {
  item: Diary;
  onLocateItem: (id: string) => void;
}) {
  const hasImages = (item.images || []).length > 0 || (item.media || []).some((m) => m.type === "image");
  const hasVideo = (item.media || []).some((m) => m.type === "video");
  const previewText = item.contentText?.trim().slice(0, 40) || "";

  return (
    <div className="flex min-h-[44px] items-center gap-2 px-1 py-2 transition-colors hover:bg-app-hover">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] text-tx-secondary truncate">
          <span className="truncate">{previewText}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-tx-tertiary mt-0.5">
          {item.mood && <span>{item.mood}</span>}
          <span className="tabular-nums">{item.createdAt?.slice(11, 16)}</span>
          {hasImages && <Image size={10} />}
          {hasVideo && <Video size={10} />}
          {(item.creatorName && getCurrentWorkspace() !== "personal") && (
            <span className="truncate">· {item.creatorName}</span>
          )}
        </div>
      </div>
      <button
        onClick={() => onLocateItem(item.id)}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
      >
        <Locate size={13} />
      </button>
    </div>
  );
}

export default function SayCalendarDayPanel({
  dateKey,
  items,
  onWriteEntry,
  onLocateItem,
}: {
  dateKey: string;
  items: Diary[];
  onWriteEntry: () => void;
  onLocateItem: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (!dateKey) {
    return (
      <div className="flex flex-col items-center justify-center rounded-[10px] border border-app-border bg-app-surface/40 px-4 py-8 text-center">
        <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-[10px] border border-app-border bg-app-surface">
          <MessageCircle size={16} className="text-tx-tertiary" />
        </div>
        <p className="text-[12px] font-medium text-tx-secondary">
          {t("diary.calendarNoRecords")}
        </p>
        <p className="mt-1 text-[11px] text-tx-tertiary">
          {t("diary.calendarNoRecordsHint", { defaultValue: "选择日期查看当天的记录" })}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[10px] border border-app-border bg-app-surface/40 p-3 flex flex-col gap-2 max-h-[320px] lg:max-h-[420px] overflow-auto">
      <div className="flex items-center justify-between mb-1 gap-2">
        <div className="flex min-w-0 items-center gap-2 text-[11.5px] font-medium text-tx-primary">
          <span className="truncate">{dateKey}</span>
          {items.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-accent-primary/10 text-accent-primary tabular-nums">
              {t("diary.calendarEntryCount", { count: items.length })}
            </span>
          )}
        </div>
        <button
          onClick={onWriteEntry}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[4px] bg-accent-primary px-2.5 text-[11.5px] font-medium text-white transition-colors hover:bg-accent-primary/90"
        >
          <FileText size={12} />
          {t("diary.calendarWriteEntry")}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <MessageCircle size={18} className="mb-2 text-tx-tertiary" />
          <p className="text-[12px] font-medium text-tx-secondary">{t("diary.calendarNoRecords")}</p>
          <p className="mt-1 text-[11px] text-tx-tertiary">
            {t("diary.calendarNoRecordsHint", { defaultValue: "选择日期查看当天的记录" })}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-app-border/60 border-t border-app-border/60">
          {items.map((item) => (
            <DiarySummaryRow key={item.id} item={item} onLocateItem={onLocateItem} />
          ))}
        </div>
      )}
    </div>
  );
}
