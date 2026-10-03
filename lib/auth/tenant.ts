import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import type { Analyst } from "./admin";
import {
  canAccessOrg,
  isUuid,
  resolveCreationOrg,
  resolveOrgScope,
} from "./tenantRules";

/**
 * Carga de recursos con verificación de dueño.
 *
 * El panel escribe (y parte lee) con service-role, que ignora RLS. Cada Server
 * Action recibe ids del cliente —es un POST que cualquiera puede armar a mano—,
 * así que ANTES de tocar un recurso hay que resolver de qué org es y si el
 * analista puede operar sobre ella. Estos loaders hacen las dos cosas.
 *
 * Todos devuelven `null` tanto si el recurso no existe como si es de otra org:
 * el que llama responde "no encontrado" y así no se revela que existe.
 */

type Row = Record<string, unknown>;

async function loadOwned(
  analyst: Analyst,
  table: "kyb_requests" | "forms" | "api_keys",
  id: string,
  columns: string,
): Promise<Row | null> {
  if (!isUuid(id)) return null;
  const { data } = await createServiceClient()
    .from(table)
    .select(`org_id, ${columns}`)
    .eq("id", id)
    .maybeSingle();
  const row = data as Row | null;
  if (!row || !canAccessOrg(analyst, row.org_id as string)) return null;
  return row;
}

export function loadOwnedRequest(analyst: Analyst, id: string, columns = "id") {
  return loadOwned(analyst, "kyb_requests", id, columns);
}

export function loadOwnedForm(analyst: Analyst, id: string, columns = "id") {
  return loadOwned(analyst, "forms", id, columns);
}

export function loadOwnedApiKey(analyst: Analyst, id: string, columns = "id") {
  return loadOwned(analyst, "api_keys", id, columns);
}

/** Primer elemento de un embed to-one (PostgREST lo tipa como array). */
function one<T>(value: T | T[] | null | undefined): T | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/**
 * Endpoint de webhook, que pertenece a la org de su API key. Si se pasa
 * `apiKeyId`, además exige que el endpoint sea de ESA key: la acción recibe los
 * dos ids y antes solo usaba el de la key para revalidar la página.
 */
export async function loadOwnedEndpoint(
  analyst: Analyst,
  endpointId: string,
  apiKeyId?: string,
): Promise<{ id: string; api_key_id: string; org_id: string } | null> {
  if (!isUuid(endpointId)) return null;
  const { data } = await createServiceClient()
    .from("webhook_endpoints")
    .select("id, api_key_id, key:api_keys!inner(org_id)")
    .eq("id", endpointId)
    .maybeSingle();
  if (!data) return null;
  const orgId = one(data.key as { org_id: string } | { org_id: string }[])?.org_id;
  if (!canAccessOrg(analyst, orgId)) return null;
  if (apiKeyId !== undefined && data.api_key_id !== apiKeyId) return null;
  return { id: data.id as string, api_key_id: data.api_key_id as string, org_id: orgId! };
}

/** Entrega de webhook: entrega → endpoint → key → org. */
export async function loadOwnedDelivery(
  analyst: Analyst,
  deliveryId: string,
  apiKeyId?: string,
): Promise<{ id: string; api_key_id: string; org_id: string } | null> {
  if (!isUuid(deliveryId)) return null;
  const { data } = await createServiceClient()
    .from("webhook_deliveries")
    .select("id, endpoint:webhook_endpoints!inner(api_key_id, key:api_keys!inner(org_id))")
    .eq("id", deliveryId)
    .maybeSingle();
  if (!data) return null;
  const endpoint = one(
    data.endpoint as
      | { api_key_id: string; key: { org_id: string } | { org_id: string }[] }
      | { api_key_id: string; key: { org_id: string } | { org_id: string }[] }[],
  );
  const orgId = one(endpoint?.key)?.org_id;
  if (!endpoint || !canAccessOrg(analyst, orgId)) return null;
  if (apiKeyId !== undefined && endpoint.api_key_id !== apiKeyId) return null;
  return { id: data.id as string, api_key_id: endpoint.api_key_id, org_id: orgId! };
}

/** Check de verificación (aml_checks), que es de la org de su solicitud. */
export async function loadOwnedCheck(
  analyst: Analyst,
  checkId: string,
  columns = "id",
): Promise<Row | null> {
  if (!isUuid(checkId)) return null;
  const { data } = await createServiceClient()
    .from("aml_checks")
    .select(`request_id, ${columns}, req:kyb_requests!inner(org_id)`)
    .eq("id", checkId)
    .maybeSingle();
  const row = data as Row | null;
  if (!row) return null;
  const orgId = one(row.req as { org_id: string } | { org_id: string }[])?.org_id;
  return canAccessOrg(analyst, orgId) ? row : null;
}

/** Vencimiento de un documento (document_expirations), de la org de su solicitud. */
export async function loadOwnedExpiration(
  analyst: Analyst,
  expirationId: string,
  columns = "id",
): Promise<Row | null> {
  if (!isUuid(expirationId)) return null;
  const { data } = await createServiceClient()
    .from("document_expirations")
    .select(`request_id, ${columns}, req:kyb_requests!inner(org_id, status)`)
    .eq("id", expirationId)
    .maybeSingle();
  const row = data as Row | null;
  if (!row) return null;
  const orgId = one(row.req as { org_id: string } | { org_id: string }[])?.org_id;
  return canAccessOrg(analyst, orgId) ? row : null;
}

/**
 * Documento por su clave de Storage. Solo se firman claves registradas en
 * `kyb_documents` de una solicitud de la org del analista.
 */
export async function loadOwnedDocPath(
  analyst: Analyst,
  path: string,
): Promise<{ request_id: string; storage_path: string } | null> {
  if (!path) return null;
  const { data } = await createServiceClient()
    .from("kyb_documents")
    .select("request_id, storage_path, req:kyb_requests!inner(org_id)")
    .eq("storage_path", path)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const orgId = one(data.req as { org_id: string } | { org_id: string }[])?.org_id;
  if (!canAccessOrg(analyst, orgId)) return null;
  return { request_id: data.request_id as string, storage_path: data.storage_path as string };
}

export interface OrgOption {
  id: string;
  slug: string;
  name: string;
  disabled: boolean;
}

/** Todas las organizaciones, para las pestañas y selectores del admin. */
export async function listOrgs(): Promise<OrgOption[]> {
  const { data } = await createServiceClient()
    .from("organizations")
    .select("id, slug, name, disabled_at")
    .order("name");
  return (data ?? []).map((o) => ({
    id: o.id as string,
    slug: o.slug as string,
    name: o.name as string,
    disabled: Boolean(o.disabled_at),
  }));
}

/**
 * Filtro de org de un listado a partir de `?org=`. Para un miembro es siempre
 * su org (y no hace falta leer la lista); el admin puede elegir una o ver todas
 * (`scope: null`). `orgs` viene lleno solo para el admin, que es quien ve las
 * pestañas.
 */
export async function resolveListScope(
  analyst: Analyst,
  param: string | null | undefined,
): Promise<{ scope: string | null; orgs: OrgOption[] }> {
  if (analyst.role !== "admin") return { scope: analyst.orgId, orgs: [] };
  const orgs = await listOrgs();
  return {
    scope: resolveOrgScope(analyst, param, orgs.map((o) => o.id)),
    orgs,
  };
}

/**
 * Org donde crear un recurso de primer nivel. `null` = el admin pidió una org
 * que no existe; el que llama responde un error en vez de crearlo en otra.
 */
export async function creationOrg(
  analyst: Analyst,
  requested: string | null | undefined,
): Promise<string | null> {
  if (analyst.role !== "admin") return analyst.orgId;
  const orgs = await listOrgs();
  return resolveCreationOrg(
    analyst,
    requested,
    orgs.filter((o) => !o.disabled).map((o) => o.id),
  );
}
