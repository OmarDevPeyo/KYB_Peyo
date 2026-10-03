import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { liveDefinitionFor, resolveRequestDefinition } from "@/lib/forms/store";
import { formDefinitionSchema, resolveText, type FormDefinition } from "@/lib/forms/definition";
import {
  computeExpirations,
  expirationDiffers,
  expiryStatus,
  todayUtc,
  type ExpiryCheck,
  type ExpiryStatus,
  type StoredExpiration,
} from "@/lib/forms/expiry";
import { logAudit } from "@/lib/kyb/service";
import { notifyClient } from "@/lib/kyb/webhook";

// ============================================================
// Vencimiento de documentos (document_expirations, migración 0030)
// ------------------------------------------------------------
// El cálculo es puro (lib/forms/expiry.ts); acá se cargan los datos y se
// escribe solo lo que cambió. Lo llaman las acciones (envío, re-verificar,
// decidir, guardar el formulario, corregir la fecha), no runVerifications: así
// lib/kyb/service.ts no depende de este módulo.
// ============================================================

/** Columnas de `document_expirations` que lee la app. */
export const EXPIRATION_COLUMNS =
  "id, request_id, field_id, field_key, field_label, marker_source, source, auto_expires_on, expires_on, override_expires_on, override_by, override_by_email, override_at, doc_path, doc_filename, check_id, expired_notified_at, created_at, updated_at";

export interface ExpirationRecord extends StoredExpiration {
  id: string;
  request_id: string;
  field_key: string;
  field_label: unknown;
  source: "didit" | "declared" | "analyst";
  doc_filename: string | null;
  created_at: string;
  updated_at: string;
}

/** Tamaño de lote: los ids viajan en la URL del `in(...)`. */
const BATCH = 100;

type RequestRow = {
  id: string;
  form_id: string | null;
  form_definition: unknown;
  org_id: string;
};

/**
 * Recalcula los vencimientos de varias solicitudes. **Nunca lanza**: un fallo
 * acá no puede tumbar el envío ni la decisión que lo disparó; se registra y la
 * próxima sincronización lo corrige.
 *
 * `liveDefs` permite pasar formularios vivos ya cargados (el guardado del
 * builder pasa el que acaba de guardar).
 */
export async function syncExpirations(
  requestIds: string[],
  liveDefs: Map<string, FormDefinition> = new Map(),
): Promise<void> {
  const ids = [...new Set(requestIds)];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try {
      await syncBatch(batch, liveDefs);
    } catch (e) {
      console.error(
        `[expirations] no se pudo sincronizar requests=${batch.join(",")}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

export function syncRequestExpirations(requestId: string): Promise<void> {
  return syncExpirations([requestId]);
}

async function syncBatch(ids: string[], liveDefs: Map<string, FormDefinition>): Promise<void> {
  const supabase = createServiceClient();
  const [reqs, responses, checks, existing, documents] = await Promise.all([
    supabase.from("kyb_requests").select("id, form_id, form_definition, org_id").in("id", ids),
    supabase.from("kyb_form_responses").select("request_id, data").in("request_id", ids),
    // Solo la fecha: el resultado completo de DIDIT es grande y no hace falta.
    supabase
      .from("aml_checks")
      .select(
        "id, request_id, feature, field_key, status, created_at, expiration_date:result->id_verification->>expiration_date",
      )
      .in("request_id", ids)
      .eq("feature", "id_verification"),
    supabase.from("document_expirations").select(EXPIRATION_COLUMNS).in("request_id", ids),
    // Cuándo se subió cada archivo: un check de DIDIT anterior es de otro documento.
    supabase.from("kyb_documents").select("storage_path, uploaded_at").in("request_id", ids),
  ]);
  for (const r of [reqs, responses, checks, existing, documents]) {
    if (r.error) throw new Error(r.error.message);
  }

  const answersOf = new Map(
    (responses.data ?? []).map((r) => [
      r.request_id as string,
      (r.data ?? {}) as Record<string, unknown>,
    ]),
  );
  const checksOf = groupBy(
    (checks.data ?? []).map((c) => ({
      request_id: c.request_id as string,
      check: {
        id: c.id as string,
        feature: c.feature as string | null,
        field_key: c.field_key as string | null,
        status: c.status as string,
        created_at: c.created_at as string,
        result: { id_verification: { expiration_date: c.expiration_date } },
      } satisfies ExpiryCheck,
    })),
    (c) => c.request_id,
  );
  const existingOf = groupBy(
    (existing.data ?? []) as unknown as ExpirationRecord[],
    (e) => e.request_id,
  );

  const uploadedAt = new Map(
    (documents.data ?? []).map((d) => [d.storage_path as string, d.uploaded_at as string] as const),
  );
  const today = todayUtc();
  const now = new Date().toISOString();
  const upserts: Record<string, unknown>[] = [];
  const deletes: string[] = [];

  for (const req of (reqs.data ?? []) as RequestRow[]) {
    // Legacy (sin formulario dinámico): no hay marca que leer.
    if (!req.form_definition && !req.form_id) continue;
    const requestDef = await resolveRequestDefinition(req.form_definition, req.form_id, req.org_id);
    // Sin definición no se puede saber qué controlar: no se toca lo guardado.
    if (!requestDef) continue;
    const liveDef = await liveFor(req, requestDef, liveDefs);

    const stored = existingOf.get(req.id) ?? [];
    const rows = computeExpirations({
      requestDef,
      liveDef,
      answers: answersOf.get(req.id) ?? {},
      checks: (checksOf.get(req.id) ?? []).map((c) => c.check),
      existing: stored,
      today,
      uploadedAt,
    });

    const storedById = new Map(stored.map((s) => [s.field_id, s] as const));
    for (const row of rows) {
      const prev = storedById.get(row.field_id);
      if (expirationDiffers(row, prev as unknown as Record<string, unknown> | undefined)) {
        upserts.push({ ...row, request_id: req.id, updated_at: now });
      }
    }
    const keep = new Set(rows.map((r) => r.field_id));
    for (const s of stored) if (!keep.has(s.field_id)) deletes.push(s.id);
  }

  if (upserts.length) {
    const { error } = await supabase
      .from("document_expirations")
      .upsert(upserts, { onConflict: "request_id,field_id" });
    if (error) throw new Error(error.message);
  }
  if (deletes.length) {
    const { error } = await supabase.from("document_expirations").delete().in("id", deletes);
    if (error) throw new Error(error.message);
  }
}

/** Formulario vivo, cacheado por formulario dentro de una sincronización. */
async function liveFor(
  req: RequestRow,
  requestDef: FormDefinition,
  cache: Map<string, FormDefinition>,
): Promise<FormDefinition | null> {
  if (!req.form_id || !formDefinitionSchema.safeParse(req.form_definition).success) {
    return requestDef;
  }
  const hit = cache.get(req.form_id);
  if (hit) return hit;
  const live = await liveDefinitionFor(req, requestDef);
  if (live) cache.set(req.form_id, live);
  return live;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = out.get(k);
    if (list) list.push(it);
    else out.set(k, [it]);
  }
  return out;
}

/**
 * Recalcula los vencimientos de TODAS las solicitudes de un formulario. Se
 * corre al cambiar su configuración de vencimiento, y hace de backfill la
 * primera vez que se marca una pregunta.
 */
export async function refreshFormExpirations(
  formId: string,
  liveDef: FormDefinition,
): Promise<void> {
  const supabase = createServiceClient();
  const liveDefs = new Map([[formId, liveDef]]);
  for (let from = 0; ; from += BATCH) {
    const { data, error } = await supabase
      .from("kyb_requests")
      .select("id")
      .eq("form_id", formId)
      .order("created_at")
      .order("id")
      .range(from, from + BATCH - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    await syncExpirations(
      data.map((r) => r.id as string),
      liveDefs,
    );
    if (data.length < BATCH) break;
  }
}

// ============================================================
// Lectura
// ============================================================

export interface DocumentExpiration extends ExpirationRecord {
  status: ExpiryStatus;
}

/**
 * Vencimientos de una solicitud, con su estado de hoy. Service-role: el que
 * llama ya verificó que la solicitud es de su org (o es la API del cliente).
 */
export async function loadRequestExpirations(requestId: string): Promise<DocumentExpiration[]> {
  const { data } = await createServiceClient()
    .from("document_expirations")
    .select(EXPIRATION_COLUMNS)
    .eq("request_id", requestId)
    .order("created_at")
    .order("id");
  const today = todayUtc();
  return ((data ?? []) as unknown as ExpirationRecord[]).map((e) => ({
    ...e,
    status: expiryStatus(e.expires_on, today),
  }));
}

/** Forma pública (API del cliente): sin rutas de Storage ni datos del analista. */
export function publicExpirations(rows: DocumentExpiration[]) {
  return rows.map((e) => ({
    fieldId: e.field_id,
    fieldKey: e.field_key,
    label: resolveText(e.field_label as Parameters<typeof resolveText>[0]),
    expiresOn: e.expires_on,
    source: e.source,
    status: e.status,
  }));
}

// ============================================================
// Aviso `document.expired` (cron diario)
// ============================================================

/** Tope por corrida: el cron tiene `maxDuration` 60. */
const EXPIRED_SWEEP_LIMIT = 500;

/**
 * Encola `document.expired` una sola vez por documento vencido de una
 * solicitud APROBADA. Toma cada fila con compare-and-set sobre
 * `expired_notified_at` (mismo patrón que `notifyExpiringSoonRequests`), así
 * dos corridas solapadas no avisan dos veces. Solo encola: tras un backfill
 * pueden ser muchos y el drenado por minuto los entrega.
 */
export async function notifyExpiredDocuments(): Promise<number> {
  const supabase = createServiceClient();
  const { data: due, error } = await supabase
    .from("document_expirations")
    .select(
      "id, request_id, field_id, field_key, field_label, expires_on, source, req:kyb_requests!inner(status)",
    )
    .is("expired_notified_at", null)
    .lt("expires_on", todayUtc())
    .eq("req.status", "approved")
    .order("expires_on")
    .limit(EXPIRED_SWEEP_LIMIT);
  if (error) {
    console.error("[expirations] barrido de vencidos falló:", error.message);
    return 0;
  }

  let sent = 0;
  for (const row of due ?? []) {
    const { data: claimed } = await supabase
      .from("document_expirations")
      .update({ expired_notified_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("expired_notified_at", null)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    const document = {
      field_id: row.field_id,
      field_key: row.field_key,
      label: resolveText(row.field_label as Parameters<typeof resolveText>[0]),
      expires_on: row.expires_on,
      source: row.source,
    };
    await logAudit({
      requestId: row.request_id as string,
      actor: "system",
      action: "document_expired",
      metadata: { fieldKey: row.field_key, expiresOn: row.expires_on },
    });
    await notifyClient(row.request_id as string, "document.expired", {
      data: { document },
      inline: false,
    });
    sent++;
  }
  return sent;
}
