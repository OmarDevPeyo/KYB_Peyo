"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { createRenewalLinkAction } from "@/app/admin/(dash)/expirations/actions";
import type { ExpiryStatus } from "@/lib/forms/expiry";

export interface RenewalDocOption {
  fieldId: string;
  label: string;
  status: ExpiryStatus;
  /** Fecha ya formateada, o null si no hay. */
  date: string | null;
}

const TTL_DAYS = [7, 14, 30];

/**
 * Genera un link de renovación para copiar: el analista elige qué documentos
 * pedir y cuánto vale el link. Vienen marcados los vencidos (o, si no hay, los
 * que vencen pronto).
 */
export function RenewalLinkPanel({
  requestId,
  documents,
  blocked = false,
}: {
  requestId: string;
  documents: RenewalDocOption[];
  /** Hay una renovación enviada esperando revisión: no se puede pedir otra. */
  blocked?: boolean;
}) {
  const t = useTranslations("expirations");
  const tAll = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const defaults = (() => {
    const expired = documents.filter((d) => d.status === "expired");
    const pick = expired.length ? expired : documents.filter((d) => d.status === "expiring");
    return new Set(pick.map((d) => d.fieldId));
  })();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(defaults);
  const [ttl, setTtl] = useState(14);
  const [result, setResult] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (documents.length === 0) return null;

  function generate() {
    setError(null);
    startTransition(async () => {
      const res = await createRenewalLinkAction(requestId, [...selected], ttl);
      if (!res.ok) {
        setError(tAll(res.error));
        return;
      }
      setResult({ url: res.url, expiresAt: res.expiresAt });
      router.refresh();
    });
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={blocked}
        title={blocked ? t("linkBlocked") : undefined}
        onClick={() => {
          setOpen(true);
          setResult(null);
          setSelected(defaults);
        }}
      >
        <Link2 size={16} aria-hidden />
        {t("linkCreate")}
      </Button>
    );
  }

  return (
    <div className="w-full rounded-xl border border-border bg-surface p-3">
      {result ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{t("linkReady")}</p>
          <div className="flex flex-wrap gap-2">
            <input
              readOnly
              value={result.url}
              onFocus={(e) => e.currentTarget.select()}
              aria-label={t("linkLabel")}
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-foreground"
            />
            <Button
              type="button"
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(result.url);
                setCopied(true);
              }}
            >
              {copied ? t("linkCopied") : t("linkCopy")}
            </Button>
          </div>
          <p className="text-xs text-muted">
            {t("linkExpiresAt", {
              date: new Date(result.expiresAt).toLocaleDateString(locale, { dateStyle: "medium" }),
            })}{" "}
            {t("linkReplaces")}
          </p>
          <Button type="button" size="sm" variant="quiet" onClick={() => setOpen(false)}>
            {t("close")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <fieldset>
            <legend className="mb-1 text-xs font-semibold text-muted">{t("linkDocuments")}</legend>
            <ul className="space-y-1">
              {documents.map((d) => (
                <li key={d.fieldId}>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="accent-brand"
                      checked={selected.has(d.fieldId)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(d.fieldId);
                        else next.delete(d.fieldId);
                        setSelected(next);
                      }}
                    />
                    <span className="min-w-0 truncate">{d.label}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {t(`status_${d.status}`)}
                      {d.date ? ` · ${d.date}` : ""}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            {t("linkTtl")}
            <select
              value={ttl}
              onChange={(e) => setTtl(Number(e.target.value))}
              className="rounded-lg border border-border bg-surface px-2 py-1 text-sm"
            >
              {TTL_DAYS.map((d) => (
                <option key={d} value={d}>
                  {t("linkTtlDays", { days: d })}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={pending || selected.size === 0} onClick={generate}>
              {pending ? "…" : t("linkGenerate")}
            </Button>
            <Button type="button" size="sm" variant="quiet" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
