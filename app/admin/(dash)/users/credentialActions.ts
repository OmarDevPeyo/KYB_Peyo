"use server";

import { accessMetadata, findAuthUserByEmail, isPendingAccess } from "@/lib/auth/accounts";
import { isEmail, normalizeEmail, type Role } from "@/lib/auth/accountRules";
import { listOrgs } from "@/lib/auth/tenant";
import { isUuid } from "@/lib/auth/tenantRules";
import { accountMailReady, sendAccessMail, sendRecoveryMail } from "@/lib/auth/accountMail";
import { generateTempPassword } from "@/lib/auth/tempPassword";
import { logAudit } from "@/lib/kyb/service";
import { sendAlert } from "@/lib/mail/alert";
import { createServiceClient } from "@/lib/supabase/service";
import {
  accountAdmin,
  loadTarget,
  mailRate,
  revalidateAccounts,
  stepUp,
  type AccountResult,
} from "./guards";

/**
 * Credenciales de otras cuentas: alta, reenviar o cancelar el acceso de quien
 * nunca entró, link para restablecer la contraseña y cambiar email. Mismo
 * esquema que actions.ts (admin con 2FA, reglas de accountRules, service role,
 * auditoría).
 *
 * El acceso es una contraseña temporal que le llega a la persona por correo
 * (Resend, lib/auth/accountMail.ts): el admin nunca la ve, y en el primer
 * ingreso la persona elige la suya (app_metadata.must_change_password →
 * /auth/welcome). Ningún admin define la contraseña de otra cuenta.
 *
 * Crear la cuenta no pide la contraseña del admin (las de rol admin disparan
 * una alerta por correo y todo queda en la auditoría); cambiar el email sí.
 */

const AUTH_ERRORS: Record<string, string> = {
  email_exists: "auth.errEmailTaken",
  email_address_invalid: "auth.errEmailInvalid",
  weak_password: "auth.errWeakPassword",
};
const authErrorKey = (error: { code?: string }) => AUTH_ERRORS[error.code ?? ""] ?? "auth.errGeneric";

/**
 * Contraseña temporal nueva para una cuenta existente (queda confirmada y
 * marcada para elegir la suya al entrar) y el correo con el acceso. Sin
 * exportar: lo que exporta un módulo "use server" se puede llamar desde el
 * navegador.
 */
async function grantAccess(target: { userId: string; email: string; role: Role }): Promise<AccountResult> {
  const password = generateTempPassword();
  const { error } = await createServiceClient().auth.admin.updateUserById(target.userId, {
    password,
    email_confirm: true,
    app_metadata: accessMetadata(),
  });
  if (error) return { ok: false, error: authErrorKey(error) };
  return sendAccessMail({ email: target.email, password, role: target.role, resent: true });
}

export type CreateAccountResult =
  | { ok: true; userId: string; linked: boolean }
  | { ok: false; error: string; existingUserId?: string };

/**
 * Cuenta nueva. Casos según lo que ya haya en Auth:
 * - ya tiene fila en `analysts` → error, con el id para ir a esa cuenta;
 * - usuario de Auth sin fila que nunca entró → acceso nuevo por correo;
 * - usuario de Auth sin fila que ya entró alguna vez → se vincula sin correo
 *   (conserva su contraseña; si no la recuerda, se le manda el link);
 * - nada → se crea con contraseña temporal y le llega por correo.
 *
 * Si el correo no sale, la persona no tiene cómo entrar: se deshace el alta.
 */
export async function createAccountAction(input: {
  email: string;
  fullName: string;
  orgId: string;
  role: Role;
}): Promise<CreateAccountResult> {
  const gate = await accountAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;

  const email = normalizeEmail(input.email);
  if (!isEmail(email)) return { ok: false, error: "auth.errEmailInvalid" };
  const fullName = input.fullName.trim().replace(/\s+/g, " ").slice(0, 120) || null;
  const role: Role = input.role === "admin" ? "admin" : "analyst";
  const org = isUuid(input.orgId) ? (await listOrgs()).find((o) => o.id === input.orgId) : undefined;
  if (!org || org.disabled) return { ok: false, error: "accounts.errOrgInvalid" };

  const supabase = createServiceClient();
  const { data: existingRow } = await supabase
    .from("analysts")
    .select("user_id")
    .eq("email", email) // GoTrue guarda el email en minúsculas y 0026 lo copia
    .limit(1)
    .maybeSingle();
  if (existingRow) {
    return { ok: false, error: "accounts.errAccountExists", existingUserId: existingRow.user_id as string };
  }

  const authUser = await findAuthUserByEmail(email);
  const linked = Boolean(authUser && !isPendingAccess(authUser));
  let userId = authUser?.id ?? null;
  let password: string | null = null;
  if (!linked) {
    if (!accountMailReady()) return { ok: false, error: "auth.errMailNotConfigured" };
    const limited = await mailRate(actor);
    if (limited) return { ok: false, error: limited };
    password = generateTempPassword();
    const { data, error } = authUser
      ? await supabase.auth.admin.updateUserById(authUser.id, {
          password,
          email_confirm: true,
          app_metadata: accessMetadata(),
        })
      : await supabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName },
          app_metadata: accessMetadata(),
        });
    if (error || !data.user) return { ok: false, error: error ? authErrorKey(error) : "auth.errGeneric" };
    userId = data.user.id;
  } else if (authUser?.banned_until) {
    // Baneado por el script viejo de provisión: la suspensión ya no usa ban.
    await supabase.auth.admin.updateUserById(authUser.id, { ban_duration: "none" });
  }

  // INSERT, no upsert: si otra pestaña la creó recién, que falle.
  const { error } = await supabase
    .from("analysts")
    .insert({ user_id: userId, email, full_name: fullName, role, org_id: org.id });
  if (error) {
    // Usuario recién creado que quedó sin fila: se borra para no dejar huérfanos.
    if (!authUser && userId) await supabase.auth.admin.deleteUser(userId);
    return { ok: false, error: error.code === "23505" ? "accounts.errAccountExists" : "auth.errGeneric" };
  }

  if (password) {
    const sent = await sendAccessMail({ email, password, role, resent: false });
    if (!sent.ok) {
      // Sin el correo no puede entrar: se deshace (la fila cae en cascada).
      if (!authUser) await supabase.auth.admin.deleteUser(userId as string);
      else await supabase.from("analysts").delete().eq("user_id", userId as string);
      return { ok: false, error: sent.error };
    }
  }

  await logAudit({
    requestId: null,
    orgId: org.id,
    actor: actor.email,
    actorUserId: actor.userId,
    action: linked ? "account_linked" : "account_created",
    metadata: { targetUserId: userId, targetEmail: email, role },
  });
  if (role === "admin") {
    await sendAlert(`[KYB] Nueva cuenta admin: ${email}`, [
      `${actor.email} ${linked ? "vinculó" : "creó"} la cuenta ${email} con rol admin.`,
    ]);
  }
  revalidateAccounts();
  return { ok: true, userId: userId as string, linked };
}

/** Contraseña temporal nueva por correo; la anterior deja de servir. */
export async function resendAccessAction(userId: string): Promise<AccountResult> {
  const gate = await accountAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const loaded = await loadTarget(actor, userId, "resendAccess");
  if (!loaded.ok) return loaded;
  const { target } = loaded;
  if (!accountMailReady()) return { ok: false, error: "auth.errMailNotConfigured" };
  const limited = await mailRate(actor);
  if (limited) return { ok: false, error: limited };

  const res = await grantAccess(target);
  if (!res.ok) return res;

  await logAudit({
    requestId: null,
    orgId: target.orgId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "access_resent",
    metadata: { targetUserId: userId, targetEmail: target.email },
  });
  revalidateAccounts(userId);
  return { ok: true };
}

/**
 * Cancela el acceso de una cuenta que nunca entró: borra el usuario de Auth
 * (la fila de `analysts` cae en cascada). Una cuenta que ya entró no se borra:
 * se suspende.
 */
export async function cancelPendingAction(userId: string): Promise<AccountResult> {
  const gate = await accountAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const loaded = await loadTarget(actor, userId, "cancelPending");
  if (!loaded.ok) return loaded;
  const { target } = loaded;

  const supabase = createServiceClient();
  // Se relee justo antes de borrar: pudo entrar recién.
  const { data } = await supabase.auth.admin.getUserById(userId);
  if (!isPendingAccess(data.user ?? undefined)) return { ok: false, error: "accounts.errNotPending" };
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) return { ok: false, error: "auth.errGeneric" };

  await logAudit({
    requestId: null,
    orgId: target.orgId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "access_cancelled",
    metadata: { targetUserId: userId, targetEmail: target.email, role: target.role },
  });
  revalidateAccounts();
  return { ok: true };
}

/** Manda el link para restablecer la contraseña (también a otro admin). */
export async function sendResetLinkAction(userId: string): Promise<AccountResult> {
  const gate = await accountAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const loaded = await loadTarget(actor, userId, "resetLink");
  if (!loaded.ok) return loaded;
  const { target } = loaded;
  const limited = await mailRate(actor);
  if (limited) return { ok: false, error: limited };

  const sent = await sendRecoveryMail(target.email);
  if (!sent.ok) return sent;

  await logAudit({
    requestId: null,
    orgId: target.orgId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "reset_link_sent",
    metadata: { targetUserId: userId, targetEmail: target.email },
  });
  return { ok: true };
}

/**
 * TEMPORAL (se da de baja más adelante): contraseña temporal nueva por correo
 * a otro admin que ya entró. El update de admin le cierra todas las sesiones y
 * al entrar tiene que elegir la suya (/auth/welcome). Sin step-up, como el link
 * de restablecer: la contraseña le llega a su correo, no a quien aprieta el
 * botón.
 */
export async function sendAdminPasswordAction(userId: string): Promise<AccountResult> {
  const gate = await accountAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const loaded = await loadTarget(actor, userId, "sendAdminPassword");
  if (!loaded.ok) return loaded;
  const { target } = loaded;
  if (!accountMailReady()) return { ok: false, error: "auth.errMailNotConfigured" };
  const limited = await mailRate(actor);
  if (limited) return { ok: false, error: limited };

  const res = await grantAccess(target);
  if (!res.ok) return res;

  await logAudit({
    requestId: null,
    orgId: target.orgId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "admin_password_sent",
    metadata: { targetUserId: userId, targetEmail: target.email },
  });
  await sendAlert(`[KYB] Contraseña nueva para admin: ${target.email}`, [
    `${actor.email} le mandó por correo una contraseña temporal nueva a ${target.email}.`,
    "Se le cerraron las sesiones abiertas y al entrar tiene que elegir la suya.",
  ]);
  revalidateAccounts(userId);
  return { ok: true };
}

/**
 * Cambia el email sin confirmación por correo (lo hace un admin). Si nunca
 * entró, el acceso se manda de nuevo al email nuevo con otra contraseña
 * temporal: la que le llegó a la dirección equivocada deja de servir.
 */
export async function changeEmailAction(
  userId: string,
  newEmail: string,
  stepUpPassword: string,
): Promise<AccountResult> {
  const gate = await accountAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const loaded = await loadTarget(actor, userId, "email");
  if (!loaded.ok) return loaded;
  const { target } = loaded;

  const email = normalizeEmail(newEmail);
  if (!isEmail(email)) return { ok: false, error: "auth.errEmailInvalid" };
  if (email === target.email.toLowerCase()) return { ok: false, error: "accounts.errSameEmail" };
  const denied = await stepUp(actor, stepUpPassword);
  if (denied) return { ok: false, error: denied };
  // El update de admin no chequea duplicados: GoTrue responde 500 por el
  // índice único de auth.users. Se chequea antes para dar el error correcto.
  if (await findAuthUserByEmail(email)) return { ok: false, error: "auth.errEmailTaken" };
  if (target.pending) {
    if (!accountMailReady()) return { ok: false, error: "auth.errMailNotConfigured" };
    const limited = await mailRate(actor);
    if (limited) return { ok: false, error: limited };
  }

  // `analysts.email` lo actualiza el trigger de 0026.
  const { error } = await createServiceClient().auth.admin.updateUserById(userId, {
    email,
    email_confirm: true,
  });
  if (error) return { ok: false, error: authErrorKey(error) };
  let accessSent = false;
  if (target.pending) {
    const res = await grantAccess({ userId, email, role: target.role });
    accessSent = res.ok;
    if (!res.ok) console.error("[accounts] acceso al email nuevo no enviado:", res.error);
  }

  await logAudit({
    requestId: null,
    orgId: target.orgId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "account_email_changed",
    metadata: { targetUserId: userId, from: target.email, to: email, accessSent },
  });
  revalidateAccounts(userId);
  // El email cambió igual: si el acceso no salió, se reenvía desde la cuenta.
  if (target.pending && !accessSent) return { ok: false, error: "accounts.errEmailChangedNoAccess" };
  return { ok: true };
}
