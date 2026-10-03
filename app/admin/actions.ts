"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { getAuthState, loginPathFor, requireAnalyst } from "@/lib/auth/admin";
import {
  loadOwnedCheck,
  loadOwnedDocPath,
  loadOwnedRequest,
} from "@/lib/auth/tenant";
import {
  decideRequest,
  requestChanges,
  runVerifications,
  logAudit,
  DOCUMENTS_BUCKET,
} from "@/lib/kyb/service";
import { kybSelect, runKybRegistryCheck } from "@/lib/didit/verify";
import { recordKybCharge } from "@/lib/didit/costs";
import { resolveRequestDefinition } from "@/lib/forms/store";
import { notifyClient } from "@/lib/kyb/webhook";
import { syncRequestExpirations } from "@/lib/kyb/expirations";
import { createServiceClient } from "@/lib/supabase/service";
import { createServerSupabase } from "@/lib/supabase/server";
import type { KybDecision } from "@/lib/kyb/types";

/**
 * Todas las acciones de este archivo reciben ids del cliente y operan con
 * service-role, así que cada una verifica primero que el recurso sea de una org
 * que el analista puede tocar (lib/auth/tenant.ts). Si no, responde como si no
 * existiera.
 */

export async function decideAction(
  requestId: string,
  decision: KybDecision,
  formData?: FormData,
) {
  const analyst = await requireAnalyst();
  if (!(await loadOwnedRequest(analyst, requestId))) notFound();
  const reason = formData ? String(formData.get("reason") ?? "") : undefined;
  await decideRequest(
    requestId,
    decision,
    { userId: analyst.userId, email: analyst.email },
    reason,
  );
  // Push al cliente en segundo plano (no bloquea la respuesta del panel).
  after(() => notifyClient(requestId, "decision.made"));
  // Red de seguridad: los vencimientos se calculan al enviar y al verificar,
  // pero una aprobada es lo que lista la pantalla Vencimientos.
  if (decision === "approved") after(() => syncRequestExpirations(requestId));
  revalidatePath(`/admin/requests/${requestId}`);
  revalidatePath("/admin");
}

/**
 * Devuelve la solicitud al solicitante para corregir preguntas puntuales
 * (borra sus respuestas y re-emite el link). Llamado desde el panel de detalle.
 */
export async function requestChangesAction(
  requestId: string,
  fields: { key: string; note?: string }[],
): Promise<
  | { ok: true; invitationUrl: string; round: number }
  | { ok: false; error: string }
> {
  const analyst = await requireAnalyst();
  // Devuelve un link de invitación vivo: sin este chequeo, cualquier analista
  // abría el formulario (con sus respuestas) de una solicitud ajena.
  if (!(await loadOwnedRequest(analyst, requestId))) {
    return { ok: false, error: "Solicitud no encontrada." };
  }
  const res = await requestChanges(requestId, fields, {
    actor: analyst.email,
    source: "admin",
  });
  if (!res.ok) return res;
  after(() => notifyClient(requestId, "changes.requested"));
  revalidatePath(`/admin/requests/${requestId}`);
  revalidatePath("/admin");
  return { ok: true, invitationUrl: res.invitationUrl, round: res.round };
}

/**
 * Re-corre las verificaciones DIDIT/AML de una solicitud (recuperación cuando el
 * trabajo en segundo plano quedó a medias). Es reanudable/idempotente: no re-hace
 * las verificaciones ya exitosas.
 */
export async function rerunVerificationsAction(requestId: string) {
  const analyst = await requireAnalyst();
  if (!(await loadOwnedRequest(analyst, requestId))) notFound();
  await runVerifications(requestId, { force: true });
  await syncRequestExpirations(requestId);
  revalidatePath(`/admin/requests/${requestId}`);
  revalidatePath("/admin/expirations");
}

/**
 * Ejecuta un ciclo de validación registral (kyb_registry) para la solicitud.
 * Manual por diseño: el search tarda ~90s y el select es facturable, así que
 * queda detrás de una acción explícita y auditada del analista.
 */
export async function runKybRegistryAction(
  requestId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const analyst = await requireAnalyst();
  const supabase = createServiceClient();
  const req = await loadOwnedRequest(
    analyst,
    requestId,
    "id, external_ref, form_id, form_definition",
  );
  if (!req) return { ok: false, error: "Solicitud no encontrada." };
  const definition = await resolveRequestDefinition(
    req.form_definition,
    (req.form_id as string | null) ?? null,
    req.org_id as string,
  );
  if (!definition) return { ok: false, error: "La solicitud no tiene definición de formulario." };
  const { data: responseRow } = await supabase
    .from("kyb_form_responses")
    .select("data")
    .eq("request_id", requestId)
    .maybeSingle();
  const answers = (responseRow?.data as Record<string, unknown>) ?? {};

  const res = await runKybRegistryCheck({
    requestId,
    externalRef: req.external_ref as string,
    definition,
    answers,
  });
  if (!res.ok) {
    const messages: Record<string, string> = {
      no_tagged_field:
        "El formulario no tiene una pregunta etiquetada con Registro mercantil (KYB).",
      missing_country: "Falta el país (campo tipo país o key «country») para la búsqueda.",
      missing_name: "Falta la razón social o el número de registro.",
      cycle_in_progress: "Ya hay una consulta de perfil en curso para esta solicitud.",
    };
    return { ok: false, error: messages[res.error] ?? res.error };
  }
  await logAudit({
    requestId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "kyb_registry_run",
  });
  revalidatePath(`/admin/requests/${requestId}`);
  return { ok: true };
}

/**
 * Selección manual de candidato del registro mercantil. Reserva atómica ANTES
 * del select FACTURABLE; tras un intento (exitoso o incierto) nunca se permite
 * otro select sobre la misma fila.
 */
export async function selectKybCandidateAction(
  checkId: string,
  kybResponseId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const analyst = await requireAnalyst();
  const supabase = createServiceClient();

  // Facturable: solo sobre checks de solicitudes de la org del analista.
  const check = await loadOwnedCheck(
    analyst,
    checkId,
    "id, provider, feature, status, result",
  );
  if (!check) return { ok: false, error: "Check no encontrado." };
  if (check.provider !== "didit" || check.feature !== "kyb_registry") {
    return { ok: false, error: "El check no es de registro mercantil." };
  }
  if (check.status !== "pending") {
    return { ok: false, error: "El check ya no está pendiente." };
  }
  const result = (check.result ?? {}) as Record<string, unknown>;
  if (result.phase !== "candidate_selection") {
    return { ok: false, error: "El check no está en selección de candidato." };
  }
  const prevSelected = result.selected as Record<string, unknown> | undefined;
  // Política estricta: un intento de select (aunque haya quedado incierto)
  // bloquea cualquier otro — DIDIT pudo haberlo facturado.
  if (prevSelected?.select_attempted) {
    return { ok: false, error: "Ya se solicitó una consulta para este check." };
  }
  const candidates = Array.isArray(result.candidates)
    ? (result.candidates as Record<string, unknown>[])
    : [];
  if (!candidates.some((c) => String(c.kyb_response_id ?? "") === kybResponseId)) {
    return { ok: false, error: "El candidato no pertenece a esta búsqueda." };
  }

  const { data: req } = await supabase
    .from("kyb_requests")
    .select("external_ref")
    .eq("id", check.request_id as string)
    .maybeSingle();
  if (!req) return { ok: false, error: "Solicitud no encontrada." };

  // Reserva atómica ANTES del HTTP: si algo muere a mitad, la fila ya dice
  // select_attempted/billing unknown y nadie vuelve a facturar.
  const selected = {
    kyb_response_id: kybResponseId,
    by: analyst.email,
    at: new Date().toISOString(),
    select_attempted: true,
    billing_state: "unknown",
  };
  const reservedResult = { ...result, phase: "select", selected };
  const { data: reserved } = await supabase
    .from("aml_checks")
    .update({ result: reservedResult })
    .eq("id", checkId)
    .eq("status", "pending")
    .select("id");
  if (!reserved?.length) return { ok: false, error: "El check ya fue resuelto." };
  // Verifica que ESTA reserva ganó (dos analistas casi simultáneos): relee y
  // compara el token; solo el dueño de la reserva ejecuta el select.
  const { data: after } = await supabase
    .from("aml_checks")
    .select("result")
    .eq("id", checkId)
    .single();
  const afterSel = ((after?.result as Record<string, unknown>)?.selected ?? {}) as Record<
    string,
    unknown
  >;
  if (afterSel.by !== analyst.email || afterSel.at !== selected.at) {
    return { ok: false, error: "Otro analista está resolviendo este check." };
  }

  try {
    const sel = await kybSelect(kybResponseId, req.external_ref);
    await supabase
      .from("aml_checks")
      .update({
        status: sel.status,
        external_ref: sel.externalRef,
        result: {
          ...result,
          phase: sel.status === "pending" ? "select" : "completed",
          selected: { ...selected, billing_state: "charged" },
          kyb_registry: sel.node,
        },
      })
      .eq("id", checkId);
    await recordKybCharge({ checkId, kind: "kyb_select", sessionId: sel.externalRef });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\s4\d\d:/.test(msg)) {
      // DIDIT lo rechazó (no facturó): se revierte la reserva y el analista
      // puede elegir otro candidato.
      await supabase
        .from("aml_checks")
        .update({ result: { ...result, phase: "candidate_selection", select_error: msg } })
        .eq("id", checkId);
      return { ok: false, error: msg };
    }
    // Incierto (timeout/5xx): la reserva queda con billing unknown y el error;
    // sin reintentos. El analista verifica en la consola DIDIT.
    await supabase
      .from("aml_checks")
      .update({ result: { ...reservedResult, selected: { ...selected, error: msg } } })
      .eq("id", checkId);
    await recordKybCharge({ checkId, kind: "kyb_select", sessionId: null, unconfirmed: true });
    return { ok: false, error: msg };
  }

  await logAudit({
    requestId: check.request_id as string,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "kyb_registry_selected",
    metadata: { checkId, kybResponseId },
  });
  revalidatePath(`/admin/requests/${check.request_id}`);
  return { ok: true };
}

/**
 * "Ninguna coincide": cierra el ciclo de selección sin facturar. El analista
 * puede luego pedir correcciones al solicitante por la vía normal.
 */
export async function dismissKybCandidatesAction(
  checkId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const analyst = await requireAnalyst();
  const supabase = createServiceClient();
  const check = await loadOwnedCheck(
    analyst,
    checkId,
    "id, provider, feature, status, result",
  );
  if (!check) return { ok: false, error: "Check no encontrado." };
  const result = (check.result ?? {}) as Record<string, unknown>;
  const selected = result.selected as Record<string, unknown> | undefined;
  if (
    check.provider !== "didit" ||
    check.feature !== "kyb_registry" ||
    check.status !== "pending" ||
    result.phase !== "candidate_selection" ||
    selected?.select_attempted
  ) {
    return { ok: false, error: "El check no está en selección de candidato." };
  }
  const { error } = await supabase
    .from("aml_checks")
    .update({
      status: "flagged",
      result: { ...result, phase: "completed", reason: "none_matched" },
    })
    .eq("id", checkId)
    .eq("status", "pending");
  if (error) return { ok: false, error: error.message };
  await logAudit({
    requestId: check.request_id as string,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "kyb_registry_dismissed",
    metadata: { checkId },
  });
  revalidatePath(`/admin/requests/${check.request_id}`);
  return { ok: true };
}

/** URL firmada temporal para descargar un documento (solo analistas). */
export async function getDocUrlAction(path: string): Promise<string | null> {
  const analyst = await requireAnalyst();
  const supabase = createServiceClient();

  // Firmar solo rutas que correspondan a un documento registrado de una
  // solicitud de la org del analista. Sin esto la acción firmaba cualquier
  // objeto del bucket privado que se le pasara.
  const doc = await loadOwnedDocPath(analyst, path);
  if (!doc) {
    console.warn(`[getDocUrlAction] ruta no registrada o ajena: ${path}`);
    return null;
  }

  const { data } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    // 10 min y no 2: el visor de PDF pide rangos del archivo mientras se pasan
    // páginas, y con un TTL corto el documento se corta a mitad de lectura.
    .createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}

/**
 * Cierra la sesión de ESTE dispositivo. El default de Supabase (`global`)
 * cerraba todas las sesiones de la cuenta; para eso está "Cerrar sesión en
 * otros dispositivos" en Seguridad.
 *
 * Vuelve al login de su rol (el admin a /admin/login), leído antes de salir.
 */
export async function signOutAction() {
  const destination = await loginPathFor((await getAuthState()).role);
  const supabase = await createServerSupabase();
  await supabase.auth.signOut({ scope: "local" });
  redirect(destination);
}
