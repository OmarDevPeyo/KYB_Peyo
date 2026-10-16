import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { generateToken, hashToken } from "@/lib/tokens";
import { env } from "@/lib/env";
import { liveDefinitionFor, resolveRequestDefinition } from "@/lib/forms/store";
import type { FormDefinition, LocalizedText } from "@/lib/forms/definition";
import { renewalDefinition, renewalFieldKeys } from "@/lib/forms/expiry";
import { dispatchDiditReviews, type DiditCheckRow } from "@/lib/didit/verify";
import { recordCheckCharge } from "@/lib/didit/costs";
import { logAudit, snapshotResponses } from "@/lib/kyb/service";
import { notifyClient } from "@/lib/kyb/webhook";
import { loadRequestExpirations, syncRequestExpirations } from "@/lib/kyb/expirations";

// ============================================================
// Rondas de renovación de documentos (document_renewals, migración 0030)
// ------------------------------------------------------------
// Una ronda pide al solicitante de una solicitud APROBADA que vuelva a subir
// documentos vencidos. Tiene su propio token (no toca el link de invitación) y
// lo que sube queda retenido en la ronda hasta que el analista acepta; recién
// ahí pasa a las respuestas. La solicitud no cambia de estado en ningún paso.
//
//   sending → requested → submitted → accepted | rejected
//      ↘ failed (el correo no salió)   ↘ cancelled (reemplazada o cancelada)
// ============================================================

export const RENEWAL_TTL_HOURS_DEFAULT = 14 * 24;
const RENEWAL_TTL_HOURS_MAX = 90 * 24;

/** Columnas que lee la app: todas menos `token_hash` (ver los grants de 0030). */
export const RENEWAL_COLUMNS =
  "id, request_id, round, state, fields, keys, locale, email_to, email_note, email_message_id, email_sent_at, email_error, token_expires_at, answers, checks, requested_by, requested_by_email, submitted_at, reviewed_by, reviewed_by_email, reviewed_at, review_note, created_at, updated_at";

export type RenewalState =
  | "sending"
  | "requested"
  | "submitted"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "failed";

export type RenewalLocale = "es" | "en";

export interface RenewalField {
  fieldId: string;
  fieldKey: string;
  label: LocalizedText;
  expiresOn: string | null;
  marker: "didit" | "date_field";
  keys: string[];
}

export interface RenewalRow {
  id: string;
  request_id: string;
  round: number;
  state: RenewalState;
  fields: RenewalField[];
  keys: string[];
  locale: RenewalLocale;
  email_to: string | null;
  email_note: string | null;
  email_message_id: string | null;
  email_sent_at: string | null;
  email_error: string | null;
  token_expires_at: string | null;
  answers: Record<string, unknown>;
  checks: DiditCheckRow[] | null;
  requested_by: string | null;
  requested_by_email: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_by_email: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

/** Título de la sección que ve el solicitante. */
export const RENEWAL_SECTION_TITLE: LocalizedText = {
  es: "Actualizar documentos",
  en: "Update documents",
};

export function renewalUrl(token: string): string {
  return `${env.appUrl()}/f/${token}`;
}

type Actor = { userId: string; email: string };

type RequestCtx = {
  id: string;
  status: string;
  org_id: string;
  external_ref: string;
  form_id: string | null;
  form_definition: unknown;
};

const REQUEST_COLUMNS = "id, status, org_id, external_ref, form_id, form_definition";

/** Respuestas guardadas de la solicitud. */
async function answersOf(requestId: string): Promise<Record<string, unknown>> {
  const { data } = await createServiceClient()
    .from("kyb_form_responses")
    .select("data")
    .eq("request_id", requestId)
    .maybeSingle();
  return (data?.data as Record<string, unknown>) ?? {};
}

/** Rondas de una solicitud, la más nueva primero. */
export async function loadRenewals(requestId: string): Promise<RenewalRow[]> {
  const { data } = await createServiceClient()
    .from("document_renewals")
    .select(RENEWAL_COLUMNS)
    .eq("request_id", requestId)
    .order("round", { ascending: false });
  return (data ?? []) as unknown as RenewalRow[];
}

export async function loadRenewal(renewalId: string): Promise<RenewalRow | null> {
  const { data } = await createServiceClient()
    .from("document_renewals")
    .select(RENEWAL_COLUMNS)
    .eq("id", renewalId)
    .maybeSingle();
  return (data as unknown as RenewalRow | null) ?? null;
}

export type RoundResult =
  | { ok: true; renewal: RenewalRow; token: string; url: string }
  | { ok: false; error: string };

/**
 * Crea una ronda en estado `sending`: el link todavía no vale. El que llama la
 * activa (`activateRound`) cuando el correo salió, o enseguida si solo se pide
 * el link. Así un correo que falla no deja un link vivo que nadie recibió.
 *
 * `error` es una clave de i18n.
 */
export async function createRenewalRound(input: {
  requestId: string;
  fieldIds: string[];
  actor: Actor;
  ttlHours?: number;
  locale?: RenewalLocale;
  emailTo?: string | null;
  note?: string | null;
}): Promise<RoundResult> {
  const supabase = createServiceClient();
  const { data: reqRow } = await supabase
    .from("kyb_requests")
    .select(REQUEST_COLUMNS)
    .eq("id", input.requestId)
    .maybeSingle();
  const req = reqRow as RequestCtx | null;
  if (!req) return { ok: false, error: "expirations.errNotFound" };
  if (req.status !== "approved") return { ok: false, error: "expirations.errNotApproved" };

  const { data: pending } = await supabase
    .from("document_renewals")
    .select("id")
    .eq("request_id", req.id)
    .eq("state", "submitted")
    .limit(1);
  if (pending?.length) return { ok: false, error: "expirations.errPendingReview" };

  const requestDef = await resolveRequestDefinition(req.form_definition, req.form_id, req.org_id);
  if (!requestDef) return { ok: false, error: "expirations.errNoDefinition" };
  const liveDef = await liveDefinitionFor(req, requestDef);
  const answers = await answersOf(req.id);
  const docs = renewalFieldKeys(requestDef, liveDef, answers, input.fieldIds);
  if (docs.length === 0) return { ok: false, error: "expirations.errNoDocuments" };

  const expirations = new Map(
    (await loadRequestExpirations(req.id)).map((e) => [e.field_id, e] as const),
  );
  const labelOf = (fieldId: string): LocalizedText => {
    const field = requestDef.sections.flatMap((s) => s.fields).find((f) => f.id === fieldId);
    return (expirations.get(fieldId)?.field_label as LocalizedText) ?? field?.label ?? fieldId;
  };
  const fields: RenewalField[] = docs.map((d) => ({
    fieldId: d.fieldId,
    fieldKey: d.fieldKey,
    label: labelOf(d.fieldId),
    expiresOn: expirations.get(d.fieldId)?.expires_on ?? null,
    marker: d.marker,
    keys: d.keys,
  }));

  const { data: last } = await supabase
    .from("document_renewals")
    .select("round")
    .eq("request_id", req.id)
    .order("round", { ascending: false })
    .limit(1)
    .maybeSingle();
  const round = ((last?.round as number | undefined) ?? 0) + 1;

  const ttl = Math.min(
    Math.max(1, Math.floor(input.ttlHours ?? RENEWAL_TTL_HOURS_DEFAULT)),
    RENEWAL_TTL_HOURS_MAX,
  );
  const token = generateToken();
  const { data: inserted, error } = await supabase
    .from("document_renewals")
    .insert({
      request_id: req.id,
      round,
      state: "sending",
      fields,
      keys: [...new Set(docs.flatMap((d) => d.keys))],
      locale: input.locale ?? "es",
      email_to: input.emailTo ?? null,
      email_note: input.note?.trim() || null,
      token_hash: hashToken(token),
      token_expires_at: new Date(Date.now() + ttl * 3_600_000).toISOString(),
      requested_by: input.actor.userId,
      requested_by_email: input.actor.email,
    })
    .select(RENEWAL_COLUMNS)
    .single();
  if (error || !inserted) {
    // `unique(request_id, round)`: otra ronda se creó al mismo tiempo.
    console.error(`[renewals] request=${req.id} no se pudo crear la ronda:`, error?.message);
    return { ok: false, error: "expirations.errConcurrent" };
  }
  return { ok: true, renewal: inserted as unknown as RenewalRow, token, url: renewalUrl(token) };
}

/**
 * Activa una ronda `sending`: cancela la que estaba pidiendo documentos (su link
 * deja de valer) y deja esta como la única abierta. El índice único parcial de
 * 0030 frena dos activaciones simultáneas: la que pierde queda cancelada.
 */
export async function activateRound(
  renewal: RenewalRow,
  actor: Actor,
  extra: { email_message_id?: string | null; email_sent_at?: string | null; email_error?: string | null } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = createServiceClient();
  const { data: superseded } = await supabase
    .from("document_renewals")
    .update({ state: "cancelled", updated_at: new Date().toISOString() })
    .eq("request_id", renewal.request_id)
    .eq("state", "requested")
    .neq("id", renewal.id)
    .select("id, round");
  for (const s of superseded ?? []) {
    await logAudit({
      requestId: renewal.request_id,
      actor: actor.email,
      actorUserId: actor.userId,
      action: "renewal_cancelled",
      metadata: { round: s.round, supersededBy: renewal.round },
    });
  }

  const { data: activated, error } = await supabase
    .from("document_renewals")
    .update({ state: "requested", updated_at: new Date().toISOString(), ...extra })
    .eq("id", renewal.id)
    .eq("state", "sending")
    .select("id")
    .maybeSingle();
  if (error || !activated) {
    console.error(`[renewals] ronda=${renewal.id} no se pudo activar:`, error?.message);
    await supabase
      .from("document_renewals")
      .update({ state: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", renewal.id)
      .eq("state", "sending");
    return { ok: false, error: "expirations.errConcurrent" };
  }
  return { ok: true };
}

/** El correo no salió: la ronda no se activa y su token muere con ella. */
export async function failRound(renewalId: string, emailError: string): Promise<void> {
  await createServiceClient()
    .from("document_renewals")
    .update({ state: "failed", email_error: emailError.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", renewalId)
    .eq("state", "sending");
}

// ============================================================
// Acceso público por token
// ============================================================

export type RenewalGate =
  | {
      ok: true;
      renewal: RenewalRow;
      req: RequestCtx;
      requestDef: FormDefinition;
      renewalDef: FormDefinition;
    }
  | { ok: false; reason: "invalid" | "expired" | "received"; error: string };

/**
 * Resuelve un token de renovación. `null` si el token no es de ninguna ronda
 * (puede ser un link de invitación). No escribe nada: un link vencido no toca
 * la solicitud, que sigue aprobada.
 */
export async function resolveRenewal(token: string): Promise<RenewalGate | null> {
  if (!token) return null;
  const { data } = await createServiceClient()
    .from("document_renewals")
    .select(`${RENEWAL_COLUMNS}, req:kyb_requests!inner(${REQUEST_COLUMNS})`)
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (!data) return null;
  const { req: reqRaw, ...rest } = data as unknown as RenewalRow & {
    req: RequestCtx | RequestCtx[];
  };
  const renewal = rest as RenewalRow;
  const req = Array.isArray(reqRaw) ? reqRaw[0] : reqRaw;

  if (renewal.state === "submitted" || renewal.state === "accepted") {
    return { ok: false, reason: "received", error: "La renovación ya fue enviada." };
  }
  if (renewal.state !== "requested" || req?.status !== "approved") {
    return { ok: false, reason: "invalid", error: "El link de renovación no es válido." };
  }
  if (!renewal.token_expires_at || new Date(renewal.token_expires_at) < new Date()) {
    return { ok: false, reason: "expired", error: "El link de renovación venció." };
  }
  const requestDef = await resolveRequestDefinition(req.form_definition, req.form_id, req.org_id);
  if (!requestDef) {
    return { ok: false, reason: "invalid", error: "El link de renovación no es válido." };
  }
  return {
    ok: true,
    renewal,
    req,
    requestDef,
    renewalDef: renewalDefinition(requestDef, renewal.keys, RENEWAL_SECTION_TITLE),
  };
}

/** Borrador de la renovación: solo claves de la ronda (las filtra el que llama). */
export async function saveRenewalDraft(
  renewalId: string,
  answers: Record<string, unknown>,
): Promise<boolean> {
  const { data } = await createServiceClient()
    .from("document_renewals")
    .update({ answers, updated_at: new Date().toISOString() })
    .eq("id", renewalId)
    .eq("state", "requested")
    .select("id")
    .maybeSingle();
  return Boolean(data);
}

/** `requested → submitted` con compare-and-set: un doble envío gana una sola vez. */
export async function submitRenewal(
  renewal: RenewalRow,
  answers: Record<string, unknown>,
): Promise<boolean> {
  const { data } = await createServiceClient()
    .from("document_renewals")
    .update({
      state: "submitted",
      answers,
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", renewal.id)
    .eq("state", "requested")
    .select("id")
    .maybeSingle();
  if (!data) return false;
  await logAudit({
    requestId: renewal.request_id,
    actor: "applicant",
    action: "renewal_submitted",
    metadata: { round: renewal.round, keys: renewal.keys },
  });
  return true;
}

// ============================================================
// Verificación de los documentos renovados
// ============================================================

/**
 * Vuelve a verificar con DIDIT los documentos renovados cuya fecha sale de
 * DIDIT, sobre las respuestas de hoy con lo renovado encima. Los resultados
 * quedan RETENIDOS en la ronda (no en aml_checks) hasta que el analista acepta.
 * El cargo sí se registra: DIDIT cobra la sesión aunque la ronda se rechace.
 */
export async function runRenewalVerifications(renewalId: string): Promise<void> {
  try {
    const renewal = await loadRenewal(renewalId);
    if (!renewal || renewal.state !== "submitted") return;
    const didit = renewal.fields.filter((f) => f.marker === "didit");
    if (didit.length === 0 || env.amlProvider() !== "didit") return;

    const supabase = createServiceClient();
    const { data: reqRow } = await supabase
      .from("kyb_requests")
      .select(REQUEST_COLUMNS)
      .eq("id", renewal.request_id)
      .maybeSingle();
    const req = reqRow as RequestCtx | null;
    if (!req) return;
    const requestDef = await resolveRequestDefinition(req.form_definition, req.form_id, req.org_id);
    if (!requestDef) return;

    const merged = { ...(await answersOf(req.id)), ...pick(renewal.answers, renewal.keys) };
    const rows = await dispatchDiditReviews({
      requestId: req.id,
      externalRef: req.external_ref,
      definition: requestDef,
      answers: merged,
      only: new Set(didit.map((f) => `id_verification:${f.fieldKey}`)),
    });
    await supabase
      .from("document_renewals")
      .update({ checks: rows, updated_at: new Date().toISOString() })
      .eq("id", renewal.id);
    for (const r of rows) {
      if (r.externalRef && r.status !== "error") {
        await recordCheckCharge({
          orgId: req.org_id,
          requestId: req.id,
          checkId: null,
          feature: r.feature,
          sessionId: r.externalRef,
        });
      }
    }
    await logAudit({
      requestId: req.id,
      actor: "system",
      action: "renewal_verifications_run",
      metadata: { round: renewal.round, checks: rows.map((r) => `${r.feature}:${r.fieldKey}:${r.status}`) },
    });
  } catch (e) {
    console.error(`[renewals] ronda=${renewalId} verificación falló:`, e instanceof Error ? e.message : e);
  }
}

function pick(answers: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in answers) out[k] = answers[k];
  return out;
}

// ============================================================
// Revisión del analista
// ============================================================

/**
 * Acepta una renovación: lo renovado pasa a las respuestas, los checks
 * retenidos a aml_checks y se recalculan los vencimientos. La solicitud sigue
 * aprobada; el cliente recibe `document.renewed`.
 */
export async function acceptRenewal(
  renewalId: string,
  actor: Actor,
): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  const supabase = createServiceClient();
  const now = new Date().toISOString();
  const { data: claimed } = await supabase
    .from("document_renewals")
    .update({
      state: "accepted",
      reviewed_by: actor.userId,
      reviewed_by_email: actor.email,
      reviewed_at: now,
      updated_at: now,
    })
    .eq("id", renewalId)
    .eq("state", "submitted")
    .select(RENEWAL_COLUMNS)
    .maybeSingle();
  const renewal = claimed as unknown as RenewalRow | null;
  if (!renewal) return { ok: false, error: "expirations.errRenewalChanged" };

  const before = new Map(
    (await loadRequestExpirations(renewal.request_id)).map((e) => [e.field_id, e.expires_on] as const),
  );

  const current = await answersOf(renewal.request_id);
  const merged = { ...current, ...pick(renewal.answers, renewal.keys) };
  const { error: upError } = await supabase
    .from("kyb_form_responses")
    .upsert(
      {
        request_id: renewal.request_id,
        data: merged,
        updated_at: now,
      },
      { onConflict: "request_id" },
    );
  if (upError) {
    // Sin respuestas nuevas la aceptación no vale: se deshace el claim.
    console.error(`[renewals] ronda=${renewal.id} no se pudo escribir:`, upError.message);
    await supabase
      .from("document_renewals")
      .update({ state: "submitted", reviewed_by: null, reviewed_by_email: null, reviewed_at: null })
      .eq("id", renewal.id);
    return { ok: false, error: "expirations.errSave" };
  }

  // Las respuestas se acaban de pisar: queda una foto de cómo quedaron (0032).
  // Las de antes están en la foto del envío. Un fallo acá no deshace la
  // aceptación: lo renovado sigue también en la ronda (`answers`).
  try {
    const { data: reqRow } = await supabase
      .from("kyb_requests")
      .select("form_revision")
      .eq("id", renewal.request_id)
      .maybeSingle();
    await snapshotResponses({
      requestId: renewal.request_id,
      kind: "renewal_accepted",
      round: renewal.round,
      data: merged,
      formRevision: (reqRow?.form_revision as number | null | undefined) ?? null,
    });
  } catch (e) {
    console.error(`[renewals] ronda=${renewal.id} sin foto de las respuestas:`, e);
  }

  if (renewal.checks?.length) {
    const { error } = await supabase.from("aml_checks").insert(
      renewal.checks.map((r) => ({
        request_id: renewal.request_id,
        provider: "didit",
        feature: r.feature,
        field_key: r.fieldKey,
        external_ref: r.externalRef,
        status: r.status,
        score: r.score,
        result: r.result,
        renewal_id: renewal.id,
      })),
    );
    if (error) console.error(`[renewals] ronda=${renewal.id} checks no insertados:`, error.message);
  }

  await syncRequestExpirations(renewal.request_id);
  const after = await loadRequestExpirations(renewal.request_id);
  const documents = renewal.fields.map((f) => ({
    field_id: f.fieldId,
    field_key: f.fieldKey,
    previous_expires_on: before.get(f.fieldId) ?? null,
    expires_on: after.find((e) => e.field_id === f.fieldId)?.expires_on ?? null,
  }));

  await logAudit({
    requestId: renewal.request_id,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "renewal_accepted",
    metadata: { round: renewal.round, documents },
  });
  await notifyClient(renewal.request_id, "document.renewed", {
    data: { renewal: { round: renewal.round, accepted_at: now, documents } },
  });
  return { ok: true, requestId: renewal.request_id };
}

/** Rechaza lo enviado (el analista pedirá de nuevo con otra ronda). */
export async function rejectRenewal(
  renewalId: string,
  actor: Actor,
  note: string | null,
): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  const now = new Date().toISOString();
  const { data } = await createServiceClient()
    .from("document_renewals")
    .update({
      state: "rejected",
      review_note: note?.trim() || null,
      reviewed_by: actor.userId,
      reviewed_by_email: actor.email,
      reviewed_at: now,
      updated_at: now,
    })
    .eq("id", renewalId)
    .eq("state", "submitted")
    .select("request_id, round")
    .maybeSingle();
  if (!data) return { ok: false, error: "expirations.errRenewalChanged" };
  await logAudit({
    requestId: data.request_id as string,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "renewal_rejected",
    metadata: { round: data.round, note: note?.trim() || null },
  });
  return { ok: true, requestId: data.request_id as string };
}

/** Cancela una ronda que todavía pide documentos: su link deja de valer. */
export async function cancelRenewal(
  renewalId: string,
  actor: Actor,
): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
  const { data } = await createServiceClient()
    .from("document_renewals")
    .update({ state: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", renewalId)
    .eq("state", "requested")
    .select("request_id, round")
    .maybeSingle();
  if (!data) return { ok: false, error: "expirations.errRenewalChanged" };
  await logAudit({
    requestId: data.request_id as string,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "renewal_cancelled",
    metadata: { round: data.round },
  });
  return { ok: true, requestId: data.request_id as string };
}
