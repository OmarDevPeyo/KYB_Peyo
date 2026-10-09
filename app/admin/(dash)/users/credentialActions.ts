"use server";

import { findAuthUserByEmail, isPendingInvite } from "@/lib/auth/accounts";
import { isEmail, normalizeEmail, type Role } from "@/lib/auth/accountRules";
import { listOrgs } from "@/lib/auth/tenant";
import { isUuid } from "@/lib/auth/tenantRules";
import { passwordIssues } from "@/lib/auth/passwordPolicy";
import { sendRecoveryMail } from "@/lib/auth/accountMail";
import { logAudit } from "@/lib/kyb/service";
import { sendAlert } from "@/lib/mail/alert";
import { createServiceClient } from "@/lib/supabase/service";
import {
  accountAdmin,
  inviteRedirect,
  loadTarget,
  mailRate,
  revalidateAccounts,
  stepUp,
  type AccountResult,
} from "./guards";

/**
 * Credenciales de otras cuentas: crear por invitación, reenviar o cancelar la
 * invitación, link para restablecer la contraseña, cambiar email y definir
 * contraseña. Mismo esquema que actions.ts (admin con 2FA, reglas de
 * accountRules, service role, auditoría); lo que da acceso nuevo (invitar,
 * cambiar email o contraseña) vuelve a pedir la contraseña del admin.
 *
 * A otro admin solo se le manda el link de restablecer (canManageAccount).
 */

const AUTH_ERRORS: Record<string, string> = {
  email_exists: "auth.errEmailTaken",
  email_address_invalid: "auth.errEmailInvalid",
  weak_password: "auth.errWeakPassword",
  over_email_send_rate_limit: "auth.errEmailRateLimit",
};
const authErrorKey = (error: { code?: string }) => AUTH_ERRORS[error.code ?? ""] ?? "auth.errGeneric";

export type CreateAccountResult =
  | { ok: true; userId: string; linked: boolean }
  | { ok: false; error: string; existingUserId?: string };

/**
 * Cuenta nueva. Casos según lo que ya haya en Auth:
 * - ya tiene fila en `analysts` → error, con el id para ir a esa cuenta;
 * - usuario de Auth sin fila, con la invitación pendiente → se reinvita;
 * - usuario de Auth sin fila que ya entró alguna vez → se vincula sin correo
 *   (conserva su contraseña; si no la recuerda, se le manda el link);
 * - nada → invitación por email.
 */
export async function createAccountAction(
  input: { email: string; fullName: string; orgId: string; role: Role },
  stepUpPassword: string,
): Promise<CreateAccountResult> {
  const gate = await accountAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;

  const email = normalizeEmail(input.email);
  if (!isEmail(email)) return { ok: false, error: "auth.errEmailInvalid" };
  const fullName = input.fullName.trim().replace(/\s+/g, " ").slice(0, 120) || null;
  const role: Role = input.role === "admin" ? "admin" : "analyst";
  const org = isUuid(input.orgId) ? (await listOrgs()).find((o) => o.id === input.orgId) : undefined;
  if (!org || org.disabled) return { ok: false, error: "accounts.errOrgInvalid" };

  const denied = await stepUp(actor, stepUpPassword);
  if (denied) return { ok: false, error: denied };

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
  const linked = Boolean(authUser && !isPendingInvite(authUser));
  let userId = authUser?.id ?? null;
  if (!linked) {
    const limited = await mailRate(actor);
    if (limited) return { ok: false, error: limited };
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo: inviteRedirect(),
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

  await logAudit({
    requestId: null,
    orgId: org.id,
    actor: actor.email,
    actorUserId: actor.userId,
    action: linked ? "account_linked" : "account_invited",
    metadata: { targetUserId: userId, targetEmail: email, role },
  });
  if (role === "admin") {
    await sendAlert(`[KYB] Nueva cuenta admin: ${email}`, [
      `${actor.email} ${linked ? "vinculó" : "invitó"} a ${email} con rol admin.`,
    ]);
  }
  revalidateAccounts();
  return { ok: true, userId: userId as string, linked };
}

/** Vuelve a mandar la invitación (token nuevo; el anterior deja de servir). */
export async function resendInviteAction(userId: string): Promise<AccountResult> {
  const gate = await accountAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const loaded = await loadTarget(actor, userId, "resendInvite");
  if (!loaded.ok) return loaded;
  const { target } = loaded;
  const limited = await mailRate(actor);
  if (limited) return { ok: false, error: limited };

  const { error } = await createServiceClient().auth.admin.inviteUserByEmail(target.email, {
    data: { full_name: target.fullName },
    redirectTo: inviteRedirect(),
  });
  if (error) return { ok: false, error: authErrorKey(error) };

  await logAudit({
    requestId: null,
    orgId: target.orgId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "invite_resent",
    metadata: { targetUserId: userId, targetEmail: target.email },
  });
  revalidateAccounts(userId);
  return { ok: true };
}

/**
 * Cancela una invitación que nunca se aceptó: borra el usuario de Auth (la
 * fila de `analysts` cae en cascada). Una cuenta que ya entró no se borra: se
 * suspende.
 */
export async function cancelInviteAction(userId: string): Promise<AccountResult> {
  const gate = await accountAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const loaded = await loadTarget(actor, userId, "cancelInvite");
  if (!loaded.ok) return loaded;
  const { target } = loaded;

  const supabase = createServiceClient();
  // Se relee justo antes de borrar: pudo aceptar la invitación recién.
  const { data } = await supabase.auth.admin.getUserById(userId);
  if (!isPendingInvite(data.user ?? undefined)) return { ok: false, error: "accounts.errNotPending" };
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) return { ok: false, error: "auth.errGeneric" };

  await logAudit({
    requestId: null,
    orgId: target.orgId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "invite_cancelled",
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
 * Cambia el email sin doble confirmación (lo hace un admin). Si la invitación
 * estaba pendiente se reinvita al email nuevo: el token enviado al email
 * equivocado sigue sirviendo hasta que se emite otro.
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
    const limited = await mailRate(actor);
    if (limited) return { ok: false, error: limited };
  }

  const supabase = createServiceClient();
  // `analysts.email` lo actualiza el trigger de 0026. Una invitación pendiente
  // queda sin confirmar: con el email confirmado GoTrue ya no la reinvita.
  const { error } = await supabase.auth.admin.updateUserById(
    userId,
    target.pending ? { email } : { email, email_confirm: true },
  );
  if (error) return { ok: false, error: authErrorKey(error) };
  if (target.pending) {
    const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { full_name: target.fullName },
      redirectTo: inviteRedirect(),
    });
    if (inviteError) console.error("[accounts] reinvitar tras cambio de email falló:", inviteError.message);
  }

  await logAudit({
    requestId: null,
    orgId: target.orgId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "account_email_changed",
    metadata: { targetUserId: userId, from: target.email, to: email, reinvited: target.pending },
  });
  revalidateAccounts(userId);
  return { ok: true };
}

/**
 * Define la contraseña de otra cuenta (no de un admin) y le cierra todas las
 * sesiones. Si la invitación estaba pendiente, la cuenta queda confirmada.
 */
export async function setPasswordAction(
  userId: string,
  password: string,
  stepUpPassword: string,
): Promise<AccountResult> {
  const gate = await accountAdmin();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const loaded = await loadTarget(actor, userId, "setPassword");
  if (!loaded.ok) return loaded;
  const { target } = loaded;
  if (passwordIssues(password).length > 0) return { ok: false, error: "auth.errWeakPassword" };
  const denied = await stepUp(actor, stepUpPassword);
  if (denied) return { ok: false, error: denied };

  const supabase = createServiceClient();
  const { error } = await supabase.auth.admin.updateUserById(userId, {
    password,
    ...(target.pending ? { email_confirm: true } : {}),
  });
  if (error) return { ok: false, error: authErrorKey(error) };
  const { error: revokeError } = await supabase.rpc("admin_revoke_sessions", { p_user_id: userId });
  if (revokeError) console.error("[accounts] admin_revoke_sessions falló:", revokeError.message);

  await logAudit({
    requestId: null,
    orgId: target.orgId,
    actor: actor.email,
    actorUserId: actor.userId,
    action: "account_password_set",
    metadata: { targetUserId: userId, targetEmail: target.email, sessionsRevoked: !revokeError },
  });
  revalidateAccounts(userId);
  return { ok: true };
}
