import Link from "next/link";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { Card } from "@/components/ui/Card";
import { buttonClass } from "@/components/ui/Button";
import { ClickableRow } from "@/components/admin/ClickableRow";
import { OriginBadge } from "@/components/admin/OriginBadge";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { resolveText, type LocalizedText } from "@/lib/forms/definition";
import { countryName, flagEmoji } from "@/lib/forms/countries";
import { normalizeIpCountry } from "@/lib/kyb/ipCountry";
import type { KybStatus } from "@/lib/kyb/types";
import { RequestsToolbar, type FormOption } from "./RequestsToolbar";
import { FORM_NONE } from "./requestFilters";
import { requireAnalyst } from "@/lib/auth/admin";
import { resolveListScope } from "@/lib/auth/tenant";
import { clearedFilters, requestsHref, withOrg } from "@/lib/admin/requestsQuery";
import { OrgTabs } from "@/components/admin/OrgTabs";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

const STATUSES: KybStatus[] = [
  "created",
  "in_progress",
  "submitted",
  "under_review",
  "changes_requested",
  "approved",
  "rejected",
  "expired",
];

function isStatus(v: string | undefined): v is KybStatus {
  return !!v && (STATUSES as string[]).includes(v);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `form` de la URL: un uuid, `none` o nada. Un uuid mal formado haría fallar la consulta. */
function parseFormFilter(v: string | undefined): string {
  if (!v) return "";
  return v === FORM_NONE || UUID_RE.test(v) ? v : "";
}

type RequestRow = {
  id: string;
  external_ref: string;
  status: string;
  created_at: string;
  api_key_id: string | null;
  form_id: string | null;
  form_revision: number | null;
  org_id: string;
  /** Respuestas a las preguntas marcadas como título y email (0029). */
  subject_title: string | null;
  contact_email: string | null;
  /** País de la IP con que se envió (0034). */
  submitted_ip_country: string | null;
  /** `form_definition->title` del snapshot: sobrevive al borrado del formulario. */
  snapshot_title: LocalizedText | null;
  form: { name: string } | null;
};

/** Una solicitud lista para pintar, igual en la tabla y en las tarjetas. */
type RequestItem = {
  id: string;
  href: string;
  status: string;
  ref: string;
  /** Nombre de la solicitud (pregunta marcada como título); sin él se muestra la ref. */
  title: string | null;
  email: string | null;
  /** País de la IP del envío: el código se pinta, el nombre va en el tooltip. */
  country: { code: string; name: string } | null;
  api: boolean;
  client: string | null;
  /** Nombre de la org dueña: solo en la pestaña "Todas" del admin. */
  org: string | null;
  form: { name: string; meta: string | null; muted: boolean; hint: string };
  date: string;
  time: string;
};

/**
 * Segunda línea de la celda: el país de la IP del envío, si lo hay; con nombre,
 * la referencia pasa acá (en mono); el email va siempre que exista. El país va
 * primero porque es corto y la línea se trunca por el final. Sin nada de eso no
 * se pinta nada.
 */
function RefLine({ it }: { it: RequestItem }) {
  const parts = [it.country?.name, it.title ? it.ref : null, it.email].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <span className="mt-0.5 block truncate text-xs text-muted" title={parts.join(" · ")}>
      {it.country && (
        <span>
          {flagEmoji(it.country.code)} {it.country.code}
        </span>
      )}
      {it.country && (it.title || it.email) && " · "}
      {it.title && <span className="font-mono">{it.ref}</span>}
      {it.title && it.email && " · "}
      {it.email}
    </span>
  );
}

const PUBLIC_PREFIX = "public:";

/**
 * Los intakes web llevan el prefijo `public:` (ver `startPublicIntake`), que el
 * badge de origen ya comunica. Las refs de la API son texto libre del cliente y
 * se muestran enteras: pueden contener ":" y recortarlas escondería parte.
 */
function displayRef(ref: string, api: boolean): string {
  if (api || !ref.startsWith(PUBLIC_PREFIX)) return ref;
  return ref.slice(PUBLIC_PREFIX.length);
}

/**
 * Etiqueta de los clientes dueños de las solicitudes de esta página. `api_keys`
 * no tiene políticas RLS (solo service-role), así que no se puede leer con el
 * cliente de sesión ni con un join embebido — igual que en /admin/clients.
 */
async function clientLabels(keyIds: string[]): Promise<Map<string, string>> {
  if (keyIds.length === 0) return new Map();
  const { data } = await createServiceClient()
    .from("api_keys")
    .select("id, label")
    .in("id", keyIds);
  return new Map((data ?? []).map((k) => [k.id as string, k.label as string]));
}

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{
    org?: string;
    q?: string;
    status?: string;
    form?: string;
    country?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  // Guard propio y no solo el del layout: Next los renderiza en paralelo, y
  // esta página consulta con service-role (bypassa RLS) para los labels.
  const analyst = await requireAnalyst();
  const t = await getTranslations("admin");
  const locale = await getLocale();
  const sp = await searchParams;

  // Pestaña de org: solo el admin elige; un miembro está siempre en la suya.
  const { scope, orgs } = await resolveListScope(analyst, sp.org);
  const showOrgs = analyst.role === "admin";
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  const q = (sp.q ?? "").trim();
  const status = isStatus(sp.status) ? sp.status : "";
  const form = parseFormFilter(sp.form);
  const country = normalizeIpCountry(sp.country) ?? "";
  const from = sp.from ?? "";
  const to = sp.to ?? "";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const filters = { org: showOrgs ? (scope ?? "") : "", q, status, form, country, from, to };
  const hasFilters = Boolean(q || status || form || country || from || to);

  const supabase = await createServerSupabase();
  // El formulario sale del join por `form_id` (nombre vigente). Si se eliminó,
  // `form_id` quedó a null (0020) y el título del snapshot es lo que queda.
  // Cliente de sesión: la RLS ya deja a cada miembro con lo de su org; el `eq`
  // de abajo es la pestaña del admin.
  let query = supabase
    .from("kyb_requests")
    .select(
      "id, external_ref, status, created_at, api_key_id, form_id, form_revision, org_id, subject_title, contact_email, submitted_ip_country, snapshot_title:form_definition->title, form:forms(name)",
      { count: "exact" },
    );

  if (scope) query = query.eq("org_id", scope);
  if (q) {
    // Nombre, email o referencia. Dentro de `or()` las comas, los paréntesis y
    // las comillas son sintaxis de PostgREST: se quitan del término. Si no
    // queda nada, se busca el texto tal cual solo en la referencia.
    const term = q.replace(/[,()"\\*%]/g, "").trim();
    query = term
      ? query.or(
          ["external_ref", "subject_title", "contact_email"]
            .map((col) => `${col}.ilike.*${term}*`)
            .join(","),
        )
      : query.ilike("external_ref", `%${q}%`);
  }
  if (status) query = query.eq("status", status);
  if (form === FORM_NONE) query = query.is("form_id", null);
  else if (form) query = query.eq("form_id", form);
  if (country) query = query.eq("submitted_ip_country", country);
  if (from) query = query.gte("created_at", from);
  if (to) {
    // `to` es una fecha (YYYY-MM-DD); incluir el día completo → límite exclusivo al día siguiente.
    const next = new Date(`${to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    query = query.lt("created_at", next.toISOString());
  }

  // Opciones del filtro: todos, archivados incluidos (tienen solicitudes), de
  // la misma org que la lista.
  let formsQuery = supabase.from("forms").select("id, name, status").order("name");
  if (scope) formsQuery = formsQuery.eq("org_id", scope);

  const [{ data: requests, count }, { data: formRows }] = await Promise.all([
    query.order("created_at", { ascending: false }).range(offset, offset + PAGE_SIZE - 1),
    formsQuery,
  ]);
  const formOptions: FormOption[] = (formRows ?? []).map((f) => ({
    id: f.id as string,
    name: f.name as string,
    archived: f.status === "archived",
  }));

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = (requests ?? []) as unknown as RequestRow[];
  const labels = await clientLabels([
    ...new Set(
      rows.map((r) => r.api_key_id).filter((id): id is string => Boolean(id)),
    ),
  ]);

  /**
   * Nombre del formulario (el vigente, por `form_id`) y una línea de contexto.
   * Sin join hay dos casos: se eliminó (queda el título del snapshot) o la
   * solicitud nunca tuvo formulario fijado (API antigua → el publicado por
   * defecto, que puede haber cambiado desde entonces).
   */
  function formCell(r: RequestRow): RequestItem["form"] {
    if (r.form) {
      return {
        name: r.form.name,
        meta:
          r.form_revision != null ? t("revisionShort", { n: r.form_revision }) : null,
        muted: false,
        hint: r.form.name,
      };
    }
    const snapshot = resolveText(r.snapshot_title, locale);
    if (snapshot) {
      return {
        name: snapshot,
        meta: r.form_id ? null : t("formDeleted"),
        muted: false,
        hint: snapshot,
      };
    }
    return { name: t("formDefault"), meta: null, muted: true, hint: t("formDefaultHint") };
  }

  const items: RequestItem[] = rows.map((r) => {
    const api = Boolean(r.api_key_id);
    const created = new Date(r.created_at);
    return {
      id: r.id,
      href: `/admin/requests/${r.id}`,
      status: r.status,
      ref: displayRef(r.external_ref, api),
      title: r.subject_title || null,
      email: r.contact_email || null,
      country: r.submitted_ip_country
        ? { code: r.submitted_ip_country, name: countryName(r.submitted_ip_country, locale) }
        : null,
      api,
      client: r.api_key_id ? (labels.get(r.api_key_id) ?? null) : null,
      // En una pestaña concreta la org es obvia; en "Todas" hace falta.
      org: showOrgs && !scope ? (orgName.get(r.org_id) ?? null) : null,
      form: formCell(r),
      date: created.toLocaleDateString(locale, { dateStyle: "medium" }),
      time: created.toLocaleTimeString(locale, { timeStyle: "short" }),
    };
  });

  const origin = (it: RequestItem) => (
    <span className="flex min-w-0 items-center gap-1.5">
      {it.org && (
        <span
          className="shrink-0 rounded-md bg-brand/10 px-1.5 py-0.5 text-[11px] font-medium text-brand"
          title={it.org}
        >
          {it.org}
        </span>
      )}
      <OriginBadge api={it.api} label={it.api ? t("originApi") : t("originWeb")} />
      {it.client && (
        <span className="truncate text-xs text-muted" title={it.client}>
          {it.client}
        </span>
      )}
    </span>
  );

  return (
    <main className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold text-foreground">
          {t("requestsTitle")}
        </h1>
        <p className="mt-0.5 text-sm text-muted">
          {t("resultsCount", { count: total })}
          {hasFilters && (
            <>
              <span aria-hidden> · </span>
              <Link href={clearedFilters(filters)} className="font-medium text-brand hover:underline">
                {t("clearFilters")}
              </Link>
            </>
          )}
        </p>
      </header>

      {showOrgs && (
        <OrgTabs
          orgs={orgs}
          active={scope}
          hrefFor={(orgId) => withOrg(filters, orgId ?? "")}
        />
      )}

      <RequestsToolbar current={filters} forms={formOptions} />

      {/* Container query y no breakpoint de viewport: el ancho disponible
          depende también de si el sidebar está plegado. */}
      <Card className="@container overflow-hidden">
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Inbox size={20} aria-hidden />
            </span>
            <p className="text-sm text-muted">
              {hasFilters ? t("noResults") : t("noRequests")}
            </p>
            {hasFilters && (
              <Link
                href={clearedFilters(filters)}
                className="text-sm font-medium text-brand hover:underline"
              >
                {t("clearFilters")}
              </Link>
            )}
          </div>
        ) : (
          <>
            {/* Angosto: tarjetas apiladas. Cuatro columnas no entran sin
                scroll horizontal, que en móvil nadie descubre. */}
            <ul className="divide-y divide-border @2xl:hidden">
              {items.map((it) => (
                <li key={it.id}>
                  <Link
                    href={it.href}
                    className="block px-4 py-3 outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span
                        className={`min-w-0 truncate text-sm font-medium text-foreground ${it.title ? "" : "font-mono"}`}
                        title={it.title ?? it.ref}
                      >
                        {it.title ?? it.ref}
                      </span>
                      <StatusBadge status={it.status} />
                    </span>
                    <RefLine it={it} />
                    <span className="mt-1 block">{origin(it)}</span>
                    <span className="mt-2 flex items-baseline justify-between gap-3 text-xs">
                      <span
                        className={`min-w-0 truncate ${it.form.muted ? "text-muted" : "text-foreground"}`}
                        title={it.form.hint}
                      >
                        {it.form.name}
                        {it.form.meta && <span className="text-muted"> · {it.form.meta}</span>}
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-muted">
                        {it.date} · {it.time}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto @2xl:block">
              {/* `table-fixed`: Estado y Creado tienen ancho fijo y Solicitud y
                  Formulario se reparten el resto. Un texto largo (referencia de
                  la API, cliente o formulario) se trunca con tooltip en vez de
                  empujar las otras columnas. */}
              <table className="w-full min-w-165 table-fixed text-left text-sm">
                <colgroup>
                  <col />
                  <col />
                  <col className="w-44" />
                  <col className="w-36" />
                </colgroup>
                <thead className="bg-surface-2 text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">{t("company")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("form")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("status")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("created")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <ClickableRow key={it.id} href={it.href}>
                      <td className="px-4 py-3">
                        {/* La fila entera navega, pero el enlace real es lo que
                            la hace accesible: foco por teclado y abrir en
                            pestaña nueva. */}
                        <Link
                          href={it.href}
                          title={it.title ?? it.ref}
                          className={`block truncate rounded font-medium text-foreground outline-none transition-colors hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/30 ${it.title ? "" : "font-mono"}`}
                        >
                          {it.title ?? it.ref}
                        </Link>
                        <RefLine it={it} />
                        <span className="mt-1 block">{origin(it)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`block truncate ${it.form.muted ? "text-muted" : "text-foreground"}`}
                          title={it.form.hint}
                        >
                          {it.form.name}
                        </span>
                        {it.form.meta && (
                          <span className="mt-0.5 block truncate text-xs text-muted">
                            {it.form.meta}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={it.status} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="block text-foreground">{it.date}</span>
                        <span className="mt-0.5 block text-xs text-muted">{it.time}</span>
                      </td>
                    </ClickableRow>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      {totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-between gap-2 text-sm">
          <span className="text-muted">
            {t("pageOf", { page, total: totalPages })}
          </span>
          <div className="flex gap-2">
            <PageLink
              href={requestsHref({ ...filters, page: page - 1 })}
              disabled={page <= 1}
              label={t("previous")}
              dir="prev"
            />
            <PageLink
              href={requestsHref({ ...filters, page: page + 1 })}
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
