import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { pluginApi } from "@/lib/pluginApi";
import { confirm } from "@/components/ui/confirm";

export function PluginRuntimePolicySettings({ onPolicyChange }: { onPolicyChange?: (allowed: boolean | null) => void }) {
  const { t } = useTranslation();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    onPolicyChange?.(null);
    void pluginApi.getRuntimePolicy().then((policy) => { if (active) { setAllowed(policy.allowNodeRuntime); onPolicyChange?.(policy.allowNodeRuntime); } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [onPolicyChange]);
  const change = async (enabled: boolean) => {
    if (enabled) {
      const ok = await confirm({
        title: t("plugins.runtimePolicy.confirm"),
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true); setError("");
    try { const policy = await pluginApi.setRuntimePolicy(enabled); setAllowed(policy.allowNodeRuntime); onPolicyChange?.(policy.allowNodeRuntime); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="rounded-[10px] border border-app-border bg-app-bg p-3">
    <label className="flex items-center justify-between gap-3 text-[11.5px] font-medium text-tx-primary">
      {t("plugins.runtimePolicy.title")}
      <input
        type="checkbox"
        checked={allowed === true}
        disabled={allowed === null || busy}
        onChange={(event) => void change(event.target.checked)}
        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent-primary disabled:cursor-default disabled:opacity-50"
      />
    </label>
    <p className="mt-1 text-[11px] leading-relaxed text-tx-tertiary">{t("plugins.runtimePolicy.description")}</p>
    {error && <p role="alert" className="mt-2 text-[11px] text-red-600">{error}</p>}
  </div>;
}
