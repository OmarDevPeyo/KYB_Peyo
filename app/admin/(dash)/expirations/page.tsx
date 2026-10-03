import Link from "next/link";
import { CalendarClock, ChevronLeft, ChevronRight, Mail, Search } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireAnalyst } from "@/lib/auth/admin";
import { resolveListScope } from "@/lib/auth/tenant";
import { OrgTabs } from "@/components/admin/OrgTabs";
import { TabLink } from "@/components/admin/TabLink";
import { Card } from "@/components/ui/Card";
import { buttonClass } from "@/components/ui/Button";
import {
  ExpirationList,
  formatExpiryDate,
  type ExpirationItem,
} from "@/components/admin/ExpirationList";
import { addDays, EXPIRY_SOON_DAYS, expiryStatus, todayUtc } from "@/lib/forms/expiry";
import { resolveText, type LocalizedText } from "@/lib/forms/definition";
import { RenewalLinkPanel } from "@/components/admin/RenewalLinkPanel";
import { EXPIRATION_COLUMNS } from "@/lib/kyb/expirations";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const VIEWS = ["expired", "soon", "unknown", "review", "all"] as const;
type View = (typeof VIEWS)[number];

function isView(v: string | undefined): v is View {
  return !!v && (VIEWS as readonly string[]).includes(v);
}

/** URL de la lista. `expired` es la vista por defecto y no va en la URL. */
function expirationsHref(q: { org: string; q: string; view: View; page?: number }): string {
  const params = new URLSearchParams();
  if (q.org) params.set("org", q.org);
  if (q.view !== "expired") params.set("view", q.view);
  if (q.q) params.set("q", q.q);
  if (q.page && q.page > 1) params.set("page", String(q.page));
  const qs = params.toString();
  return qs ? `/admin/expirations?${qs}` : "/admin/expirations";
}

const SUMMARY_COLUMNS =
  "request_id, org_id, external_ref, subject_title, contact_email, decided_at, first_expires_on, expired_count, next_expires_on, unknown_count, tracked_count, open_renewal_state, last_email_sent_at";

type SummaryRow = {
  request_id: string;
  org_id: string;
  external_ref: string;
  subject_title: string | null;
  contact_email: string | null;
  decided_at: string | null;
  first_expires_on: string | null;
  expired_count: number;
  next_expires_on: string | null;
  unknown_count: number;
  tracked_count: number;
  open_renewal_state: "requested" | "submitted" | null;
  last_email_sent_at: string | null;
};

const PUBLIC_PREFIX = "public:";

export default async function ExpirationsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; q?: string; view?: string; page?: string }>;
}) {
  // Guard propio, como el resto de las páginas del panel (el layout corre en
  // paralelo).
  const analyst = await requireAnalyst();
  const t = await getTranslations("expirations");
  const locale = await getLocale();
  const sp = await searchParams;

  const { scope, orgs } = await resolveListScope(analyst, sp.org);
  const showOrgs = analyst.role === "admin";
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  const view: View = isView(sp.view) ? sp.view : "expired";
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const base = { org: showOrgs ? (scope ?? "") : "", q };
  const today = todayUtc();

  const supabase = await createServerSupabase();
  // Mismo saneo que la lista de solicitudes: dentro de `or()` las comas, los
  // paréntesis y las comillas son sintaxis de PostgREST.
  const term = q.replace(/[,()"\\*%]/g, "").trim();

  // Cliente de sesión: la vista es security_invoker, así que la RLS de
  // kyb_requests y document_expirations deja a cada miembro con su org.
  function summaries(v: View, head: boolean) {
    let query = supabase
      .from("expiring_requests")
      .select(head ? "request_id" : SUMMARY_COLUMNS, { count: "exact", head });
    if (scope) query = query.eq("org_id", scope);
    if (term) {
      query = query.or(
        ["external_ref", "subject_title", "contact_email"]
          .map((col) => `${col}.ilike.*${term}*`)
          .join(","),
      );
    }
    switch (v) {
      case "expired":
        return query.gt("expired_count", 0);
      case "soon":
        return query.lte("next_expires_on", addDays(today, EXPIRY_SOON_DAYS));
      case "unknown":
        return query.gt("unknown_count", 0);
      case "review":
        return query.eq("open_renewal_state", "submitted");
      default:
        return query;
    }
  }

  const [listRes, ...countRes] = await Promise.all([
    summaries(view, false)
      .order("first_expires_on", { ascending: true, nullsFirst: false })
      .order("request_id")
      .range(offset, offset + PAGE_SIZE - 1),
    ...VIEWS.map((v) => summaries(v, true)),
  ]);
  const counts = new Map(VIEWS.map((v, i) => [v, countRes[i].count ?? 0] as const));
  const rows = (listRes.data ?? []) as unknown as SummaryRow[];
  const total = listRes.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const { data: docRows } = rows.length
    ? await supabase
        .from("document_expirations")
        .select(EXPIRATION_COLUMNS)
        .in(
          "request_id",
          rows.map((r) => r.request_id),
        )
    : { data: [] };
  const docsOf = new Map<string, (ExpirationItem & { request_id: string })[]>();
  for (const d of (docRows ?? []) as unknown as (ExpirationItem & { request_id: string })[]) {
    const list = docsOf.get(d.request_id);
    if (list) list.push(d);
    else docsOf.set(d.request_id, [d]);
  }

  return (
    <main className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-0.5 text-sm text-muted">{t("subtitle", { days: EXPIRY_SOON_DAYS })}</p>
      </header>

      {showOrgs && (
        <OrgTabs
          orgs={orgs}
          active={scope}
          hrefFor={(orgId) => expirationsHref({ ...base, org: orgId ?? "", view })}
        />
      )}

      <nav aria-label={t("views")} className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {VIEWS.map((v) => (
          <TabLink
            key={v}
            href={expirationsHref({ ...base, view: v })}
            label={`${t(`view_${v}`)} (${counts.get(v) ?? 0})`}
            isActive={view === v}
          />
        ))}
      </nav>

      {/* GET simple: la búsqueda vive en la URL, igual que la vista y la org. */}
      <form action="/admin/expirations" className="mb-4 flex gap-2">
        {base.org && <input type="hidden" name="org" value={base.org} />}
        {view !== "expired" && <input type="hidden" name="view" value={view} />}
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{t("search")}</span>
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder={t("searchPlaceholder")}
            className="w-full rounded-lg border border-border bg-surface py-2 pr-3 pl-9 text-sm text-foreground placeholder:text-muted outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
          />
        </label>
        <button type="submit" className={buttonClass({ variant: "outline", size: "sm" })}>
          {t("searchButton")}
        </button>
      </form>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-muted">
              <CalendarClock size={20} aria-hidden />
            </span>
            <p className="text-sm text-muted">{q ? t("noResults") : t(`empty_${view}`)}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const docs = docsOf.get(r.request_id) ?? [];
              const statuses = docs.map((d) => expiryStatus(d.expires_on, today));
              const expired = statuses.filter((s) => s === "expired").length;
              const expiring = statuses.filter((s) => s === "expiring").length;
              const unknown = statuses.filter((s) => s === "unknown").length;
              const ref = r.external_ref.startsWith(PUBLIC_PREFIX)
                ? r.external_ref.slice(PUBLIC_PREFIX.length)
                : r.external_ref;
              const title = r.subject_title || ref;
              const org = showOrgs && !scope ? (orgName.get(r.org_id) ?? null) : null;
              const when = expired
                ? r.first_expires_on &&
                  t("firstExpired", { date: formatExpiryDate(r.first_expires_on, locale) })
                : r.next_expires_on &&
                  t("nextExpires", { date: formatExpiryDate(r.next_expires_on, locale) });
              return (
                <li key={r.request_id}>
                  <details open={rows.length === 1} className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
                      <ChevronRight
                        size={16}
                        aria-hidden
                        className="shrink-0 text-muted transition-transform group-open:rotate-90"
                      />
                      <span className="min-w-0 flex-1 basis-48">
                        <span
                          className={`block truncate text-sm font-medium text-foreground ${r.subject_title ? "" : "font-mono"}`}
                          title={title}
                        >
                          {title}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted">
                          {[r.subject_title ? ref : null, r.contact_email].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {org && (
                          <span className="rounded-md bg-brand/10 px-1.5 py-0.5 text-[11px] font-medium text-brand">
                            {org}
                          </span>
                        )}
                        {expired > 0 && (
                          <span className="rounded-full bg-danger/15 px-2 py-0.5 text-xs font-medium text-danger">
                            {t("chipExpired", { count: expired })}
                          </span>
                        )}
                        {expiring > 0 && (
                          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                            {t("chipExpiring", { count: expiring })}
                          </span>
                        )}
                        {unknown > 0 && (
                          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">
                            {t("chipUnknown", { count: unknown })}
                          </span>
                        )}
                        {r.open_renewal_state && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              r.open_renewal_state === "submitted"
                                ? "bg-alert/15 text-alert"
                                : "bg-brand/10 text-brand"
                            }`}
                          >
                            {t(`renewal_${r.open_renewal_state}`)}
                          </span>
                        )}
                      </span>
                      {when && (
                        <span className="shrink-0 text-xs whitespace-nowrap text-muted sm:ml-auto">
                          {when}
                        </span>
                      )}
                    </summary>
                    <div className="border-t border-border bg-surface-2/40">
                      <ExpirationList items={docs} today={today} />
                      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
                        {r.open_renewal_state !== "submitted" && (
                          <Link
                            href={`/admin/expirations/${r.request_id}/email`}
                            className={buttonClass({ size: "sm" })}
                          >
                            <Mail size={16} aria-hidden />
                            {t("prepareEmail")}
                          </Link>
                        )}
                        <RenewalLinkPanel
                          requestId={r.request_id}
                          blocked={r.open_renewal_state === "submitted"}
                          documents={docs.map((d) => ({
                            fieldId: d.field_id,
                            label: resolveText(d.field_label as LocalizedText, locale) || d.field_key,
                            status: expiryStatus(d.expires_on, today),
                            date: d.expires_on ? formatExpiryDate(d.expires_on, locale) : null,
                          }))}
                        />
                        <Link
                          href={`/admin/requests/${r.request_id}`}
                          className={buttonClass({ variant: "outline", size: "sm" })}
                        >
                          {r.open_renewal_state === "submitted" ? t("reviewRenewal") : t("viewRequest")}
                        </Link>
                        {r.last_email_sent_at && (
                          <span className="text-xs text-muted">
                            {t("lastEmail", {
                              date: new Date(r.last_email_sent_at).toLocaleDateString(locale, {
                                dateStyle: "medium",
                              }),
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-between gap-2 text-sm">
          <span className="text-muted">{t("pageOf", { page, total: totalPages })}</span>
          <div className="flex gap-2">
            <PageLink
              href={expirationsHref({ ...base, view, page: page - 1 })}
              disabled={page <= 1}
              label={t("previous")}
              dir="prev"
            />
            <PageLink
              href={expirationsHref({ ...base, view, page: page + 1 })}
              disabled={page >= totalPages}
              label={t("next")}
              dir="next"
            />
          </div>
        </nav>
      )}
    </main>
  );
}

function PageLink({
  href,
  disabled,
  label,
  dir,
}: {
  href: string;
  disabled: boolean;
  label: string;
  dir: "prev" | "next";
}) {
  const content =
    dir === "prev" ? (
      <>
        <ChevronLeft size={16} aria-hidden />
        {label}
      </>
    ) : (
      <>
        {label}
        <ChevronRight size={16} aria-hidden />
      </>
    );
  if (disabled) {
    return (
      <span
        aria-disabled
        className={buttonClass({
          variant: "outline",
          size: "sm",
          className: "pointer-events-none opacity-50",
        })}
      >
        {content}
      </span>
    );
  }
  return (
    <Link href={href} className={buttonClass({ variant: "outline", size: "sm" })}>
      {content}
    </Link>
  );
}
