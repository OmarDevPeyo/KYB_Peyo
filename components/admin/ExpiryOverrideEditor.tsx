"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { setExpiryOverrideAction } from "@/app/admin/(dash)/expirations/actions";

/**
 * Corrección manual de la fecha de vencimiento de un documento. Cerrado
 * muestra «Corregir fecha» (y «Quitar corrección» si la hay); abierto, un
 * input de fecha.
 */
export function ExpiryOverrideEditor({
  expirationId,
  current,
  hasOverride,
}: {
  expirationId: string;
  /** Fecha vigente (`YYYY-MM-DD`), para precargar el input. */
  current: string | null;
  hasOverride: boolean;
}) {
  const t = useTranslations("expirations");
  const tAll = useTranslations();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(date: string | null) {
    setError(null);
    startTransition(async () => {
      const res = await setExpiryOverrideAction(expirationId, date);
      if (!res.ok) {
        setError(tAll(res.error));
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => {
            setValue(current ?? "");
            setEditing(true);
          }}
          className="text-xs font-medium text-brand hover:underline"
        >
          {t("override")}
        </button>
        {hasOverride && (
          <button
            type="button"
            disabled={pending}
            onClick={() => save(null)}
            className="text-xs font-medium text-muted hover:text-foreground hover:underline disabled:opacity-50"
          >
            {t("overrideClear")}
          </button>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </span>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value) save(value);
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        type="date"
        required
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={t("overrideLabel")}
        className="rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground outline-none focus:border-brand"
      />
      <Button type="submit" size="sm" disabled={pending || !value}>
        {pending ? "…" : t("overrideSave")}
      </Button>
      <Button type="button" size="sm" variant="quiet" onClick={() => setEditing(false)}>
        {t("cancel")}
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </form>
  );
}
