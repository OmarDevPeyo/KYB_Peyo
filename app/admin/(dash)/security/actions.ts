"use server";

import { revalidatePath } from "next/cache";
import { requireAnalyst, type Analyst } from "@/lib/auth/admin";
import { checkCurrentPassword as checkPassword } from "@/lib/auth/stepUp";
import { passwordIssues } from "@/lib/auth/passwordPolicy";
import { isEmail, normalizeEmail } from "@/lib/auth/accountRules";
import { findAuthUserByEmail } from "@/lib/auth/accounts";
import { sendEmailChangeMails, sendPasswordChangedMail } from "@/lib/auth/accountMail";
import { consumeRate } from "@/lib/auth/rateLimit";
import { logAudit } from "@/lib/kyb/service";
import { createServerSupabase } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Acciones del apartado Seguridad. Todas actúan sobre la cuenta de quien está
 * en sesión (nunca reciben un id de usuario desde el navegador).
 *
 * `error` es una clave del namespace "security" o "auth" (el cliente la
 * traduce); nunca el mensaje crudo de Supabase.
 */
type Result = { ok: true } | { ok: false; error: string };

/** La contraseña actual (lib/auth/stepUp.ts, con rate limit por usuario). */
function checkCurrentPassword(analyst: Analyst, password: string) {
  return checkPassword(analyst.userId, password);
}

const PASSWORD_ERRORS = { wrong: "security.errCurrentPassword", limited: "auth.errRateLimit" } as const;

/** Nombre visible (sidebar, auditoría). */
export async function updateProfileAction(fullName: string): Promise<Result> {
  const analyst = await requireAnalyst();
  const clean = fullName.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!clean) return { ok: false, error: "security.errNameRequired" };
  const { error } = await createServiceClient()
    .from("analysts")
    .update({ full_name: clean })
    .eq("user_id", analyst.userId);
  if (error) return { ok: false, error: "auth.errGeneric" };
  revalidatePath("/admin", "layout");
  return { ok: true };
}

/**
 * Cambio de contraseña. Pide la actual, exige la política (Supabase la vuelve
 * a exigir) y cierra las OTRAS sesiones: si alguien más tenía la contraseña
 * vieja, queda afuera. Con 2FA activo la sesión ya es aal2 (requireAnalyst).
 */
export async function changePasswordAction(
  currentPassword: string,
  newPassword: string,
): Promise<Result> {
  const analyst = await requireAnalyst();
  const check = await checkCurrentPassword(analyst, currentPassword);
  if (check !== "ok") return { ok: false, error: PASSWORD_ERRORS[check] };
  if (passwordIssues(newPassword).length > 0) return { ok: false, error: "auth.errWeakPassword" };
  if (newPassword === currentPassword) return { ok: false, error: "auth.errSamePassword" };

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    return {
      ok: false,
      error: error.code === "same_password" ? "auth.errSamePassword" : error.code === "weak_password" ? "auth.errWeakPassword" : "auth.errGeneric",
    };
  }
  await supabase.auth.signOut({ scope: "others" });

  await logAudit({
    requestId: null,
    orgId: analyst.orgId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "password_changed",
  });
  await sendPasswordChangedMail(analyst.email);
  return { ok: true };
}

/** Pedidos de cambio de email por usuario y minuto (cada uno manda 2 correos). */
const EMAIL_CHANGES_PER_MIN = 3;

/**
 * Cambio de email. Pide la contraseña actual; la app manda (Resend) el link de
 * confirmación a la dirección nueva y un aviso a la vieja. El email cambia
 * cuando se confirma desde la nueva ("Secure email change" apagado en
 * Supabase). `analysts.email` se actualiza solo (trigger de 0026).
 */
export async function changeEmailAction(
  newEmail: string,
  currentPassword: string,
): Promise<Result> {
  const analyst = await requireAnalyst();
  const email = normalizeEmail(newEmail);
  if (!isEmail(email)) return { ok: false, error: "auth.errEmailInvalid" };
  if (email === analyst.email.toLowerCase()) return { ok: false, error: "security.errSameEmail" };

  const check = await checkCurrentPassword(analyst, currentPassword);
  if (check !== "ok") return { ok: false, error: PASSWORD_ERRORS[check] };

  if (!(await consumeRate(`emailchange:${analyst.userId}`, EMAIL_CHANGES_PER_MIN)).allowed) {
    return { ok: false, error: "auth.errEmailRateLimit" };
  }
  if (await findAuthUserByEmail(email)) return { ok: false, error: "auth.errEmailTaken" };
  const sent = await sendEmailChangeMails(analyst.email, email);
  if (!sent.ok) return sent;

  await logAudit({
    requestId: null,
    orgId: analyst.orgId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "email_change_requested",
    metadata: { to: email },
  });
  return { ok: true };
}

/** Cierra todas las sesiones de la cuenta menos esta. */
export async function signOutOthersAction(): Promise<Result> {
  const analyst = await requireAnalyst();
  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signOut({ scope: "others" });
  if (error) return { ok: false, error: "auth.errGeneric" };
  await logAudit({
    requestId: null,
    orgId: analyst.orgId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: "signed_out_others",
  });
  return { ok: true };
}

/**
 * Deja registro de que se activó o desactivó el 2FA. El cambio en sí lo hace
 * el navegador con la API de MFA de Supabase (sobre su propia sesión).
 */
export async function logMfaChangeAction(enabled: boolean): Promise<void> {
  const analyst = await requireAnalyst();
  await logAudit({
    requestId: null,
    orgId: analyst.orgId,
    actor: analyst.email,
    actorUserId: analyst.userId,
    action: enabled ? "mfa_enabled" : "mfa_disabled",
  });
}
