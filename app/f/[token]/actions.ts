"use server";

import { randomUUID } from "crypto";
import { after } from "next/server";
import {
  computeRequestSummary,
  getRequestByToken,
  saveDraft,
  submitRequest,
  runVerifications,
  recordDocument,
  readStoredObject,
  deleteStoredObject,
  deleteDocument,
  isTerminal,
  DOCUMENTS_BUCKET,
} from "@/lib/kyb/service";
import { notifyClient } from "@/lib/kyb/webhook";
import { syncRequestExpirations } from "@/lib/kyb/expirations";
import { createServiceClient } from "@/lib/supabase/service";
import { documentPath, isOwnedPath, mimeAllowed } from "@/lib/kyb/storagePaths";
import { kybSubmitSchema } from "@/lib/forms/schema";
import { resolveRequestDefinition } from "@/lib/forms/store";
import type { FormDefinition } from "@/lib/forms/definition";
import { reachableFields } from "@/lib/forms/logic";
import { buildZod } from "@/lib/forms/validation";

type ActionResult = { ok: true } | { ok: false; error: string };

type Resolved =
  | { ok: false; error: string }
  | { ok: true; req: Awaited<ReturnType<typeof getRequestByToken>> & object };

async function resolveOpen(token: string): Promise<Resolved> {
  const req = await getRequestByToken(token);
  if (!req) return { ok: false, error: "Invitación inválida." };
  if (req.status === "expired")
    return { ok: false, error: "La invitación expiró." };
  if (isTerminal(req.status))
    return { ok: false, error: "La solicitud ya fue enviada." };
  return { ok: true, req };
}

/**
 * Tope del borrador. Un formulario de verdad no llega ni de lejos; el número
 * está para que `kyb_form_responses.data` no sea un jsonb sin fondo escribible
 * por cualquiera que tenga el token.
 */
const MAX_DRAFT_BYTES = 256 * 1024;

/** Autosave del borrador. */
export async function saveDraftAction(
  token: string,
  data: Record<string, unknown>,
): Promise<ActionResult> {
  const r = await resolveOpen(token);
  if (!r.ok) return { ok: false, error: r.error };

  // Un borrador es parcial por naturaleza, así que no se pueden validar tipos
  // a mitad de carga. Lo que sí se puede es acotarlo: solo claves que el
  // formulario declara, y un tamaño máximo.
  let toSave = data;
  let definition: FormDefinition | null = null;
  const formId = (r.req as { form_id?: string | null }).form_id ?? null;
  const snapshot = (r.req as { form_definition?: unknown }).form_definition;
  // Mismo guard que `submitRequest`: en una solicitud legacy (sin snapshot ni
  // form_id) `resolveRequestDefinition` caería al formulario publicado por
  // defecto, con otras claves, y podaría respuestas válidas.
  if (snapshot || formId) {
    definition = await resolveRequestDefinition(snapshot, formId, r.req.org_id);
    if (definition) {
      const known = new Set(
        definition.sections.flatMap((s) => s.fields).map((f) => f.key),
      );
      toSave = Object.fromEntries(
        Object.entries(data).filter(([key]) => known.has(key)),
      );
    }
  }

  if (JSON.stringify(toSave).length > MAX_DRAFT_BYTES) {
    console.warn(`[saveDraftAction] borrador demasiado grande request=${r.req.id}`);
    return { ok: false, error: "El borrador es demasiado grande." };
  }

  try {
    // Título y email para la lista del panel desde el primer borrador.
    const summary = definition
      ? await computeRequestSummary(r.req, toSave, definition)
      : null;
    await saveDraft(r.req.id, toSave, summary);
    return { ok: true };
  } catch (e) {
    console.error("[saveDraftAction] falló", e);
    return { ok: false, error: "No se pudo guardar el borrador." };
  }
}

/** Sube un documento a Storage (gated por token) y guarda sus metadatos. */
export async function uploadDocumentAction(
  formData: FormData,
): Promise<ActionResult & { path?: string; filename?: string }> {
  const token = String(formData.get("token") ?? "");
  const docType = String(formData.get("docType") ?? "general");
  const file = formData.get("file");

  const r = await resolveOpen(token);
  if (!r.ok) {
    console.warn("[uploadDocumentAction] solicitud no abierta:", r.error);
    return { ok: false, error: r.error };
  }
  if (!(file instanceof File) || file.size === 0) {
    console.warn("[uploadDocumentAction] archivo inválido o vacío", {
      isFile: file instanceof File,
      size: file instanceof File ? file.size : null,
    });
    return { ok: false, error: "Archivo inválido." };
  }
  if (file.size > 15 * 1024 * 1024) {
    console.warn("[uploadDocumentAction] archivo supera 15 MB:", file.size);
    return { ok: false, error: "El archivo supera 15 MB." };
  }

  const path = documentPath(r.req.id, docType, file.name, randomUUID());

  try {
    const buffer = Buffer.from(await file.arrayBuffer());

    const supabase = createServiceClient();
    const { error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(path, buffer, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
    if (error) {
      console.error(
        `[uploadDocumentAction] storage falló (bucket "${DOCUMENTS_BUCKET}", path "${path}"):`,
        error.message,
      );
      return { ok: false, error: error.message };
    }

    await recordDocument({
      requestId: r.req.id,
      docType,
      storagePath: path,
      filename: file.name,
      mime: file.type || null,
      size: file.size,
    });

    return { ok: true, path, filename: file.name };
  } catch (e) {
    console.error("[uploadDocumentAction] falló", e);
    return { ok: false, error: "No se pudo subir el archivo." };
  }
}

/**
 * Crea una signed upload URL para subir un archivo DIRECTO a Storage desde el
 * navegador (sin el doble salto por el Server Action). El server arma el path
 * scoped a la solicitud; el cliente no puede inyectarlo.
 */
export async function createUploadUrlAction(
  token: string,
  docType: string,
  filename: string,
): Promise<ActionResult & { path?: string; uploadToken?: string }> {
  const r = await resolveOpen(token);
  if (!r.ok) return { ok: false, error: r.error };

  const path = documentPath(r.req.id, docType, filename, randomUUID());
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !data) {
      console.error("[createUploadUrlAction] falló:", error?.message);
      return { ok: false, error: error?.message ?? "No se pudo preparar la subida." };
    }
    return { ok: true, path: data.path, uploadToken: data.token };
  } catch (e) {
    console.error("[createUploadUrlAction] falló", e);
    return { ok: false, error: "No se pudo preparar la subida." };
  }
}

/**
 * Registra los metadatos de un archivo ya subido vía signed URL (gated por
 * token). Valida que el path pertenezca a esta solicitud.
 */
export async function confirmUploadAction(input: {
  token: string;
  path: string;
  docType: string;
  filename: string;
  mime?: string | null;
  size?: number | null;
}): Promise<ActionResult> {
  const r = await resolveOpen(input.token);
  if (!r.ok) return { ok: false, error: r.error };
  if (!isOwnedPath(input.path, r.req.id)) {
    return { ok: false, error: "Ruta inválida." };
  }

  // El archivo subió por signed URL, así que este es el primer y único momento
  // en que el server puede mirarlo. `input.mime`/`input.size` los manda el
  // cliente y no prueban nada: se leen del objeto real y se ignoran los suyos.
  const stored = await readStoredObject(input.path);
  if (!stored) {
    console.warn(`[confirmUploadAction] objeto inexistente: ${input.path}`);
    return { ok: false, error: "No se encontró el archivo subido." };
  }

  // Límites declarados POR CAMPO en la definición congelada de la solicitud
  // (la misma que valida el envío). Hasta ahora solo los aplicaba el navegador.
  const definition = await resolveRequestDefinition(
    (r.req as { form_definition?: unknown }).form_definition,
    (r.req as { form_id?: string | null }).form_id ?? null,
    r.req.org_id,
  );
  const cfg = definition?.sections
    .flatMap((s) => s.fields)
    .find((f) => f.key === input.docType)?.file;

  const maxBytes = cfg ? cfg.maxSizeMB * 1024 * 1024 : null;
  const tooBig = maxBytes != null && stored.size != null && stored.size > maxBytes;
  const badType = !mimeAllowed(cfg?.accept, stored.mime, input.filename);

  if (tooBig || badType) {
    // Se borra el objeto: si no, queda ocupando el bucket sin ninguna fila que
    // lo referencie, y nadie lo limpia.
    await deleteStoredObject(input.path);
    console.warn(
      `[confirmUploadAction] rechazado request=${r.req.id} campo=${input.docType} ` +
        `mime=${stored.mime} size=${stored.size} tooBig=${tooBig} badType=${badType}`,
    );
    return {
      ok: false,
      error: tooBig
        ? `El archivo supera ${cfg?.maxSizeMB} MB.`
        : "Ese tipo de archivo no está permitido.",
    };
  }

  try {
    await recordDocument({
      requestId: r.req.id,
      docType: input.docType || "general",
      storagePath: input.path,
      filename: input.filename,
      // Observado en Storage, no declarado por el cliente: el visor del panel
      // decide con este valor cómo renderizar el documento.
      mime: stored.mime,
      size: stored.size,
    });
    return { ok: true };
  } catch (e) {
    console.error("[confirmUploadAction] falló", e);
    return { ok: false, error: "No se pudo registrar el archivo." };
  }
}

/** Elimina un documento ya subido (gated por token). */
export async function deleteDocumentAction(
  token: string,
  storagePath: string,
): Promise<ActionResult> {
  const r = await resolveOpen(token);
  if (!r.ok) return { ok: false, error: r.error };
  // Solo se pueden borrar archivos que pertenecen a esta solicitud.
  if (!isOwnedPath(storagePath, r.req.id)) {
    return { ok: false, error: "Documento inválido." };
  }
  try {
    await deleteDocument({ requestId: r.req.id, storagePath });
    return { ok: true };
  } catch (e) {
    console.error("[deleteDocumentAction] falló", e);
    return { ok: false, error: "No se pudo eliminar el documento." };
  }
}

/** Envía el formulario final (valida el esquema completo). */
export async function submitAction(
  token: string,
  data: Record<string, unknown>,
): Promise<ActionResult> {
  const r = await resolveOpen(token);
  if (!r.ok) return { ok: false, error: r.error };

  const parsed = kybSubmitSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Faltan campos requeridos o hay valores inválidos.",
    };
  }

  try {
    await submitRequest(r.req.id, parsed.data);
    // Aviso inmediato al cliente de que el formulario se envió (para su correo
    // "recibimos tu solicitud"), antes de que terminen las verificaciones.
    after(() => notifyClient(r.req.id, "request.submitted"));
    // Las verificaciones (DIDIT/AML) corren en segundo plano para no bloquear
    // la respuesta; el admin lee los checks en vivo cuando estén listos.
    after(() => runVerifications(r.req.id));
    return { ok: true };
  } catch (e) {
    console.error("[submitAction] falló", e);
    return { ok: false, error: "No se pudo enviar el formulario. Intenta de nuevo." };
  }
}

/** Envío del formulario dinámico (valida contra la definición congelada del request). */
export async function submitFormAction(
  token: string,
  answers: Record<string, unknown>,
): Promise<ActionResult & { missing?: string[] }> {
  const r = await resolveOpen(token);
  if (!r.ok) return { ok: false, error: r.error };

  const formId = (r.req as { form_id?: string | null }).form_id ?? null;
  const snapshot = (r.req as { form_definition?: unknown }).form_definition;
  const definition = await resolveRequestDefinition(snapshot, formId, r.req.org_id);
  if (!definition) {
    // La UI solo monta este formulario cuando hay definición: sin ella,
    // page.tsx cae al KybForm legacy, que envía por submitAction. Llegar acá
    // significa que alguien invocó el Server Action a mano, y sin definición
    // no hay contra qué validar, así que no se persiste nada.
    console.warn(`[submitFormAction] request=${r.req.id} sin definición; rechazado`);
    return { ok: false, error: "No se pudo validar el formulario." };
  }

  const parse = buildZod(reachableFields(definition, answers)).safeParse(answers);
  if (!parse.success) {
    const missing = [
      ...new Set(
        parse.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean),
      ),
    ];
    console.warn(
      `[submitFormAction] request=${r.req.id} validación falló; campos=${missing.join(", ") || "?"}`,
    );
    return {
      ok: false,
      error: "Faltan campos requeridos o hay valores inválidos.",
      missing,
    };
  }

  try {
    // `parse.data` y no `answers`: Zod descarta las claves que el formulario no
    // declara, así que se persiste exactamente lo que se validó. Antes se
    // guardaba el objeto crudo del cliente.
    await submitRequest(r.req.id, parse.data);
    // Aviso inmediato de envío (ver submitAction). También dispara en el reenvío
    // tras corrección: la app deduplica por su propio estado si lo necesita.
    after(() => notifyClient(r.req.id, "request.submitted"));
    // Verificaciones DIDIT/AML en segundo plano (ver submitAction). Después,
    // los vencimientos: la fecha de un carnet sale del check de DIDIT.
    after(async () => {
      await runVerifications(r.req.id);
      await syncRequestExpirations(r.req.id);
    });
    return { ok: true };
  } catch (e) {
    console.error("[submitFormAction] falló", e);
    return { ok: false, error: "No se pudo enviar el formulario. Intenta de nuevo." };
  }
}
