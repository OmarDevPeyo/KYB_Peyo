"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import {
  acceptRenewalAction,
  cancelRenewalAction,
  rejectRenewalAction,
  rerunRenewalVerificationsAction,
} from "@/app/admin/(dash)/expirations/actions";

type Result = { ok: true } | { ok: false; error: string };

/**
 * Acciones sobre una ronda de renovación: cancelar el link (`requested`), o
 * aceptar / pedir de nuevo lo enviado (`submitted`).
 */
export function RenewalReviewActions({
  renewalId,
  state,
  canReverify = false,
}: {
  renewalId: string;
  state: "requested" | "submitted";
  /** Hay documentos con fecha de DIDIT: se puede volver a verificar. */
  canReverify?: boolean;
}) {
  const t = useTranslations("expirations");
  const tAll = useTranslations();
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<Result>) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        setError(tAll(res.error));
        return;
      }
      setRejecting(false);
      router.refresh();
    });
  }

  if (state === "requested") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => cancelRenewalAction(renewalId))}
        >
          {t("renewalCancel")}
        </Button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    );
  }

  if (rejecting) {
    return (
      <div className="w-full space-y-2">
        <label className="block text-xs font-semibold text-muted" htmlFor={`reject-${renewalId}`}>
          {t("renewalRejectNote")}
        </label>
        <textarea
          id={`reject-${renewalId}`}
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-brand"
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() => run(() => rejectRenewalAction(renewalId, note))}
          >
            {t("renewalRejectConfirm")}
          </Button>
          <Button type="button" size="sm" variant="quiet" onClick={() => setRejecting(false)}>
            {t("cancel")}
          </Button>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="success"
        disabled={pending}
        onClick={() => run(() => acceptRenewalAction(renewalId))}
      >
        {t("renewalAccept")}
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setRejecting(true)}>
        {t("renewalReject")}
      </Button>
      {canReverify && (
        <Button
          type="button"
          size="sm"
          variant="quiet"
          disabled={pending}
          onClick={() => run(() => rerunRenewalVerificationsAction(renewalId))}
        >
          {t("renewalReverify")}
        </Button>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
