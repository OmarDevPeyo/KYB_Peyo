import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { requireAnalyst } from "@/lib/auth/admin";
import { resolveListScope } from "@/lib/auth/tenant";
import { Card } from "@/components/ui/Card";
import { ClickableRow } from "@/components/admin/ClickableRow";
import {
  countFields,
  type FormDefinition,
  type FormStatus,
} from "@/lib/forms/definition";
import { FormsToolbar } from "./FormsToolbar";
import { OrgTabs } from "@/components/admin/OrgTabs";
import {
  ArchiveFormButton,
  DeleteFormButton,
  DuplicateFormButton,
} from "./FormRow";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  name: string;
  status: FormStatus;
  source: string;
  definition: FormDefinition;
  updated_at: string;
  org_id: string;
  system_key: string | null;
};

const BADGE: Record<FormStatus, string> = {
  published: "bg-success/15 text-success",
  draft: "bg-surface-2 text-muted",
  archived: "bg-warning/15 text-warning",
};

export default async function FormsList({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string; org?: string }>;
}) {
  // El permiso de entrar lo exige esto, sin depender de que el layout gane la
  // carrera del render.
  const analyst = await requireAnalyst();
  const t = await getTranslations("forms");
  const { archived, org } = await searchParams;
  // Los archivados son una vista aparte y no un filtro más: son justamente los
  // que el analista sacó de en medio, mezclarlos anularía el archivado.
  const showArchived = archived === "1";
  const { scope, orgs } = await resolveListScope(analyst, org);
  const isAdmin = analyst.role === "admin";
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  // Cliente de sesión: la RLS ya deja a cada miembro con los de su org; el
  // `eq` es el filtro por pestaña del admin.
  const supabase = await createServerSupabase();
  let query = supabase
    .from("forms")
    .select("id, name, status, source, definition, updated_at, org_id, system_key")
    .order("updated_at", { ascending: false });
  if (scope) query = query.eq("org_id", scope);

  const { data } = await (showArchived
    ? query.eq("status", "archived")
    : query.neq("status", "archived"));

  const forms = (data ?? []) as Row[];
  const tabHref = (orgId: string | null) => {
    const params = new URLSearchParams();
    if (showArchived) params.set("archived", "1");
    if (orgId) params.set("org", orgId);
    const qs = params.toString();
    return qs ? `/admin/forms?${qs}` : "/admin/forms";
  };

  return (
    <main className="w-full p-6">
      <h1 className="mb-4 font-display text-2xl font-bold text-foreground">
        {showArchived ? t("archivedTitle") : t("title")}
      </h1>

      {isAdmin && <OrgTabs orgs={orgs} active={scope} hrefFor={tabHref} />}

      <FormsToolbar
        showArchived={showArchived}
        orgs={isAdmin ? orgs : []}
        defaultOrg={isAdmin ? (scope ?? analyst.orgId) : ""}
        orgParam={isAdmin ? (scope ?? "") : ""}
      />

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t("colName")}</th>
                <th className="px-4 py-2.5 font-medium">{t("colStatus")}</th>
                <th className="px-4 py-2.5 font-medium">{t("colFields")}</th>
                <th className="px-4 py-2.5 font-medium">{t("colSource")}</th>
                <th className="px-4 py-2.5 font-medium">{t("colUpdated")}</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => (
                <ClickableRow key={f.id} href={`/admin/forms/${f.id}/edit`}>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/forms/${f.id}/edit`}
                      className="rounded font-medium text-foreground outline-none transition-colors hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/30"
                    >
                      {f.name}
                    </Link>
                    {f.system_key && (
                      <span
                        title={f.system_key}
                        className="ml-2 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted"
                      >
                        {t("systemBadge")}
                      </span>
                    )}
                    {/* En "Todas" hace falta saber de qué cliente es. */}
                    {isAdmin && !scope && (
                      <span className="ml-2 rounded-md bg-brand/10 px-1.5 py-0.5 text-[11px] font-medium text-brand">
                        {orgName.get(f.org_id) ?? "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[f.status] ?? BADGE.draft}`}
                    >
                      {t(f.status)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {f.definition.sections.length} · {countFields(f.definition)}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted uppercase">{f.source}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {new Date(f.updated_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <DuplicateFormButton id={f.id} name={f.name} />
                      {/* Uno del sistema se cambia con un deploy: solo se duplica. */}
                      {!f.system_key && (
                        <>
                          <ArchiveFormButton
                            id={f.id}
                            name={f.name}
                            archived={f.status === "archived"}
                          />
                          {/* Eliminar es irreversible, pero es de la org dueña:
                              el action verifica la org y los bloqueos. */}
                          <DeleteFormButton id={f.id} name={f.name} />
                        </>
                      )}
                    </div>
                  </td>
                </ClickableRow>
              ))}
              {forms.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted">
                    {showArchived ? t("emptyArchived") : t("empty")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </main>
  );
}
