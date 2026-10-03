"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireAnalyst } from "@/lib/auth/admin";
import { loadOwnedExpiration, loadOwnedRenewal, loadOwnedRequest } from "@/lib/auth/tenant";
import { createServiceClient } from "@/lib/supabase/service";
import { parseExpiryDate } from "@/lib/forms/expiry";
import { logAudit } from "@/lib/kyb/service";
import { syncRequestExpirations } from "@/lib/kyb/expirations";
import {
  acceptRenewal,
  activateRound,
  cancelRenewal,
  createRenewalRound,
  rejectRenewal,
  runRenewalVerifications,
} from "@/lib/kyb/renewals";

/** `error` es una clave de i18n (el panel es bilingüe). */
type Result = { ok: true } | { ok: false; error: string };

/**
 * Corrige a mano la fecha de vencimiento de un documento (o quita la
 * corrección, con `null`). La corrección gana sobre la fecha de DIDIT o la
 * declarada, y vale mientras el documento sea el mismo: un documento nuevo la
 * descarta (ver computeExpirations).
 */
export async function setExpiryOverrideAction(
  expirationId: string,
  date: string | null,
): Promise<Result> {
  const analyst = await requireAnalyst();
  const row = await loadOwnedExpiration(
    analyst,
    expirationId,
    "id, field_key, expires_on, override_expires_on",
  );
  if (!row) return { ok: false, error: "expirations.errNotFound" };

  let value: string | null = null;
  if (date !== null) {
    value = parseExpiryDate(date);
    if (!value) return { ok: false, error: "expirations.errInvalidDate" };
  }

  const { error } = await createServiceClient()
    .from("document_expirations")
    .update(
      value
        ? {
            override_expires_on: value,
            override_by: analyst.userId,
            override_by_email: analyst.email,
            override_at: new Date().toISOString(),
          }
        : {
            override_expires_on: null,
            override_by: null,
            override_by_email: null,
            override_at: null,
          },
    )
    .eq("id", expirationId);
  if (error) return { ok: false, error: "expirations.errSave" };

  // `expires_on`, el origen y el aviso se recalculan con la corrección aplicada.
  const requestId = row.request_id as string;
  await syncRequestExpirations(requestId);
  await logAudit({
    requestId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: value ? "expiry_overridden" : "expiry_override_cleared",
    metadata: { fieldKey: row.field_key, from: row.expires_on ?? null, to: value },
  });

  revalidatePath("/admin/expirations");
  revalidatePath(`/admin/requests/${requestId}`);
  return { ok: true };
}

// ============================================================
// Renovación de documentos
// ============================================================

/** Vigencias del link que ofrece el panel, en días. */
const RENEWAL_TTL_DAYS = [7, 14, 30] as const;

function revalidateRequest(requestId: string) {
  revalidatePath("/admin/expirations");
  revalidatePath(`/admin/requests/${requestId}`);
}

/**
 * Genera un link de renovación sin correo (para copiarlo y mandarlo por otro
 * canal). Reemplaza al link anterior, si había uno vigente.
 */
export async function createRenewalLinkAction(
  requestId: string,
  fieldIds: string[],
  ttlDays: number,
): Promise<{ ok: true; url: string; expiresAt: string } | { ok: false; error: string }> {
  const analyst = await requireAnalyst();
  if (!(await loadOwnedRequest(analyst, requestId))) {
    return { ok: false, error: "expirations.errNotFound" };
  }
  const days = (RENEWAL_TTL_DAYS as readonly number[]).includes(ttlDays) ? ttlDays : 14;
  const actor = { userId: analyst.userId, email: analyst.email };
  const created = await createRenewalRound({ requestId, fieldIds, actor, ttlHours: days * 24 });
  if (!created.ok) return created;
  const activated = await activateRound(created.renewal, actor);
  if (!activated.ok) return activated;

  await logAudit({
    requestId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "renewal_link_created",
    metadata: {
      round: created.renewal.round,
      fields: created.renewal.fields.map((f) => f.fieldKey),
      expiresAt: created.renewal.token_expires_at,
    },
  });
  revalidateRequest(requestId);
  return { ok: true, url: created.url, expiresAt: created.renewal.token_expires_at ?? "" };
}

export async function cancelRenewalAction(renewalId: string): Promise<Result> {
  const analyst = await requireAnalyst();
  if (!(await loadOwnedRenewal(analyst, renewalId))) {
    return { ok: false, error: "expirations.errNotFound" };
  }
  const res = await cancelRenewal(renewalId, { userId: analyst.userId, email: analyst.email });
  if (!res.ok) return res;
  revalidateRequest(res.requestId);
  return { ok: true };
}

/** Acepta lo renovado: pasa a las respuestas y recalcula los vencimientos. */
export async function acceptRenewalAction(renewalId: string): Promise<Result> {
  const analyst = await requireAnalyst();
  if (!(await loadOwnedRenewal(analyst, renewalId))) {
    return { ok: false, error: "expirations.errNotFound" };
  }
  const res = await acceptRenewal(renewalId, { userId: analyst.userId, email: analyst.email });
  if (!res.ok) return res;
  revalidateRequest(res.requestId);
  return { ok: true };
}

/** «Pedir de nuevo»: rechaza lo enviado; la próxima ronda se pide aparte. */
export async function rejectRenewalAction(renewalId: string, note: string): Promise<Result> {
  const analyst = await requireAnalyst();
  if (!(await loadOwnedRenewal(analyst, renewalId))) {
    return { ok: false, error: "expirations.errNotFound" };
  }
  const res = await rejectRenewal(
    renewalId,
    { userId: analyst.userId, email: analyst.email },
    note.slice(0, 1000),
  );
  if (!res.ok) return res;
  revalidateRequest(res.requestId);
  return { ok: true };
}

/** Recuperación: vuelve a correr DIDIT sobre lo renovado (si quedó a medias). */
export async function rerunRenewalVerificationsAction(renewalId: string): Promise<Result> {
  const analyst = await requireAnalyst();
  const row = await loadOwnedRenewal(analyst, renewalId);
  if (!row) return { ok: false, error: "expirations.errNotFound" };
  after(() => runRenewalVerifications(renewalId));
  revalidateRequest(row.request_id as string);
  return { ok: true };
}
