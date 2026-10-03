"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireAnalyst } from "@/lib/auth/admin";
import { loadOwnedExpiration, loadOwnedRenewal, loadOwnedRequest } from "@/lib/auth/tenant";
import { canAccessOrg, isUuid } from "@/lib/auth/tenantRules";
import { consumeRate } from "@/lib/auth/rateLimit";
import { createServiceClient } from "@/lib/supabase/service";
import { parseExpiryDate } from "@/lib/forms/expiry";
import { logAudit } from "@/lib/kyb/service";
import { syncRequestExpirations } from "@/lib/kyb/expirations";
import {
  acceptRenewal,
  activateRound,
  cancelRenewal,
  createRenewalRound,
  failRound,
  rejectRenewal,
  runRenewalVerifications,
} from "@/lib/kyb/renewals";
import { LOGO_BUCKET, loadOrgBranding, renewalEmailFor } from "@/lib/kyb/renewalEmail";
import { applicantMailMode, sendEmail, type MailMode } from "@/lib/mail/send";

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

// ============================================================
// Correo de renovación
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTE_MAX = 1000;
/** Correos de renovación por minuto: por analista y por solicitud. */
const MAILS_PER_MIN_USER = 10;
const MAILS_PER_MIN_REQUEST = 2;

export type SendRenewalResult =
  | {
      ok: true;
      mode: MailMode;
      /** Link para copiar: en modo local, o si no se pudo confirmar el envío. */
      url?: string;
      unconfirmed?: boolean;
    }
  | { ok: false; error: string };

/**
 * Envía el correo de renovación: crea la ronda (todavía sin link vivo), arma
 * el correo en el servidor con los datos de la base y lo envía. Recién si
 * salió se activa la ronda, que reemplaza al link anterior.
 *
 * - Rechazo de Resend: la ronda queda `failed` y el link anterior sigue.
 * - Timeout o error de red (no se sabe si salió): se activa igual y se
 *   devuelve el link para copiarlo, así nunca hay dos links vivos.
 */
export async function sendRenewalEmailAction(
  requestId: string,
  input: { to: string; locale: string; fieldIds: string[]; note: string; ttlDays: number },
): Promise<SendRenewalResult> {
  const analyst = await requireAnalyst();
  const req = await loadOwnedRequest(analyst, requestId, "id, status, subject_title");
  if (!req) return { ok: false, error: "expirations.errNotFound" };

  const to = input.to.trim();
  if (!EMAIL_RE.test(to) || to.length > 254) return { ok: false, error: "expirations.errEmail" };
  const locale = input.locale === "en" ? "en" : "es";
  const note = input.note.trim().slice(0, NOTE_MAX);
  const days = (RENEWAL_TTL_DAYS as readonly number[]).includes(input.ttlDays) ? input.ttlDays : 14;

  const mode = applicantMailMode();
  if (mode === "off") return { ok: false, error: "expirations.errNoSender" };

  const [perUser, perRequest] = await Promise.all([
    consumeRate(`renewalmail:${analyst.userId}`, MAILS_PER_MIN_USER),
    consumeRate(`renewalmail:req:${requestId}`, MAILS_PER_MIN_REQUEST),
  ]);
  if (!perUser.allowed || !perRequest.allowed) return { ok: false, error: "expirations.errRate" };

  const actor = { userId: analyst.userId, email: analyst.email };
  const created = await createRenewalRound({
    requestId,
    fieldIds: input.fieldIds,
    actor,
    ttlHours: days * 24,
    locale,
    emailTo: to,
    note,
  });
  if (!created.ok) return created;
  const round = created.renewal;

  const branding = await loadOrgBranding(req.org_id as string);
  const mail = renewalEmailFor(round, {
    branding,
    companyName: (req.subject_title as string | null) ?? null,
    url: created.url,
  });
  const sent = await sendEmail({
    to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    replyTo: analyst.email,
    idempotencyKey: `renewal-${round.id}`,
  });

  if (!sent.ok && sent.definitive) {
    await failRound(round.id, sent.error);
    await logAudit({
      requestId,
      actor: analyst.email,
      actorUserId: analyst.userId,
      action: "renewal_email_failed",
      metadata: { round: round.round, to, error: sent.error },
    });
    revalidateRequest(requestId);
    return { ok: false, error: "expirations.errSend" };
  }

  const activated = await activateRound(round, actor, {
    email_message_id: sent.ok ? (mode === "log" ? "local" : sent.id) : null,
    email_sent_at: new Date().toISOString(),
    email_error: sent.ok ? null : "unconfirmed",
  });
  if (!activated.ok) return activated;

  await logAudit({
    requestId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "renewal_email_sent",
    metadata: {
      round: round.round,
      to,
      locale,
      fields: round.fields.map((f) => f.fieldKey),
      mode,
      unconfirmed: !sent.ok,
    },
  });
  revalidateRequest(requestId);
  return {
    ok: true,
    mode,
    ...(mode === "log" || !sent.ok ? { url: created.url } : {}),
    ...(!sent.ok ? { unconfirmed: true } : {}),
  };
}

// ============================================================
// Logo de la organización (correo de renovación)
// ============================================================

/** PNG, JPEG o GIF: webp y avif no se ven en varios clientes de correo. */
const LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};
const LOGO_MAX_BYTES = 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** El tipo real por los primeros bytes: el que declara el navegador no prueba nada. */
function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const head = buf.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  return null;
}

export async function uploadOrgLogoAction(
  orgId: string,
  formData: FormData,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const analyst = await requireAnalyst();
  if (!isUuid(orgId) || !canAccessOrg(analyst, orgId)) {
    return { ok: false, error: "expirations.errNotFound" };
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "expirations.errLogoType" };
  if (file.size > LOGO_MAX_BYTES) return { ok: false, error: "expirations.errLogoSize" };
  const buffer = Buffer.from(await file.arrayBuffer());
  const mime = sniffImage(buffer);
  if (!mime) return { ok: false, error: "expirations.errLogoType" };

  const supabase = createServiceClient();
  const path = `org-logos/${orgId}/${randomUUID()}.${LOGO_TYPES[mime]}`;
  const { error } = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(path, buffer, { contentType: mime, upsert: false });
  if (error) {
    console.error("[uploadOrgLogoAction] storage falló:", error.message);
    return { ok: false, error: "expirations.errLogoUpload" };
  }
  const url = supabase.storage.from(LOGO_BUCKET).getPublicUrl(path).data.publicUrl;

  const previous = await loadOrgBranding(orgId);
  const { error: upError } = await supabase
    .from("organizations")
    .update({ logo_url: url, logo_path: path })
    .eq("id", orgId);
  if (upError) {
    await supabase.storage.from(LOGO_BUCKET).remove([path]);
    return { ok: false, error: "expirations.errLogoUpload" };
  }
  if (previous.logoPath) await supabase.storage.from(LOGO_BUCKET).remove([previous.logoPath]);

  await logAudit({
    requestId: null,
    orgId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "org_logo_updated",
    metadata: { path, size: file.size, mime },
  });
  return { ok: true, url };
}

export async function removeOrgLogoAction(orgId: string): Promise<Result> {
  const analyst = await requireAnalyst();
  if (!isUuid(orgId) || !canAccessOrg(analyst, orgId)) {
    return { ok: false, error: "expirations.errNotFound" };
  }
  const supabase = createServiceClient();
  const previous = await loadOrgBranding(orgId);
  const { error } = await supabase
    .from("organizations")
    .update({ logo_url: null, logo_path: null })
    .eq("id", orgId);
  if (error) return { ok: false, error: "expirations.errLogoUpload" };
  if (previous.logoPath) await supabase.storage.from(LOGO_BUCKET).remove([previous.logoPath]);
  await logAudit({
    requestId: null,
    orgId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "org_logo_removed",
    metadata: { path: previous.logoPath },
  });
  return { ok: true };
}
