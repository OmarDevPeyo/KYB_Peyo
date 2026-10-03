import { getLocale, getTranslations } from "next-intl/server";
import { resolveText, type LocalizedText } from "@/lib/forms/definition";
import { fileRefsOf } from "@/lib/forms/answers";
import { expiryStatus, proposedRenewalExpiry } from "@/lib/forms/expiry";
import { nodeOf } from "@/lib/didit/summary";
import type { RenewalRow } from "@/lib/kyb/renewals";
import { DocLink } from "@/components/admin/DocLink";
import { ExpiryStatusBadge, formatExpiryDate, type ExpirationItem } from "@/components/admin/ExpirationList";
import { RenewalLinkPanel } from "@/components/admin/RenewalLinkPanel";
import { RenewalReviewActions } from "@/components/admin/RenewalReviewActions";

const STATE_COLORS: Record<RenewalRow["state"], string> = {
  sending: "bg-surface-2 text-muted",
  requested: "bg-brand/10 text-brand",
  submitted: "bg-alert/15 text-alert",
  accepted: "bg-success/15 text-success",
  rejected: "bg-danger/15 text-danger",
  cancelled: "bg-surface-2 text-muted",
  failed: "bg-surface-2 text-danger",
};

/** Cuántas rondas se muestran (la más nueva primero). */
const MAX_ROUNDS = 5;

/**
 * Renovación de documentos en el detalle de una solicitud aprobada: generar el
 * link y revisar lo que envió el solicitante. Lo enviado está retenido en la
 * ronda; recién al aceptar pasa a las respuestas.
 */
export async function RenewalCard({
  requestId,
  renewals,
  expirations,
  today,
  approved,
}: {
  requestId: string;
  renewals: RenewalRow[];
  expirations: ExpirationItem[];
  today: string;
  approved: boolean;
}) {
  const t = await getTranslations("expirations");
  const locale = await getLocale();
  const fmtDate = (d: string) => formatExpiryDate(d, locale);
  const fmtTime = (ts: string) =>
    new Date(ts).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  const blocked = renewals.some((r) => r.state === "submitted");

  return (
    <div className="space-y-3">
      {approved && (
        <RenewalLinkPanel
          requestId={requestId}
          blocked={blocked}
          documents={expirations.map((e) => ({
            fieldId: e.field_id,
            label: resolveText(e.field_label as LocalizedText, locale) || e.field_key,
            status: expiryStatus(e.expires_on, today),
            date: e.expires_on ? fmtDate(e.expires_on) : null,
          }))}
        />
      )}

      {renewals.slice(0, MAX_ROUNDS).map((r) => {
        const linkExpired =
          r.state === "requested" && !!r.token_expires_at && new Date(r.token_expires_at) < new Date();
        return (
          <div key={r.id} className="rounded-xl border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {t("renewalRound", { round: r.round })}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_COLORS[r.state]}`}
              >
                {t(`renewalState_${r.state}`)}
              </span>
              {linkExpired && (
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
                  {t("renewalLinkExpired")}
                </span>
              )}
              <span className="text-xs text-muted sm:ml-auto">
                {t("renewalRequestedBy", {
                  email: r.requested_by_email ?? "—",
                  date: fmtTime(r.created_at),
                })}
              </span>
            </div>

            <p className="mt-1 text-xs text-muted">
              {[
                r.email_to && t("renewalEmailTo", { email: r.email_to }),
                r.email_sent_at && t("renewalEmailSent", { date: fmtTime(r.email_sent_at) }),
                r.state === "requested" &&
                  r.token_expires_at &&
                  t("renewalLinkUntil", { date: fmtTime(r.token_expires_at) }),
                r.submitted_at && t("renewalSubmittedAt", { date: fmtTime(r.submitted_at) }),
                r.reviewed_at &&
                  t("renewalReviewedBy", {
                    email: r.reviewed_by_email ?? "—",
                    date: fmtTime(r.reviewed_at),
                  }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {r.email_error && r.state === "failed" && (
              <p className="mt-1 text-xs text-danger">{t("renewalEmailError", { error: r.email_error })}</p>
            )}
            {r.review_note && (
              <p className="mt-1 text-xs text-foreground">
                {t("renewalNote")}: {r.review_note}
              </p>
            )}

            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {r.fields.map((f) => {
                const label = resolveText(f.label, locale) || f.fieldKey;
                const showUploads = r.state === "submitted" || r.state === "accepted" || r.state === "rejected";
                const files = showUploads ? f.keys.flatMap((k) => fileRefsOf(r.answers?.[k])) : [];
                const proposed = showUploads ? proposedRenewalExpiry(f, r.answers ?? {}, r.checks) : null;
                const check = (r.checks ?? []).find(
                  (c) => c.feature === "id_verification" && c.fieldKey === f.fieldKey,
                );
                const read = check
                  ? (nodeOf("id_verification", check.result)?.expiration_date as string | undefined)
                  : undefined;
                return (
                  <li key={f.fieldId} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="truncate text-sm text-foreground" title={label}>
                        {label}
                      </p>
                      <p className="text-xs text-muted">
                        {f.expiresOn
                          ? t("renewalWas", { date: fmtDate(f.expiresOn) })
                          : t("noDate")}
                      </p>
                      {files.length > 0 && (
                        <p className="mt-1 flex flex-wrap gap-x-2 text-xs">
                          {files.map((file) => (
                            <DocLink key={file.path} path={file.path} filename={file.filename} />
                          ))}
                        </p>
                      )}
                      {check && (
                        <p className="mt-1 text-xs text-muted">
                          {t("renewalDidit", { status: t(`check_${check.status}`) })}
                          {read ? ` · ${read}` : ""}
                        </p>
                      )}
                    </div>
                    {showUploads && (
                      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                        <span className="text-xs text-muted">{t("renewalProposed")}</span>
                        <span className="flex items-center gap-2">
                          <ExpiryStatusBadge status={expiryStatus(proposed, today)} />
                          <span className="text-sm font-medium tabular-nums text-foreground">
                            {proposed ? fmtDate(proposed) : t("noDate")}
                          </span>
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {(r.state === "requested" || r.state === "submitted") && (
              <div className="mt-2">
                <RenewalReviewActions
                  renewalId={r.id}
                  state={r.state}
                  canReverify={r.state === "submitted" && r.fields.some((f) => f.marker === "didit")}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
