import React from "react";
import { useTranslation } from "react-i18next";
import type { HabitStats } from "@/types";

export function HabitStatsOverview({ stats }: { stats: HabitStats | null }) {
  const { t } = useTranslation();
  if (!stats) return null;

  const cards = [
    { label: t("habits.stats.totalCheckins"), value: stats.totalCheckins },
    { label: t("habits.stats.checkinDays"), value: stats.checkinDays },
    { label: t("habits.stats.currentStreak"), value: stats.currentStreak },
  ];

  return (
    <div className="grid grid-cols-3 gap-2 px-4 pb-1 pt-2.5 md:px-5">
      {cards.map((card) => (
        <div key={card.label} className="rounded-[10px] border border-app-border bg-app-surface px-3 py-2.5">
          <div className="text-[11px] leading-tight text-tx-tertiary">{card.label}</div>
          <div className="mt-1 text-[17px] font-semibold tabular-nums text-tx-primary">{card.value}</div>
        </div>
      ))}
    </div>
  );
}