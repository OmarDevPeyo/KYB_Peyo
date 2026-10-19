"use server";

import { randomUUID } from "crypto";
import { after } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  checkStoredUpload,
  deleteDocument,
  recordDocument,
  DOCUMENTS_BUCKET,
} from "@/lib/kyb/service";
import {
  resolveRenewal,
  runRenewalVerifications,
  saveRenewalDraft,
  submitRenewal,
} from "@/lib/kyb/renewals";
import { documentPath, dropForeignFileRefs, isOwnedPath } from "@/lib/kyb/storagePaths";
import { buildZod } from "@/lib/forms/validation";
import { fileRefsOf } from "@/lib/forms/answers";
import { parseExpiryDate, todayUtc } from "@/lib/forms/expiry";
import { clientCountry } from "@/lib/request/clientCountry";
import type { Field } from "@/lib/forms/definition";

// ============================================================
// Formulario de renovación (link de document_renewals)
// ------------------------------------------------------------
// Todas las acciones pasan por `resolveRenewal`: ronda `requested`, link
// vigente y solicitud aprobada. Solo se aceptan las keys de la ronda, y nada
// se escribe en las respuestas aprobadas: lo enviado queda en la ronda hasta
// que el analista acepta.
// ============================================================

type ActionResult = { ok: true } | { ok: false; error: string };

/** Mismo tope que el borrador del formulario (app/f/[token]/actions.ts). */
const MAX_DRAFT_BYTES = 256 * 1024;

async function gate(token: string) {
  const g = await resolveRenewal(token);
  if (!g) return { ok: false as const, error: "Link inválido." };
  if (!g.ok) return { ok: false as const, error: g.error };
  return g;
}

function onlyKeys(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const allowed = new Set(keys);
  return Object.fromEntries(Object.entries(data).filter(([k]) => allowed.has(k)));
}

/** Pregunta de archivo de la ronda (la renovación no sube nada más). */
function fileField(fields: Field[], key: string): Field | null {
  const f = fields.find((x) => x.key === key);
  return f && (f.type === "file" || f.type === "selfie") ? f : null;
}

export async function saveRenewalDraftAction(
  token: string,
  data: Record<string, unknown>,
): Promise<ActionResult> {
  const g = await gate(token);
  if (!g.ok) return g;
  const toSave = dropForeignFileRefs(onlyKeys(data, g.renewal.keys), g.req.id);
  if (JSON.stringify(toSave).length > MAX_DRAFT_BYTES) {
    return { ok: false, error: "El borrador es demasiado grande." };
  }
  return (await saveRenewalDraft(g.renewal.id, toSave))
    ? { ok: true }
    : { ok: false, error: "No se pudo guardar el borrador." };
}

export async function createRenewalUploadUrlAction(
  token: string,
  docType: string,
  filename: string,
): Promise<ActionResult & { path?: string; uploadToken?: string }> {
  const g = await gate(token);
  if (!g.ok) return g;
  if (!fileField(g.renewalDef.sections[0].fields, docType)) {
    return { ok: false, error: "Pregunta inválida." };
  }
  const path = documentPath(g.req.id, docType, filename, randomUUID());
  const { data, error } = await createServiceClient()
    .storage.from(DOCUMENTS_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    console.error("[createRenewalUploadUrlAction] falló:", error?.message);
    return { ok: false, error: "No se pudo preparar la subida." };
  }
  return { ok: true, path: data.path, uploadToken: data.token };
}

export async function confirmRenewalUploadAction(input: {
  token: string;
  path: string;
  docType: string;
  filename: string;
}): Promise<ActionResult> {
  const g = await gate(input.token);
  if (!g.ok) return g;
  if (!isOwnedPath(input.path, g.req.id)) return { ok: false, error: "Ruta inválida." };
  const field = fileField(g.renewalDef.sections[0].fields, input.docType);
  if (!field) return { ok: false, error: "Pregunta inválida." };

  const stored = await checkStoredUpload({
    path: input.path,
    filename: input.filename,
    file: field.file,
    context: `request=${g.req.id} renovación=${g.renewal.round} campo=${input.docType}`,
  });
  if (!stored.ok) return stored;

  try {
    await recordDocument({
      requestId: g.req.id,
      docType: input.docType,
      storagePath: input.path,
      filename: input.filename,
      mime: stored.mime,
      size: stored.size,
      renewalId: g.renewal.id,
    });
    return { ok: true };
  } catch (e) {
    console.error("[confirmRenewalUploadAction] falló", e);
    return { ok: false, error: "No se pudo registrar el archivo." };
  }
}

/** Solo se borra lo subido en esta ronda: los documentos anteriores son historial. */
export async function deleteRenewalDocumentAction(
  token: string,
  storagePath: string,
): Promise<ActionResult> {
  const g = await gate(token);
  if (!g.ok) return g;
  if (!isOwnedPath(storagePath, g.req.id)) return { ok: false, error: "Documento inválido." };
  const { data } = await createServiceClient()
    .from("kyb_documents")
    .select("id")
    .eq("request_id", g.req.id)
    .eq("renewal_id", g.renewal.id)
    .eq("storage_path", storagePath)
    .maybeSingle();
  if (!data) return { ok: false, error: "Documento inválido." };
  try {
    await deleteDocument({ requestId: g.req.id, storagePath });
    return { ok: true };
  } catch (e) {
    console.error("[deleteRenewalDocumentAction] falló", e);
    return { ok: false, error: "No se pudo eliminar el documento." };
  }
}

export async function submitRenewalAction(
  token: string,
  answers: Record<string, unknown>,
): Promise<ActionResult & { missing?: string[] }> {
  const g = await gate(token);
  if (!g.ok) return g;
  const fields = g.renewalDef.sections[0].fields;
  const data = dropForeignFileRefs(onlyKeys(answers, g.renewal.keys), g.req.id);

  const parse = buildZod(fields).safeParse(data);
  if (!parse.success) {
    const missing = [
      ...new Set(parse.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean)),
    ];
    return { ok: false, error: "Faltan campos requeridos o hay valores inválidos.", missing };
  }

  // Cada archivo tiene que ser de esta ronda: reenviar el documento vencido
  // (su ruta sigue en las respuestas aprobadas) no es renovarlo.
  const paths = fields.flatMap((f) =>
    f.type === "file" || f.type === "selfie" ? fileRefsOf(parse.data[f.key]).map((r) => r.path) : [],
  );
  if (paths.length) {
    const { data: rows } = await createServiceClient()
      .from("kyb_documents")
      .select("storage_path")
      .eq("request_id", g.req.id)
      .eq("renewal_id", g.renewal.id)
      .in("storage_path", paths);
    const known = new Set((rows ?? []).map((r) => r.storage_path as string));
    const stale = fields.filter(
      (f) => fileRefsOf(parse.data[f.key]).some((r) => !known.has(r.path)),
    );
    if (stale.length) {
      return {
        ok: false,
        error: "Sube el documento nuevo.",
        missing: stale.map((f) => f.key),
      };
    }
  }

  // Una fecha de vencimiento que ya pasó no renueva nada.
  const today = todayUtc();
  const pastDates = fields.filter((f) => {
    if (f.type !== "date") return false;
    const d = parseExpiryDate(parse.data[f.key]);
    return !d || d < today;
  });
  if (pastDates.length) {
    return {
      ok: false,
      error: "La fecha de vencimiento ya pasó.",
      missing: pastDates.map((f) => f.key),
    };
  }

  if (!(await submitRenewal(g.renewal, parse.data, { ipCountry: await clientCountry() }))) {
    return { ok: false, error: "La renovación ya fue enviada." };
  }
  // Los documentos con fecha de DIDIT se vuelven a verificar en segundo plano.
  after(() => runRenewalVerifications(g.renewal.id));
  return { ok: true };
}
