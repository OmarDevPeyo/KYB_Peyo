import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { formDefinitionSchema, type FormDefinition, type FormStatus } from "./definition";

export interface FormRow {
  id: string;
  name: string;
  status: FormStatus;
  definition: FormDefinition;
  source: string;
  source_ref: string | null;
  updated_at: string;
  org_id: string;
  /** Revisión vigente (0018_form_revision.sql). */
  version: number | null;
}

const FORM_COLUMNS =
  "id, name, status, definition, source, source_ref, updated_at, org_id, version";

/**
 * Formulario PUBLICADO por id (para la ruta pública /forms/[id] y su intake).
 * Excluye los de orgs suspendidas: una org suspendida no recibe solicitudes
 * nuevas. Los links /f/[token] ya emitidos no pasan por acá y siguen andando.
 */
export async function getPublishedForm(id: string): Promise<FormRow | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("forms")
    .select(`${FORM_COLUMNS}, org:organizations!inner(disabled_at)`)
    .eq("id", id)
    .eq("status", "published")
    .is("org.disabled_at", null)
    .maybeSingle();
  return validate(data);
}

/** Formulario por id (para el solicitante; la solicitud ya lo referenció). */
export async function getFormById(id: string): Promise<FormRow | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("forms")
    .select(FORM_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return validate(data);
}

/**
 * Resuelve el formulario para una solicitud: su form_id, o el publicado por
 * defecto DE SU ORG. `orgId` es la org de la solicitud: sin él, el fallback
 * caería en el formulario de otro cliente.
 */
export async function getFormForRequest(
  formId: string | null | undefined,
  orgId: string,
): Promise<FormRow | null> {
  if (formId) {
    const byId = await getFormById(formId);
    if (byId) return byId;
  }
  return getDefaultPublishedForm(orgId);
}

/**
 * Definición contra la que operar una solicitud: prioriza el snapshot congelado
 * en la solicitud (lo que el solicitante realmente llenó) y, si no existe o es
 * inválido (solicitudes viejas, incluidas las creadas por API antes de que la
 * congelaran), cae al form vigente por id,
 * y si tampoco hay id, al publicado por defecto de la org de la solicitud.
 */
export async function resolveRequestDefinition(
  snapshot: unknown,
  formId: string | null | undefined,
  orgId: string,
): Promise<FormDefinition | null> {
  const parsed = formDefinitionSchema.safeParse(snapshot);
  if (parsed.success) return parsed.data;
  const form = await getFormForRequest(formId, orgId);
  return form?.definition ?? null;
}

/**
 * Formulario vivo de la solicitud, del que se lee la configuración de hoy
 * (roles internos, control de vencimiento). Sin copia congelada válida, la
 * definición de la solicitud ya ES el formulario vivo.
 */
export async function liveDefinitionFor(
  req: { form_id?: string | null; form_definition?: unknown },
  requestDef: FormDefinition,
): Promise<FormDefinition | null> {
  if (!req.form_id || !formDefinitionSchema.safeParse(req.form_definition).success) {
    return requestDef;
  }
  return (await getFormById(req.form_id))?.definition ?? null;
}

/** Formulario publicado por defecto de una org: el más reciente. */
export async function getDefaultPublishedForm(orgId: string): Promise<FormRow | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("forms")
    .select(FORM_COLUMNS)
    .eq("org_id", orgId)
    .eq("status", "published")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return validate(data);
}

function validate(data: unknown): FormRow | null {
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const parsed = formDefinitionSchema.safeParse(row.definition);
  if (!parsed.success) return null;
  return { ...(row as unknown as FormRow), definition: parsed.data };
}
