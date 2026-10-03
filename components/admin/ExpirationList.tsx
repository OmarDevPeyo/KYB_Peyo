import { getLocale, getTranslations } from "next-intl/server";
import { resolveText, type LocalizedText } from "@/lib/forms/definition";
import { daysBetween, expiryStatus, type ExpiryStatus } from "@/lib/forms/expiry";
import { DocLink } from "@/components/admin/DocLink";
import { ExpiryOverrideEditor } from "@/components/admin/ExpiryOverrideEditor";

/** Lo que la lista necesita de una fila de `document_expirations`. */
export interface ExpirationItem {
  id: string;
  field_id: string;
  field_key: string;
  field_label: unknown;
  source: string;
  expires_on: string | null;
  auto_expires_on: string | null;
  override_expires_on: string | null;
  override_by_email: string | null;
  doc_path: string | null;
  doc_filename: string | null;
}

const STATUS_COLORS: Record<ExpiryStatus, string> = {
  expired: "bg-danger/15 text-danger",
  expiring: "bg-warning/15 text-warning",
  valid: "bg-success/15 text-success",
  unknown: "bg-surface-2 text-muted",
};

/** Orden de lectura: lo vencido primero, lo que no tiene fecha al final. */
const STATUS_ORDER: Record<ExpiryStatus, number> = {
  expired: 0,
  expiring: 1,
  valid: 2,
  unknown: 3,
};

export async function ExpiryStatusBadge({ status }: { status: ExpiryStatus }) {
  const t = await getTranslations("expirations");
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[status]}`}
    >
      {t(`status_${status}`)}
    </span>
  );
}

/** `12 oct 2026`. Las fechas son días (sin hora): se formatean en UTC. */
export function formatExpiryDate(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/**
 * Documentos controlados de una solicitud: fecha, estado, origen y la
 * corrección manual. La usan la pantalla Vencimientos y el detalle.
 */
export async function ExpirationList({
  items,
  today,
  editable = true,
}: {
  items: ExpirationItem[];
  /** Hoy en UTC (`YYYY-MM-DD`): el mismo para toda la página. */
  today: string;
  editable?: boolean;
}) {
  const t = await getTranslations("expirations");
  const locale = await getLocale();

  const rows = items
    .map((it) => ({ it, status: expiryStatus(it.expires_on, today) }))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        (a.it.expires_on ?? "").localeCompare(b.it.expires_on ?? ""),
    );

  return (
    <ul className="divide-y divide-border">
      {rows.map(({ it, status }) => {
        const label = resolveText(it.field_label as LocalizedText, locale) || it.field_key;
        const days = it.expires_on ? daysBetween(today, it.expires_on) : null;
        const relative =
          days === null
            ? null
            : days < 0
              ? t("expiredAgo", { days: -days })
              : days === 0
                ? t("expiresToday")
                : t("expiresIn", { days });
        const source =
          it.source === "analyst"
            ? t("source_analyst", { email: it.override_by_email ?? "—" })
            : t(`source_${it.source === "didit" ? "didit" : "declared"}`);
        return (
          <li key={it.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-3">
            <div className="min-w-0 flex-1 basis-56">
              <p className="truncate text-sm font-medium text-foreground" title={label}>
                {label}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                {it.doc_path ? (
                  <DocLink path={it.doc_path} filename={it.doc_filename ?? t("document")} />
                ) : (
                  <span>{t("noDocument")}</span>
                )}
                <span aria-hidden>·</span>
                <span>{source}</span>
              </p>
              {it.source === "analyst" && it.auto_expires_on && (
                <p className="mt-0.5 text-xs text-muted">
                  {t("autoWas", { date: formatExpiryDate(it.auto_expires_on, locale) })}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
              <span className="flex items-center gap-2">
                <ExpiryStatusBadge status={status} />
                <span className="text-sm font-medium tabular-nums text-foreground">
                  {it.expires_on ? formatExpiryDate(it.expires_on, locale) : t("noDate")}
                </span>
              </span>
              {relative && <span className="text-xs text-muted">{relative}</span>}
              {editable && (
                <ExpiryOverrideEditor
                  expirationId={it.id}
                  current={it.expires_on}
                  hasOverride={Boolean(it.override_expires_on)}
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
