"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAnalyst } from "@/lib/auth/admin";
import { creationOrg, loadOwnedForm } from "@/lib/auth/tenant";
import { createServiceClient } from "@/lib/supabase/service";
import {
  emptyForm,
  formDefinitionSchema,
  resolveText,
} from "@/lib/forms/definition";
import { isGoogleFormExport, fromGoogleForm } from "@/lib/forms/import-google";
import { normalizeFormDefinition } from "@/lib/forms/normalize";
import { expirySignature } from "@/lib/forms/expiry";
import { revisionAfterSave } from "@/lib/forms/revision";
import { refreshFormRequestsSummary } from "@/lib/kyb/service";
import { refreshFormExpirations } from "@/lib/kyb/expirations";

/**
 * Motivo por el que se rechazó archivar/eliminar. Se devuelve como CÓDIGO (no
 * como texto ya armado) porque el panel es bilingüe: el cliente lo traduce con
 * `params`. El `error` que viaja al lado es el fallback en español, para los
 * call-sites que solo pintan el string.
 */
export type FormActionErrorCode = "assigned_to_client" | "requests_no_snapshot";

type Result =
  /** `revision`: la nueva, si guardar un formulario publicado abrió una. */
  | { ok: true; id?: string; revision?: number }
  | {
      ok: false;
      error: string;
      code?: FormActionErrorCode;
      params?: Record<string, string | number>;
    };

const FORM_ASSETS_BUCKET = "form-assets";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Cada formulario es de una org. Las acciones que reciben un `id` verifican
 * primero que sea de una org que el analista puede tocar (el admin, todas);
 * si no, responden como si el formulario no existiera.
 */
const NOT_FOUND: Result = { ok: false, error: "Formulario no encontrado." };

/**
 * `<form action={createForm}>`: el campo `org` solo lo manda el selector del
 * admin; un miembro crea siempre en su org (ver resolveCreationOrg).
 */
export async function createForm(formData?: FormData) {
  const analyst = await requireAnalyst();
  const org = await creationOrg(analyst, formData?.get("org")?.toString());
  if (!org) throw new Error("Organización inválida.");
  const def = emptyForm();
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("forms")
    .insert({
      org_id: org,
      name: resolveText(def.title, "es") || "Nuevo formulario",
      status: "draft",
      source: "manual",
      definition: def,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  redirect(`/admin/forms/${data.id}/edit`);
}

export async function saveForm(
  id: string,
  payload: { name: string; definition: unknown },
): Promise<Result> {
  const analyst = await requireAnalyst();
  const current = await loadOwnedForm(analyst, id, "id, definition, status, version");
  if (!current) return NOT_FOUND;
  const parsed = formDefinitionSchema.safeParse(payload.definition);
  if (!parsed.success) {
    return { ok: false, error: "La definición del formulario no es válida." };
  }
  // El builder ya normaliza; esto cubre a quien llame al action sin pasar por él.
  const definition = normalizeFormDefinition(parsed.data);
  const beforeDef = formDefinitionSchema.safeParse(current.definition);

  // Un cambio sobre un formulario publicado abre una revisión nueva (ver
  // lib/forms/revision.ts). Se compara contra la definición anterior pasada
  // por el mismo parse + normalizado, para que un default que Zod completa no
  // cuente como cambio.
  const version = (current.version as number | null) ?? null;
  const revision = revisionAfterSave({
    status: current.status as string,
    version,
    before: beforeDef.success ? normalizeFormDefinition(beforeDef.data) : current.definition,
    after: definition,
  });
  const supabase = createServiceClient();
  let update = supabase
    .from("forms")
    .update({
      name: payload.name?.trim() || "Formulario",
      definition,
      updated_at: new Date().toISOString(),
      ...(revision != null ? { version: revision } : {}),
    })
    .eq("id", id);
  // Compare-and-set sobre la revisión: dos guardados simultáneos no abren la
  // misma revisión con definiciones distintas.
  if (revision != null) {
    update = version == null ? update.is("version", null) : update.eq("version", version);
  }
  const { data: saved, error } = await update.select("id");
  if (error) return { ok: false, error: error.message };
  if (!saved?.length) {
    return { ok: false, error: "El formulario cambió mientras lo editabas. Recarga y vuelve a guardar." };
  }

  // Si cambió qué pregunta da el título o el email, se recalculan sus
  // solicitudes (también las anteriores: es el backfill). Un fallo acá no
  // deshace el guardado, que ya ocurrió; se reintenta en el próximo cambio.
  const before = (current.definition as { internalFields?: unknown } | null)?.internalFields;
  if (JSON.stringify(before ?? null) !== JSON.stringify(definition.internalFields ?? null)) {
    try {
      await refreshFormRequestsSummary(id, definition);
    } catch (e) {
      console.error(`[saveForm] no se pudo recalcular el título de las solicitudes form=${id}`, e);
    }
  }
  // Igual con el control de vencimiento: marcar o desmarcar un documento
  // recalcula los vencimientos de todas sus solicitudes (backfill).
  const beforeSignature = beforeDef.success ? expirySignature(beforeDef.data) : null;
  if (beforeSignature !== expirySignature(definition)) {
    try {
      await refreshFormExpirations(id, definition);
    } catch (e) {
      console.error(`[saveForm] no se pudo recalcular los vencimientos form=${id}`, e);
    }
  }
  revalidatePath("/admin/forms");
  revalidatePath(`/admin/forms/${id}/edit`);
  return revision != null ? { ok: true, revision } : { ok: true };
}

export async function setFormStatus(
  id: string,
  status: "draft" | "published",
): Promise<Result> {
  const analyst = await requireAnalyst();
  if (!(await loadOwnedForm(analyst, id))) return NOT_FOUND;
  const supabase = createServiceClient();

  // Despublicar el formulario por defecto de una key la deja sin formulario:
  // la API caería al último publicado de la org sin que nadie lo decida. Se
  // bloquea igual que archivar.
  if (status === "draft") {
    const { clients } = await formBlockers(id);
    if (clients.length > 0) return assignedToClient(clients);
  }

  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  // Al publicar, validar que la definición guardada sea correcta e incrementar
  // la revisión. Publicar es el límite natural de una revisión: es un acto
  // deliberado e infrecuente, a diferencia del guardado de borradores. El
  // cliente fija su mapeo de campos contra este número y lo recibe en
  // `form_revision` (ver 0018_form_revision.sql).
  if (status === "published") {
    const { data } = await supabase
      .from("forms")
      .select("definition, version")
      .eq("id", id)
      .maybeSingle();
    if (!formDefinitionSchema.safeParse(data?.definition).success) {
      return { ok: false, error: "El formulario no es válido para publicar." };
    }
    update.version = ((data?.version as number | null) ?? 0) + 1;
  }

  const { error } = await supabase.from("forms").update(update).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/forms");
  revalidatePath(`/admin/forms/${id}/edit`);
  return { ok: true };
}

export async function duplicateForm(id: string) {
  const analyst = await requireAnalyst();
  const data = await loadOwnedForm(analyst, id, "name, source, source_ref, definition");
  if (!data) throw new Error("Formulario no encontrado.");
  const parsed = formDefinitionSchema.safeParse(data.definition);
  if (!parsed.success) {
    throw new Error("La definición del formulario no es válida.");
  }
  const supabase = createServiceClient();
  const { data: created, error: insertError } = await supabase
    .from("forms")
    .insert({
      // La copia queda en la org del original, no en la de quien duplica (el
      // admin duplicando el formulario de un cliente se lo deja al cliente).
      org_id: data.org_id,
      name: `${data.name} (copia)`,
      status: "draft",
      source: data.source,
      source_ref: data.source_ref,
      definition: normalizeFormDefinition(parsed.data),
    })
    .select("id")
    .single();
  if (insertError) throw new Error(insertError.message);
  revalidatePath("/admin/forms");
  redirect(`/admin/forms/${created.id}/edit`);
}

// ============================================================
// Archivar / eliminar
// ============================================================

/**
 * Quién depende de este formulario. Ver `formUsage` para la versión pública.
 * No hace falta filtrar por org: las FKs compuestas de 0025 impiden que una
 * key o una solicitud de otra org apunte a este formulario, así que todo lo
 * que devuelve es de su misma org.
 */
async function formBlockers(id: string) {
  const supabase = createServiceClient();
  const [keys, all, orphans] = await Promise.all([
    // Nulificar `default_form_id` rompería la integración del cliente sin aviso
    // (es el KYB_FORM_ID que tiene configurado), así que bloquea.
    supabase.from("api_keys").select("label, key_prefix").eq("default_form_id", id),
    supabase
      .from("kyb_requests")
      .select("id", { count: "exact", head: true })
      .eq("form_id", id),
    // Sin snapshot, la solicitud depende del `form_id` para saber qué se llenó:
    // si el formulario desaparece, `getFormForRequest` cae en silencio al último
    // publicado —con otras keys— y el detalle deja de corresponder.
    //
    // Cubre el caso real (columna NULL: solicitudes previas a 0007 y las creadas
    // por API sin formulario). Un snapshot presente pero inválido para el schema
    // también caería al fallback, pero detectarlo exigiría parsear fila por fila
    // y ese riesgo ya existe hoy, con o sin borrado.
    supabase
      .from("kyb_requests")
      .select("id", { count: "exact", head: true })
      .eq("form_id", id)
      .is("form_definition", null),
  ]);
  const clients = (keys.data ?? []).map(
    (k) => (k.label as string | null) || (k.key_prefix as string | null) || "—",
  );
  return {
    clients,
    requests: all.count ?? 0,
    requestsWithoutSnapshot: orphans.count ?? 0,
  };
}

export interface FormUsage {
  /** Etiquetas de los clientes que lo tienen asignado por defecto. */
  clients: string[];
  /** Solicitudes que quedarían desvinculadas (`form_id` a null). */
  requests: number;
  /** De esas, las que perderían su definición. Cualquier valor > 0 bloquea. */
  requestsWithoutSnapshot: number;
  canDelete: boolean;
}

/**
 * Qué pasaría si se elimina. Lo pide la UI ANTES de confirmar, para que el
 * cuadro de diálogo diga cuántas solicitudes se van a desvincular en vez de
 * pedir una confirmación a ciegas.
 */
export async function formUsage(id: string): Promise<FormUsage> {
  const analyst = await requireAnalyst();
  if (!(await loadOwnedForm(analyst, id))) {
    return { clients: [], requests: 0, requestsWithoutSnapshot: 0, canDelete: false };
  }
  const b = await formBlockers(id);
  return {
    ...b,
    canDelete: b.clients.length === 0 && b.requestsWithoutSnapshot === 0,
  };
}

/**
 * Archiva (o desarchiva) un formulario. Es la salida reversible y la que puede
 * usar cualquier analista.
 *
 * Archivar un formulario PUBLICADO lo saca de `getPublishedForm`, así que para
 * un cliente que lo tenga asignado el efecto es el mismo que borrarlo: se
 * bloquea igual que el borrado.
 */
export async function archiveForm(id: string, archived: boolean): Promise<Result> {
  const analyst = await requireAnalyst();
  if (!(await loadOwnedForm(analyst, id))) return NOT_FOUND;

  if (archived) {
    const { clients } = await formBlockers(id);
    if (clients.length > 0) return assignedToClient(clients);
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("forms")
    .update({
      // Desarchivar devuelve a BORRADOR, nunca directo a publicado: publicar es
      // un acto deliberado que incrementa la revisión (ver `setFormStatus`).
      status: archived ? "archived" : "draft",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/forms");
  revalidatePath(`/admin/forms/${id}/edit`);
  return { ok: true };
}

/**
 * Borrado definitivo. Es irreversible y se lleva las traducciones del
 * formulario con él (viven dentro de `definition`). Lo puede hacer la org
 * dueña (antes era solo del admin, cuando el panel era de un único equipo);
 * los bloqueos de abajo impiden romper una integración o una solicitud.
 *
 * Ya no redirige ni lanza: devuelve el motivo para que la UI lo muestre. La
 * versión anterior hacía `throw` dentro de un `<form action>`, así que cualquier
 * formulario referenciado —o sea, cualquiera que se hubiera usado— moría con un
 * error genérico de Next.
 */
export async function deleteForm(id: string): Promise<Result> {
  const analyst = await requireAnalyst();
  if (!(await loadOwnedForm(analyst, id))) return NOT_FOUND;

  const { clients, requestsWithoutSnapshot } = await formBlockers(id);
  if (clients.length > 0) return assignedToClient(clients);
  if (requestsWithoutSnapshot > 0) {
    return {
      ok: false,
      code: "requests_no_snapshot",
      params: { count: requestsWithoutSnapshot },
      error:
        `${requestsWithoutSnapshot} solicitud(es) dependen de este formulario y no ` +
        "guardan copia de su definición. Archivalo en vez de eliminarlo.",
    };
  }

  const supabase = createServiceClient();
  // Las solicitudes con snapshot quedan con `form_id` a null (0020) y siguen
  // resolviendo su definición desde el snapshot.
  const { error } = await supabase.from("forms").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/forms");
  return { ok: true };
}

function assignedToClient(clients: string[]): Result {
  const list = clients.join(", ");
  return {
    ok: false,
    code: "assigned_to_client",
    params: { clients: list },
    error: `Este formulario está asignado a ${list}. Reasigná ese cliente primero.`,
  };
}

/** `orgId`: solo lo usa el admin (selector de org); un miembro importa en la suya. */
export async function importFormJson(json: string, orgId?: string | null): Promise<Result> {
  const analyst = await requireAnalyst();
  const org = await creationOrg(analyst, orgId);
  if (!org) return { ok: false, error: "Organización inválida." };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: "JSON inválido." };
  }

  // Auto-detección: nuestro FormDefinition, o export de Google Forms.
  let parsed = formDefinitionSchema.safeParse(raw);
  if (!parsed.success && isGoogleFormExport(raw)) {
    parsed = formDefinitionSchema.safeParse(fromGoogleForm(raw));
    if (!parsed.success) {
      return { ok: false, error: "No se pudo convertir el formulario de Google Forms." };
    }
  }
  if (!parsed.success) {
    return {
      ok: false,
      error: "Formato no reconocido: usa nuestro JSON de formulario o un export de Google Forms.",
    };
  }
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("forms")
    .insert({
      org_id: org,
      name: resolveText(parsed.data.title, "es") || "Formulario importado",
      status: "draft",
      source: "manual",
      definition: normalizeFormDefinition(parsed.data),
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  redirect(`/admin/forms/${data.id}/edit`);
}

/**
 * Sube una imagen de ayuda (pregunta/opción) al bucket público `form-assets`
 * y devuelve su URL pública. Solo analistas.
 */
export async function uploadFormImageAction(
  formData: FormData,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requireAnalyst();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "invalid" };
  }
  if (!file.type.startsWith("image/")) {
    return { ok: false, error: "type" };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: "size" };
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `help/${randomUUID()}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const supabase = createServiceClient();
  const { error } = await supabase.storage
    .from(FORM_ASSETS_BUCKET)
    .upload(path, buffer, {
      contentType: file.type || "image/*",
      upsert: false,
    });
  if (error) return { ok: false, error: error.message };

  const { data } = supabase.storage.from(FORM_ASSETS_BUCKET).getPublicUrl(path);
  return { ok: true, url: data.publicUrl };
}
