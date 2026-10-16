import "server-only";
import { after } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { generateToken, hashToken } from "@/lib/tokens";
import { env } from "@/lib/env";
import { getAmlProvider } from "@/lib/aml";
import { buildAmlSubject } from "@/lib/aml/mapping";
import { dispatchDiditReviews, type DiditCheckRow } from "@/lib/didit/verify";
import { recordCheckCharge } from "@/lib/didit/costs";
import { notifyClient } from "@/lib/kyb/webhook";
import { liveDefinitionFor, resolveRequestDefinition } from "@/lib/forms/store";
import { pickRequestForm, type FormCandidate, type FormChoice } from "@/lib/forms/formChoice";
import { dropForeignFileRefs, isOwnedPath, mimeAllowed } from "@/lib/kyb/storagePaths";
import { reachableFields } from "@/lib/forms/logic";
import { formDefinitionSchema, type FormDefinition } from "@/lib/forms/definition";
import { resolveRequestSummary, type RequestSummary } from "@/lib/forms/internalFields";
import { FORM_VERSION } from "@/lib/forms/schema";
import { PRE_SUBMIT_STATUSES, acceptsApplicantWrites } from "@/lib/kyb/applicantWrites";
import type {
  KybCorrectionField,
  KybCorrections,
  KybDecision,
  KybRequest,
  KybStatus,
} from "@/lib/kyb/types";

const DEFAULT_TTL_HOURS = 24 * 14; // 14 días

/**
 * Techo del TTL del link de invitación. `POST /api/v1/kyb/requests/:id/invitation`
 * acepta un `ttl_hours` del cliente y solo exigía que fuera > 0, así que un
 * `1e15` devolvía un link que en la práctica no caduca nunca. El tope vive acá
 * y no en el handler para que valga para todos los que emiten un token.
 */
const MAX_TTL_HOURS = 24 * 90; // 90 días

function clampTtlHours(ttlHours: number | undefined): number {
  if (typeof ttlHours !== "number" || !Number.isFinite(ttlHours) || ttlHours <= 0) {
    return DEFAULT_TTL_HOURS;
  }
  return Math.min(ttlHours, MAX_TTL_HOURS);
}

export const DOCUMENTS_BUCKET = "kyb-documents";

interface AuditInput {
  requestId: string | null;
  actor: string;
  action: string;
  fromStatus?: KybStatus | null;
  toStatus?: KybStatus | null;
  metadata?: Record<string, unknown>;
  /**
   * Org del evento. Con `requestId` no hace falta: un trigger la toma de la
   * solicitud (0025). Pasarla en los eventos sin solicitud (keys, webhooks).
   */
  orgId?: string | null;
  /** Usuario del panel que actuó, si fue uno (el `actor` es texto libre). */
  actorUserId?: string | null;
}

export async function logAudit(input: AuditInput) {
  const supabase = createServiceClient();
  await supabase.from("audit_log").insert({
    request_id: input.requestId,
    actor: input.actor,
    action: input.action,
    from_status: input.fromStatus ?? null,
    to_status: input.toStatus ?? null,
    metadata: input.metadata ?? null,
    org_id: input.orgId ?? null,
    actor_user_id: input.actorUserId ?? null,
  });
}

/**
 * Formulario que usará una solicitud nueva de la org `orgId` (reglas en
 * lib/forms/formChoice.ts). Lee los candidatos y delega la decisión.
 */
export async function chooseRequestForm(input: {
  orgId: string;
  /** `form_id` que pidió el llamador, si pidió uno. */
  requestedId?: string | null;
  /** Formulario por defecto de la API key (`api_keys.default_form_id`). */
  keyDefaultId?: string | null;
}): Promise<FormChoice> {
  const supabase = createServiceClient();
  const cols = "id, org_id, status, version";
  const byId = async (id: string) =>
    ((await supabase.from("forms").select(cols).eq("id", id).maybeSingle()).data ??
      null) as FormCandidate | null;

  if (input.requestedId) {
    return pickRequestForm({
      orgId: input.orgId,
      requestedId: input.requestedId,
      requested: await byId(input.requestedId),
    });
  }

  const [keyDefault, latest] = await Promise.all([
    input.keyDefaultId ? byId(input.keyDefaultId) : null,
    supabase
      .from("forms")
      .select(cols)
      .eq("org_id", input.orgId)
      .eq("status", "published")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  return pickRequestForm({
    orgId: input.orgId,
    keyDefault,
    latestPublished: (latest.data ?? null) as FormCandidate | null,
  });
}

/** Crea una solicitud KYB y devuelve el token en claro (solo aquí). */
export async function createRequest(input: {
  /** Org dueña. Tiene que coincidir con la de la key y la del formulario (FKs de 0025). */
  orgId: string;
  externalRef: string;
  ttlHours?: number;
  /** Formulario ya elegido (ver {@link chooseRequestForm}) y su revisión vigente. */
  form: { id: string; revision: number | null };
  /** Snapshot de la definición, si el llamador la tiene (intake público). */
  formDefinition?: unknown;
  apiKeyId?: string | null;
  webhookEndpointId?: string | null;
  returnUrl?: string | null;
}): Promise<{
  id: string;
  token: string;
  invitationUrl: string;
  expiresAt: string;
}> {
  const supabase = createServiceClient();
  const token = generateToken();
  const expiresAt = new Date(
    Date.now() + clampTtlHours(input.ttlHours) * 3600 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("kyb_requests")
    .insert({
      org_id: input.orgId,
      external_ref: input.externalRef,
      invitation_token_hash: hashToken(token),
      token_expires_at: expiresAt,
      form_version: FORM_VERSION,
      status: "created",
      // Siempre fijado al crear: sin él, la solicitud mostraba el formulario
      // que fuera el default al abrirla, sin registro de cuál era.
      form_id: input.form.id,
      // Snapshot de la definición para validar el envío contra lo que el
      // solicitante realmente llenó (aunque el form se edite después).
      form_definition: input.formDefinition ?? null,
      // Revisión del formulario al crear: el cliente fija su mapeo de campos
      // contra este número (ver 0018_form_revision.sql).
      form_revision: input.form.revision,
      // Aislamiento por cliente: la solicitud pertenece a la API key que la creó.
      api_key_id: input.apiKeyId ?? null,
      webhook_endpoint_id: input.webhookEndpointId ?? null,
      return_url: input.returnUrl ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  // Fila de respuestas vacía para autosave.
  await supabase.from("kyb_form_responses").insert({
    request_id: data.id,
    data: {},
    form_version: FORM_VERSION,
  });

  await logAudit({
    requestId: data.id,
    actor: "system",
    action: "request_created",
    toStatus: "created",
    metadata: { externalRef: input.externalRef },
  });

  return {
    id: data.id as string,
    token,
    invitationUrl: `${env.appUrl()}/f/${token}`,
    expiresAt,
  };
}

/**
 * Emite un token de invitación NUEVO para una solicitud (rota el hash y el
 * vencimiento). No cambia el estado; el llamador decide la transición. Devuelve
 * el token en claro (solo aquí) y el link. Reutilizado por `reissueInvitation`
 * (re-emitir link) y `requestChanges` (ciclo de correcciones).
 */
async function issueToken(
  requestId: string,
  ttlHours = DEFAULT_TTL_HOURS,
): Promise<{ token: string; expiresAt: string; invitationUrl: string }> {
  const supabase = createServiceClient();
  const token = generateToken();
  const expiresAt = new Date(
    Date.now() + clampTtlHours(ttlHours) * 3600 * 1000,
  ).toISOString();
  await supabase
    .from("kyb_requests")
    .update({
      invitation_token_hash: hashToken(token),
      token_expires_at: expiresAt,
      // Nuevo ciclo de link → puede volver a avisar "por vencer".
      expiring_notified_at: null,
    })
    .eq("id", requestId);
  return { token, expiresAt, invitationUrl: `${env.appUrl()}/f/${token}` };
}

/**
 * Re-emite el link de invitación de una solicitud existente (conserva el
 * borrador). Útil si el cliente perdió el link o expiró. También admite
 * `changes_requested`: tras pedir correcciones (sobre todo desde el panel del
 * analista) la app externa necesita un link fresco que enviar al solicitante,
 * ya que el token solo existe en claro al emitirse. Rechaza solicitudes cerradas.
 */
export async function reissueInvitation(
  requestId: string,
  ttlHours = DEFAULT_TTL_HOURS,
): Promise<
  | { ok: true; invitationUrl: string; token: string; expiresAt: string }
  | { ok: false; error: string }
> {
  const supabase = createServiceClient();
  const { data: req } = await supabase
    .from("kyb_requests")
    .select("id, status")
    .eq("id", requestId)
    .single();
  if (!req) return { ok: false, error: "Solicitud no encontrada" };

  const status = req.status as KybStatus;
  if (!["created", "in_progress", "expired", "changes_requested"].includes(status)) {
    return {
      ok: false,
      error: "La solicitud ya fue enviada o cerrada; no admite re-emitir el link.",
    };
  }

  const { token, expiresAt, invitationUrl } = await issueToken(requestId, ttlHours);

  if (status === "expired") {
    // Reactivar: in_progress si ya había borrador, si no created.
    const { data: draft } = await supabase
      .from("kyb_form_responses")
      .select("data")
      .eq("request_id", requestId)
      .maybeSingle();
    const hasDraft =
      draft?.data && Object.keys(draft.data as Record<string, unknown>).length > 0;
    await setStatus(
      requestId,
      hasDraft ? "in_progress" : "created",
      "expired",
      "system",
      "invitation_reissued",
    );
  } else {
    await logAudit({ requestId, actor: "system", action: "invitation_reissued" });
  }

  return { ok: true, invitationUrl, token, expiresAt };
}

// Los estados "pre-envío" (PRE_SUBMIT_STATUSES, lib/kyb/applicantWrites.ts) son
// en los que el link de invitación todavía le importa al solicitante: solo esos
// se expiran por tiempo y emiten `request.expired`, y solo en esos escribe.

/**
 * Transición atómica a `expired` (compare-and-set): solo cambia si la fila sigue
 * en `fromStatus`. Devuelve `true` si ESTA llamada hizo la transición — así el
 * webhook `request.expired` se emite exactamente una vez entre la ruta perezosa
 * (`getRequestByToken`) y el barrido cron (`expireDueRequests`). Audita.
 */
async function expireRequest(
  requestId: string,
  fromStatus: KybStatus,
): Promise<boolean> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("kyb_requests")
    .update({ status: "expired" })
    .eq("id", requestId)
    .eq("status", fromStatus)
    .select("id")
    .maybeSingle();
  if (!data) return false;
  await logAudit({
    requestId,
    actor: "system",
    action: "token_expired",
    fromStatus,
    toStatus: "expired",
  });
  return true;
}

/** Resuelve una solicitud a partir del token de invitación (valida expiración). */
export async function getRequestByToken(
  token: string,
): Promise<KybRequest | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("kyb_requests")
    // Lista explícita y no `*`: esta fila la resuelve el flujo PÚBLICO por
    // token, y con `*` el `invitation_token_hash` acababa dentro del Server
    // Component de /f/[token]. Hoy nadie lo pasa al cliente, pero basta un
    // `<Comp {...req}>` para serializarlo al payload RSC.
    // En una sola línea: Supabase infiere el tipo de la fila parseando este
    // literal, y una concatenación le da `GenericStringError`.
    .select("id, external_ref, status, token_expires_at, form_version, created_at, submitted_at, decided_at, decision, decided_by, form_id, form_definition, api_key_id, callback_url, return_url, webhook_endpoint_id, corrections, decision_reason, expiring_notified_at, form_revision, org_id")
    .eq("invitation_token_hash", hashToken(token))
    .maybeSingle();

  if (!data) return null;
  const req = data as KybRequest;

  if (req.token_expires_at && new Date(req.token_expires_at) < new Date()) {
    if (req.status !== "expired" && !isTerminal(req.status)) {
      const transitioned = await expireRequest(req.id, req.status);
      // Emite el evento solo si esta llamada hizo la transición y era un estado
      // pre-envío (donde el link aún importaba). En background para no bloquear.
      if (transitioned && PRE_SUBMIT_STATUSES.includes(req.status)) {
        after(() => notifyClient(req.id, "request.expired"));
      }
    }
    return { ...req, status: "expired" };
  }
  return req;
}

/**
 * Barrido programado (cron): expira las solicitudes cuyo link ya venció y que
 * siguen esperando al solicitante (pre-envío). Devuelve los ids realmente
 * expirados para que el llamador dispare el webhook `request.expired`.
 */
export async function expireDueRequests(): Promise<string[]> {
  const supabase = createServiceClient();
  const { data: due } = await supabase
    .from("kyb_requests")
    .select("id, status")
    .lt("token_expires_at", new Date().toISOString())
    .in("status", PRE_SUBMIT_STATUSES);

  const expired: string[] = [];
  for (const row of due ?? []) {
    const ok = await expireRequest(row.id as string, row.status as KybStatus);
    if (ok) expired.push(row.id as string);
  }
  return expired;
}

/** Ventana (días) del aviso proactivo antes del vencimiento del link. */
const EXPIRING_WINDOW_DAYS = 3;

/**
 * Barrido programado (cron): avisa "por vencer" las solicitudes pre-envío cuyo
 * link vence dentro de los próximos `windowDays` y que **aún no** han sido
 * avisadas. El `UPDATE` con guard `expiring_notified_at IS NULL` es atómico y
 * garantiza **un solo aviso** por ciclo de link (se reinicia al re-emitir el
 * link en `issueToken`). Devuelve los ids para disparar `request.expiring`.
 */
export async function notifyExpiringSoonRequests(
  windowDays = EXPIRING_WINDOW_DAYS,
): Promise<string[]> {
  const supabase = createServiceClient();
  const nowIso = new Date().toISOString();
  const windowIso = new Date(Date.now() + windowDays * 86_400_000).toISOString();

  const { data } = await supabase
    .from("kyb_requests")
    .update({ expiring_notified_at: nowIso })
    .in("status", PRE_SUBMIT_STATUSES)
    .is("expiring_notified_at", null)
    .gt("token_expires_at", nowIso) // aún NO vencido → avisamos ANTES
    .lt("token_expires_at", windowIso) // dentro de la ventana
    .select("id");

  return (data ?? []).map((r) => r.id as string);
}

export function isTerminal(status: KybStatus): boolean {
  return status === "approved" || status === "rejected" || status === "expired";
}

async function setStatus(
  requestId: string,
  to: KybStatus,
  from: KybStatus,
  actor: string,
  action: string,
  extra: Record<string, unknown> = {},
) {
  const supabase = createServiceClient();
  await supabase
    .from("kyb_requests")
    .update({ status: to, ...extra })
    .eq("id", requestId);
  await logAudit({
    requestId,
    actor,
    action,
    fromStatus: from,
    toStatus: to,
  });
}

// ============================================================
// Título y email de contacto (columnas de 0029_request_summary)
// ============================================================

type SummarySource = {
  form_id?: string | null;
  form_definition?: unknown;
  org_id: string;
};

/**
 * Título y email de contacto según las respuestas (ver resolveRequestSummary).
 * `null` en solicitudes legacy, sin formulario dinámico: ahí no hay marca que
 * leer y `resolveRequestDefinition` caería a un formulario con otras claves.
 */
export async function computeRequestSummary(
  req: SummarySource,
  answers: Record<string, unknown>,
  requestDef?: FormDefinition | null,
): Promise<RequestSummary | null> {
  if (!req.form_definition && !req.form_id) return null;
  const def =
    requestDef ??
    (await resolveRequestDefinition(req.form_definition, req.form_id, req.org_id));
  if (!def) return null;
  return resolveRequestSummary(def, answers, await liveDefinitionFor(req, def));
}

function summaryColumns(s: RequestSummary) {
  return { subject_title: s.subjectTitle, contact_email: s.contactEmail };
}

/**
 * Recalcula el título y el email de TODAS las solicitudes de un formulario.
 * Se corre al cambiar su marca, y hace de backfill la primera vez. Es
 * autoritativo (puede dejar `null`) y solo escribe las filas que cambian.
 */
export async function refreshFormRequestsSummary(
  formId: string,
  liveDef: FormDefinition,
): Promise<number> {
  const supabase = createServiceClient();
  // Página chica: los ids van en la URL del `in(...)` de las respuestas.
  const PAGE = 100;
  let updated = 0;
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await supabase
      .from("kyb_requests")
      .select("id, form_definition, subject_title, contact_email")
      .eq("form_id", formId)
      .order("created_at")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!rows?.length) break;

    const { data: responses, error: respError } = await supabase
      .from("kyb_form_responses")
      .select("request_id, data")
      .in(
        "request_id",
        rows.map((r) => r.id),
      );
    if (respError) throw new Error(respError.message);
    const answersOf = new Map(
      (responses ?? []).map((r) => [r.request_id as string, (r.data ?? {}) as Record<string, unknown>]),
    );

    const changed = rows.flatMap((r) => {
      const snapshot = formDefinitionSchema.safeParse(r.form_definition);
      const s = resolveRequestSummary(
        snapshot.success ? snapshot.data : liveDef,
        answersOf.get(r.id) ?? {},
        liveDef,
      );
      return s.subjectTitle === r.subject_title && s.contactEmail === r.contact_email
        ? []
        : [{ id: r.id as string, s }];
    });
    for (let i = 0; i < changed.length; i += 20) {
      await Promise.all(
        changed.slice(i, i + 20).map(async ({ id, s }) => {
          const { error: upError } = await supabase
            .from("kyb_requests")
            .update(summaryColumns(s))
            .eq("id", id);
          if (upError) throw new Error(upError.message);
        }),
      );
    }
    updated += changed.length;
    if (rows.length < PAGE) break;
  }
  return updated;
}

/**
 * Guarda el borrador del formulario (autosave).
 *
 * `summary` (título y email ya calculados) solo RELLENA: un valor `null` no
 * borra el guardado, para que la lista no pierda el nombre mientras la persona
 * escribe o corrige. El envío es el que deja el valor definitivo.
 */
export async function saveDraft(
  requestId: string,
  data: Record<string, unknown>,
  summary?: RequestSummary | null,
) {
  const supabase = createServiceClient();
  await supabase
    .from("kyb_form_responses")
    .upsert(
      // Solo archivos de ESTA solicitud (ver dropForeignFileRefs).
      { request_id: requestId, data: dropForeignFileRefs(data, requestId), form_version: FORM_VERSION },
      { onConflict: "request_id" },
    );

  if (summary) {
    const fill = Object.fromEntries(
      Object.entries(summaryColumns(summary)).filter(([, v]) => v != null),
    );
    if (Object.keys(fill).length > 0) {
      await supabase.from("kyb_requests").update(fill).eq("id", requestId);
    }
  }

  // created -> in_progress en el primer guardado.
  const { data: req } = await supabase
    .from("kyb_requests")
    .select("status")
    .eq("id", requestId)
    .single();
  if (req?.status === "created") {
    await setStatus(requestId, "in_progress", "created", "applicant", "draft_saved");
  }
}

export async function getDraft(
  requestId: string,
): Promise<Record<string, unknown>> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("kyb_form_responses")
    .select("data")
    .eq("request_id", requestId)
    .maybeSingle();
  return (data?.data as Record<string, unknown>) ?? {};
}

/**
 * Genera URLs firmadas (temporales) para varios documentos del bucket privado.
 * Devuelve un mapa `path -> signedUrl`; omite los que fallen. Usado por el
 * detalle del request en admin para mostrar miniaturas inline.
 *
 * Solo firma paths de `requestId`: las respuestas pueden traer paths escritos
 * por el navegador (filas anteriores a `dropForeignFileRefs`), y firmar uno
 * ajeno con service-role expondría el documento de otra solicitud.
 */
export async function createSignedDocUrls(
  paths: string[],
  requestId: string,
  expiresIn = 3600,
): Promise<Record<string, string>> {
  const unique = Array.from(
    new Set(paths.filter((p) => Boolean(p) && isOwnedPath(p, requestId))),
  );
  if (unique.length === 0) return {};

  const supabase = createServiceClient();
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrls(unique, expiresIn);
  if (error || !data) return {};

  const map: Record<string, string> = {};
  for (const item of data) {
    if (item.signedUrl && item.path) map[item.path] = item.signedUrl;
  }
  return map;
}

/**
 * Tamaño y tipo REALES de un objeto ya subido, leídos de Storage.
 *
 * Cuando la subida va por signed URL (navegador → Storage directo), el server
 * nunca ve el archivo: lo único que llega es lo que el cliente dice que subió.
 * Esta es la vía para contrastarlo.
 *
 * `info()` es la API nueva; el `list()` de respaldo cubre despliegues de
 * Storage viejos, donde ese endpoint no existe y si no todas las subidas
 * quedarían rechazadas.
 */
export async function readStoredObject(
  storagePath: string,
): Promise<{ mime: string | null; size: number | null } | null> {
  const supabase = createServiceClient();

  const { data: info } = await supabase.storage.from(DOCUMENTS_BUCKET).info(storagePath);
  if (info) {
    return {
      mime: info.contentType ?? null,
      size: typeof info.size === "number" ? info.size : null,
    };
  }

  const slash = storagePath.lastIndexOf("/");
  const folder = slash >= 0 ? storagePath.slice(0, slash) : "";
  const name = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;
  const { data: listed } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .list(folder, { search: name, limit: 1 });
  const found = listed?.find((o) => o.name === name);
  if (!found) return null;

  const meta = (found.metadata ?? {}) as { size?: number; mimetype?: string };
  return {
    mime: meta.mimetype ?? null,
    size: typeof meta.size === "number" ? meta.size : null,
  };
}

/** Borra un objeto de Storage sin tocar metadatos (aún no hay fila que borrar). */
export async function deleteStoredObject(storagePath: string): Promise<void> {
  const supabase = createServiceClient();
  await supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePath]);
}

/**
 * Contrasta un archivo ya subido por signed URL con los límites de su pregunta
 * (tamaño y tipo). Es el primer y único momento en que el server puede mirarlo:
 * el mime y el tamaño se leen del objeto real, los que manda el cliente no
 * prueban nada. Si no pasa, se borra el objeto: si no, queda ocupando el bucket
 * sin ninguna fila que lo referencie, y nadie lo limpia.
 */
export async function checkStoredUpload(input: {
  path: string;
  filename: string;
  /** Configuración de archivo de la pregunta (de la definición de la solicitud). */
  file: { accept?: string[]; maxSizeMB: number } | undefined;
  /** Contexto para el log. */
  context: string;
}): Promise<{ ok: true; mime: string | null; size: number | null } | { ok: false; error: string }> {
  const stored = await readStoredObject(input.path);
  if (!stored) {
    console.warn(`[upload] ${input.context} objeto inexistente: ${input.path}`);
    return { ok: false, error: "No se encontró el archivo subido." };
  }
  const cfg = input.file;
  const maxBytes = cfg ? cfg.maxSizeMB * 1024 * 1024 : null;
  const tooBig = maxBytes != null && stored.size != null && stored.size > maxBytes;
  const badType = !mimeAllowed(cfg?.accept, stored.mime, input.filename);
  if (tooBig || badType) {
    await deleteStoredObject(input.path);
    console.warn(
      `[upload] rechazado ${input.context} mime=${stored.mime} size=${stored.size} ` +
        `tooBig=${tooBig} badType=${badType}`,
    );
    return {
      ok: false,
      error: tooBig
        ? `El archivo supera ${cfg?.maxSizeMB} MB.`
        : "Ese tipo de archivo no está permitido.",
    };
  }
  return { ok: true, mime: stored.mime, size: stored.size };
}

/** Registra los metadatos de un documento subido a Storage. */
export async function recordDocument(input: {
  requestId: string;
  docType: string;
  storagePath: string;
  filename: string;
  mime?: string | null;
  size?: number | null;
  /** Ronda de renovación a la que pertenece el archivo (document_renewals). */
  renewalId?: string | null;
}) {
  const supabase = createServiceClient();
  await supabase.from("kyb_documents").insert({
    request_id: input.requestId,
    doc_type: input.docType,
    storage_path: input.storagePath,
    filename: input.filename,
    mime: input.mime ?? null,
    size: input.size ?? null,
    ...(input.renewalId ? { renewal_id: input.renewalId } : {}),
  });
}

/** Cuándo se registró un archivo de la solicitud, o null si no tiene fila. */
export async function documentUploadedAt(
  requestId: string,
  storagePath: string,
): Promise<string | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("kyb_documents")
    .select("uploaded_at")
    .eq("request_id", requestId)
    .eq("storage_path", storagePath)
    .maybeSingle();
  return (data?.uploaded_at as string | undefined) ?? null;
}

/** Elimina un documento de Storage y su fila de metadatos. */
export async function deleteDocument(input: {
  requestId: string;
  storagePath: string;
}) {
  const supabase = createServiceClient();
  await supabase.storage.from(DOCUMENTS_BUCKET).remove([input.storagePath]);
  await supabase
    .from("kyb_documents")
    .delete()
    .eq("request_id", input.requestId)
    .eq("storage_path", input.storagePath);
}

/**
 * Foto de las respuestas en un momento que cuenta como declaración
 * (kyb_response_snapshots, 0032): cada envío y cada renovación aceptada.
 * `kyb_form_responses` se pisa; esto no, la tabla es append-only.
 */
export async function snapshotResponses(input: {
  requestId: string;
  kind: "submitted" | "renewal_accepted";
  /** submitted: ronda de correcciones que responde (null = primer envío). renewal_accepted: su ronda. */
  round: number | null;
  data: Record<string, unknown>;
  formRevision: number | null;
}): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from("kyb_response_snapshots").insert({
    request_id: input.requestId,
    kind: input.kind,
    round: input.round,
    data: input.data,
    form_revision: input.formRevision,
  });
  if (error) {
    throw new Error(`No se pudo guardar la foto de las respuestas: ${error.message}`);
  }
}

/**
 * Finaliza el formulario (parte rápida): guarda datos y pasa a `submitted`.
 * Las verificaciones (DIDIT/AML) se disparan aparte con {@link runVerifications}
 * en segundo plano para no bloquear la respuesta al usuario.
 */
export async function submitRequest(
  requestId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const supabase = createServiceClient();
  const { data: req } = await supabase
    .from("kyb_requests")
    .select("id, status, form_id, form_definition, org_id, corrections, form_revision")
    .eq("id", requestId)
    .single();
  if (!req) throw new Error("Solicitud no encontrada");
  // Una solicitud ya enviada no se reenvía por el link: lo enviado es evidencia
  // y reenviar volvería a pisar las respuestas y a pasar por `submitted`.
  if (!acceptsApplicantWrites(req.status)) throw new Error("La solicitud ya fue enviada");

  // Prune del camino inalcanzable: si el solicitante cambió una bifurcación
  // (p. ej. en el ciclo de correcciones), descarta del blob las respuestas de
  // ramas que ya no se recorren, para no persistir datos de un camino abandonado.
  // Solo en el envío (respuestas finales); NUNCA en el autosave, donde una rama
  // aún no alcanzada es legítima. Y solo para solicitudes con formulario dinámico
  // propio (snapshot o form_id): en el legacy `resolveRequestDefinition` caería al
  // form publicado por defecto —con otras keys— y borraría respuestas válidas.
  let toSave = dropForeignFileRefs(data, requestId);
  // Título y email definitivos, de las respuestas ya podadas. `null` en legacy.
  let summary: RequestSummary | null = null;
  const isDynamic =
    !!(req as { form_definition?: unknown }).form_definition ||
    !!(req as { form_id?: string | null }).form_id;
  if (isDynamic) {
    const definition = await resolveRequestDefinition(
      (req as { form_definition?: unknown }).form_definition,
      (req as { form_id?: string | null }).form_id,
      req.org_id as string,
    );
    if (definition) {
      const keep = new Set(reachableFields(definition, toSave).map((f) => f.key));
      toSave = Object.fromEntries(
        Object.entries(toSave).filter(([k]) => keep.has(k)),
      );
      summary = await computeRequestSummary(req as SummarySource, toSave, definition);
    }
  }

  await supabase
    .from("kyb_form_responses")
    .upsert(
      { request_id: requestId, data: toSave, form_version: FORM_VERSION },
      { onConflict: "request_id" },
    );

  // La foto va ANTES de pasar a `submitted`: si no se puede guardar, el envío
  // falla y el solicitante reintenta, en vez de quedar una declaración sin
  // registro. Si después pierde el compare-and-set (otro envío simultáneo), la
  // foto igual describe lo que mandó.
  const corrections = (req as { corrections?: KybCorrections | null }).corrections;
  await snapshotResponses({
    requestId,
    kind: "submitted",
    round: corrections?.round ?? null,
    data: toSave,
    formRevision: (req as { form_revision?: number | null }).form_revision ?? null,
  });

  // `corrections: null` cierra la ronda de correcciones abierta (si venía de
  // `changes_requested`); en el flujo normal ya era null.
  // Compare-and-set: dos envíos simultáneos del mismo link no pasan los dos.
  const { data: locked } = await supabase
    .from("kyb_requests")
    .update({
      status: "submitted",
      submitted_at: new Date().toISOString(),
      corrections: null,
      ...(summary ? summaryColumns(summary) : {}),
    })
    .eq("id", requestId)
    .in("status", PRE_SUBMIT_STATUSES)
    .select("id")
    .maybeSingle();
  if (!locked) throw new Error("La solicitud cambió de estado");
  await logAudit({
    requestId,
    actor: "applicant",
    action: "form_submitted",
    fromStatus: req.status,
    toStatus: "submitted",
  });
}

/**
 * Dispara las verificaciones (DIDIT real por-feature o mock) y pasa la solicitud
 * a `under_review`. Pensada para correr en segundo plano (Next `after`) después
 * de {@link submitRequest}: es idempotente (solo actúa sobre solicitudes en
 * estado `submitted`) y relee las respuestas ya persistidas.
 */
export async function runVerifications(
  requestId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const supabase = createServiceClient();
  const { data: req } = await supabase
    .from("kyb_requests")
    .select("id, status, external_ref, form_id, form_definition, org_id")
    .eq("id", requestId)
    .single();
  if (!req) {
    console.error(`[AML] request=${requestId} no encontrada; se omiten verificaciones`);
    return;
  }
  // Idempotencia: solo verificar una solicitud enviada. `force` (re-run manual del
  // admin) permite reanudar una que quedó a medias.
  if (!opts.force && req.status !== "submitted") {
    console.warn(
      `[AML] request=${requestId} estado=${req.status} (no 'submitted'); se omiten verificaciones`,
    );
    return;
  }

  const { data: responseRow } = await supabase
    .from("kyb_form_responses")
    .select("data")
    .eq("request_id", requestId)
    .maybeSingle();
  // Sin archivos de otras solicitudes: DIDIT descarga con service-role cada
  // path de las respuestas (ver dropForeignFileRefs).
  const data = dropForeignFileRefs(
    (responseRow?.data as Record<string, unknown>) ?? {},
    requestId,
  );

  // Dispara verificaciones: DIDIT real (por-feature) o mock.
  const amlProvider = env.amlProvider();
  console.log(
    `[AML] request=${requestId} provider=${amlProvider} form_id=${req.form_id ?? "null"}`,
  );
  try {
    if (amlProvider === "didit") {
      const definition = await resolveRequestDefinition(
        (req as { form_definition?: unknown }).form_definition,
        req.form_id,
        req.org_id as string,
      );
      if (!definition) {
        console.error(
          `[AML] request=${requestId} sin definición de formulario (form_id=${req.form_id ?? "null"}); no se puede verificar`,
        );
        throw new Error("No se encontró la definición del formulario para las verificaciones");
      }

      // Reanudable: no re-hacer verificaciones ya exitosas y limpiar errores
      // viejos para no acumular filas en cada reintento. Las reemplazadas por
      // una corrección no cuentan: describen la respuesta anterior, y su
      // pregunta se vuelve a verificar.
      const { data: existing } = await supabase
        .from("aml_checks")
        .select("feature, field_key, status")
        .eq("request_id", requestId)
        .eq("provider", "didit")
        .is("superseded_at", null);
      const skip = new Set<string>();
      for (const c of existing ?? []) {
        if (c.status !== "error") skip.add(`${c.feature}:${c.field_key ?? ""}`);
      }
      await supabase
        .from("aml_checks")
        .delete()
        .eq("request_id", requestId)
        .eq("provider", "didit")
        .eq("status", "error")
        .is("superseded_at", null);

      // Inserta cada verificación apenas completa (sobrevive a un corte del background).
      const insertRow = async (r: DiditCheckRow) => {
        const { data: inserted, error } = await supabase
          .from("aml_checks")
          .insert({
            request_id: requestId,
            provider: "didit",
            feature: r.feature,
            field_key: r.fieldKey,
            external_ref: r.externalRef,
            status: r.status,
            score: r.score,
            result: r.result,
          })
          .select("id")
          .single();
        if (error) {
          console.error(
            `[AML] request=${requestId} insert check (${r.feature}/${r.fieldKey ?? "-"}) falló:`,
            error.message,
          );
        }
        // El cargo va en su propio registro: una corrección puede borrar el
        // check, pero DIDIT ya lo cobró. Una fila `error` no creó sesión.
        if (r.externalRef && r.status !== "error") {
          await recordCheckCharge({
            orgId: req.org_id as string,
            requestId,
            checkId: (inserted?.id as string | undefined) ?? null,
            feature: r.feature,
            sessionId: r.externalRef,
          });
        }
      };

      const rows = await dispatchDiditReviews({
        requestId,
        externalRef: req.external_ref,
        definition,
        answers: data,
        skip,
        onRow: insertRow,
      });
      console.log(
        `[AML] request=${requestId} DIDIT: ${rows.length} verificaciones nuevas (ya hechas=${skip.size})`,
      );
      if (!rows.length && skip.size === 0) {
        console.warn(
          `[AML] request=${requestId} DIDIT no produjo checks: ninguna pregunta con revisión DIDIT fue recorrida con su archivo o dato (ver la línea "plan:")`,
        );
      }
    } else {
      // Mock: idempotente — si ya hay un check no-error, no duplicar.
      const { data: existing } = await supabase
        .from("aml_checks")
        .select("id")
        .eq("request_id", requestId)
        .neq("status", "error")
        .limit(1);
      if ((existing ?? []).length > 0) {
        console.log(`[AML] request=${requestId} ya tiene checks; se omite mock`);
      } else {
        const provider = getAmlProvider();
        const result = await provider.submitCheck({
          requestId,
          externalRef: req.external_ref,
          subject: buildAmlSubject(data),
        });
        const { error } = await supabase.from("aml_checks").insert({
          request_id: requestId,
          provider: provider.name,
          external_ref: result.externalRef,
          status: result.status,
          result: result.result ?? null,
        });
        if (error) {
          console.error(`[AML] request=${requestId} insert (${provider.name}) falló:`, error.message);
        }
      }
    }
  } catch (e) {
    console.error(
      `[AML] request=${requestId} verificación falló:`,
      e instanceof Error ? e.message : String(e),
    );
    const { error: insErr } = await supabase.from("aml_checks").insert({
      request_id: requestId,
      provider: amlProvider,
      status: "error",
      result: { error: e instanceof Error ? e.message : String(e) },
    });
    if (insErr) {
      console.error(
        `[AML] request=${requestId} no se pudo guardar la fila de error:`,
        insErr.message,
      );
    }
  }

  // Solo una solicitud enviada o en revisión pasa a revisión. Un re-run forzado
  // sobre una decidida (o devuelta para correcciones) actualiza los checks sin
  // reabrirla: antes la volvía a `under_review` y el cliente recibía
  // `verification.completed` de una solicitud ya aprobada.
  if (req.status !== "submitted" && req.status !== "under_review") return;

  await setStatus(requestId, "under_review", req.status, "system", "moved_to_review");

  // Push al cliente (si la solicitud tiene callback_url). Corre en el mismo
  // contexto background (`after`) que runVerifications; no bloquea al usuario.
  await notifyClient(requestId, "verification.completed");
}

/** Decisión del analista (approve/reject), con motivo legible opcional. */
export async function decideRequest(
  requestId: string,
  decision: KybDecision,
  analyst: { userId: string; email: string },
  reason?: string,
): Promise<void> {
  const supabase = createServiceClient();
  const { data: req } = await supabase
    .from("kyb_requests")
    .select("status")
    .eq("id", requestId)
    .single();
  if (!req) throw new Error("Solicitud no encontrada");
  if (isTerminal(req.status)) throw new Error("La solicitud ya está cerrada");

  const to: KybStatus = decision === "approved" ? "approved" : "rejected";
  const trimmedReason = reason?.trim() || null;
  await supabase
    .from("kyb_requests")
    .update({
      status: to,
      decision,
      decided_at: new Date().toISOString(),
      decided_by: analyst.userId,
      decision_reason: trimmedReason,
    })
    .eq("id", requestId);

  await logAudit({
    requestId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "decision",
    fromStatus: req.status,
    toStatus: to,
    metadata: { decision, reason: trimmedReason },
  });
}

/**
 * Devuelve una solicitud ya enviada al solicitante para que corrija preguntas
 * puntuales: quita las respuestas marcadas del blob (dejándolas disponibles de
 * nuevo, sin borrar archivos ni verificaciones), guarda el set de correcciones
 * + notas, re-emite el link y pasa a
 * `changes_requested`. Idempotente vía compare-and-set: solo actúa sobre
 * `submitted`/`under_review`. NO dispara el webhook (lo hace el llamador con
 * `after(...)`, como `decision.made`).
 */
export async function requestChanges(
  requestId: string,
  fields: { key: string; note?: string }[],
  opts: { actor: string; source: "admin" | "api"; ttlHours?: number },
): Promise<
  | { ok: true; invitationUrl: string; token: string; expiresAt: string; round: number }
  | { ok: false; error: string }
> {
  const supabase = createServiceClient();
  const { data: req } = await supabase
    .from("kyb_requests")
    .select("id, status, corrections, form_id, form_definition, org_id")
    .eq("id", requestId)
    .single();
  if (!req) return { ok: false, error: "Solicitud no encontrada" };

  const from = req.status as KybStatus;
  if (from !== "submitted" && from !== "under_review") {
    return {
      ok: false,
      error: "La solicitud no admite correcciones en su estado actual.",
    };
  }

  const definition = await resolveRequestDefinition(
    (req as { form_definition?: unknown }).form_definition,
    (req as { form_id?: string | null }).form_id,
    req.org_id as string,
  );
  if (!definition) {
    return {
      ok: false,
      error: "El formulario no soporta correcciones por-pregunta (legacy).",
    };
  }

  // Solo keys que existen en la definición; deduplicadas (primera nota gana).
  const validKeys = new Set(definition.sections.flatMap((s) => s.fields.map((f) => f.key)));
  const seen = new Set<string>();
  const marked: KybCorrectionField[] = [];
  for (const f of fields) {
    if (!validKeys.has(f.key) || seen.has(f.key)) continue;
    seen.add(f.key);
    marked.push({ key: f.key, note: f.note?.trim() ?? "" });
  }
  if (marked.length === 0) {
    return { ok: false, error: "No hay preguntas válidas para corregir." };
  }

  const prev = (req as { corrections?: KybCorrections | null }).corrections;
  const round = (prev?.round ?? 0) + 1;
  const corrections: KybCorrections = {
    round,
    requested_at: new Date().toISOString(),
    source: opts.source,
    requested_by: opts.actor,
    fields: marked,
  };

  // Compare-and-set atómico: gana un solo requestChanges/decideRequest
  // concurrente, y deja estado + correcciones consistentes de una vez.
  const { data: locked } = await supabase
    .from("kyb_requests")
    .update({ status: "changes_requested", corrections })
    .eq("id", requestId)
    .in("status", ["submitted", "under_review"])
    .select("id")
    .maybeSingle();
  if (!locked) {
    return {
      ok: false,
      error: "La solicitud cambió de estado; reintenta.",
    };
  }

  // Quita del borrador las respuestas marcadas, para que el solicitante las
  // vuelva a responder. Lo enviado NO se borra (0031): los archivos quedan en
  // Storage y en kyb_documents como versión anterior —lo vigente es lo que está
  // en las respuestas, igual que en las renovaciones— y los valores quedan en la
  // auditoría de esta ronda.
  const { data: responseRow } = await supabase
    .from("kyb_form_responses")
    .select("data")
    .eq("request_id", requestId)
    .maybeSingle();
  const answers = { ...((responseRow?.data as Record<string, unknown>) ?? {}) };
  const previous: Record<string, unknown> = {};
  for (const { key } of marked) {
    if (key in answers) previous[key] = answers[key];
    delete answers[key];
  }
  await supabase
    .from("kyb_form_responses")
    .upsert(
      { request_id: requestId, data: answers, form_version: FORM_VERSION },
      { onConflict: "request_id" },
    );

  // Re-verificar solo lo corregido: los aml_checks de esas preguntas quedan
  // reemplazados en esta ronda. Siguen como evidencia, pero dejan de ser los
  // vigentes y el reenvío vuelve a correrlos (runVerifications los ignora).
  // EXCEPTO kyb_registry: un ciclo facturado nunca se repite automáticamente —
  // la re-validación es un nuevo run manual del analista. (`or` en vez de `neq`
  // para no excluir filas con feature NULL.)
  await supabase
    .from("aml_checks")
    .update({ superseded_at: new Date().toISOString(), superseded_round: round })
    .eq("request_id", requestId)
    .in("field_key", marked.map((m) => m.key))
    .is("superseded_at", null)
    .or("feature.is.null,feature.neq.kyb_registry");

  await logAudit({
    requestId,
    actor: opts.actor,
    action: "changes_requested",
    fromStatus: from,
    toStatus: "changes_requested",
    // `previous`: lo que había en cada pregunta marcada antes de volver a
    // pedirla (en los archivos, sus referencias en Storage).
    metadata: { round, source: opts.source, fields: marked, previous },
  });

  const { token, expiresAt, invitationUrl } = await issueToken(
    requestId,
    opts.ttlHours,
  );
  return { ok: true, invitationUrl, token, expiresAt, round };
}
