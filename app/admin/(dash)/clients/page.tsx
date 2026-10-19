import { getTranslations } from "next-intl/server";
import { requireAnalyst } from "@/lib/auth/admin";
import { resolveListScope } from "@/lib/auth/tenant";
import { createServiceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { ClientsPanel, type ClientRow } from "./ClientsPanel";
import { OrgTabs } from "@/components/admin/OrgTabs";

export const dynamic = "force-dynamic";

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const analyst = await requireAnalyst();
  const t = await getTranslations("clients");
  const { scope, orgs } = await resolveListScope(analyst, (await searchParams).org);
  const isAdmin = analyst.role === "admin";
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));

  // api_keys y su uso viven en tablas solo-service-role (sin políticas RLS),
  // así que se leen con el cliente service-role y el filtro de org va acá, a
  // mano: sin él, cada cliente veía las keys de todos. NUNCA se selecciona
  // key_hash.
  const supabase = createServiceClient();
  let keysQuery = supabase
    .from("api_keys")
    .select(
      "id, label, created_at, revoked_at, last_used_at, rate_limit_per_min, allow_ai_translation, org_id",
    )
    .order("created_at", { ascending: false });
  if (scope) keysQuery = keysQuery.eq("org_id", scope);
  const { data: keys } = await keysQuery;

  // Uso solo de las keys visibles (antes se leía la tabla entera).
  const keyIds = (keys ?? []).map((k) => k.id as string);
  const { data: usage } = keyIds.length
    ? await supabase.from("api_key_usage").select("api_key_id, day, count").in("api_key_id", keyIds)
    : { data: [] };

  const today = new Date().toISOString().slice(0, 10);
  const totals = new Map<string, number>();
  const todayCounts = new Map<string, number>();
  for (const u of usage ?? []) {
    const id = u.api_key_id as string;
    totals.set(id, (totals.get(id) ?? 0) + (u.count as number));
    if (u.day === today) todayCounts.set(id, (todayCounts.get(id) ?? 0) + (u.count as number));
  }

  const rows: ClientRow[] = (keys ?? []).map((k) => ({
    id: k.id as string,
    label: k.label as string,
    createdAt: k.created_at as string,
    lastUsedAt: (k.last_used_at as string | null) ?? null,
    today: todayCounts.get(k.id as string) ?? 0,
    total: totals.get(k.id as string) ?? 0,
    rateLimit: (k.rate_limit_per_min as number | null) ?? null,
    revoked: Boolean(k.revoked_at),
    aiTranslation: k.allow_ai_translation === true,
    // En "Todas" el admin necesita saber de qué cliente es cada key.
    org: isAdmin && !scope ? (orgName.get(k.org_id as string) ?? null) : null,
  }));

  return (
    <main className="w-full p-6 xl:px-8">
      <h1 className="mb-1 font-display text-2xl font-bold text-foreground">{t("title")}</h1>
      <p className="mb-4 text-sm text-muted">{t("subtitle")}</p>
      {isAdmin && (
        <OrgTabs
          orgs={orgs}
          active={scope}
          hrefFor={(orgId) => (orgId ? `/admin/clients?org=${orgId}` : "/admin/clients")}
        />
      )}
      <ClientsPanel
        rows={rows}
        defaultLimit={env.apiRateLimitDefault()}
        isAdmin={isAdmin}
        orgs={isAdmin ? orgs : []}
        defaultOrg={isAdmin ? (scope ?? analyst.orgId) : ""}
      />
    </main>
  );
}
