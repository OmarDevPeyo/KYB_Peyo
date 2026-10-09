import "server-only";
import { createHash } from "crypto";
import { env } from "@/lib/env";
import { applicantMailMode, sendEmail } from "@/lib/mail/send";
import {
  buildAccessEmail,
  buildEmailChangeEmail,
  buildEmailChangeNoticeEmail,
  buildPasswordChangedEmail,
  buildRecoveryEmail,
  type AccountEmail,
} from "@/lib/mail/accountTemplates";
import { createServiceClient } from "@/lib/supabase/service";
import { loginPath, portalFor, type Role } from "./accountRules";

/**
 * Correos de las cuentas del panel. Supabase Auth NO manda ninguno: acá se
 * pide el token con `generateLink` (que no envía nada), se arma el link a
 * nuestra /auth/confirm con `NEXT_PUBLIC_APP_URL` y el correo sale por Resend.
 * Así no dependen del SMTP, las plantillas ni el Site URL del dashboard de
 * Supabase.
 *
 * `error` es una clave de i18n completa ("auth.*").
 */
export type MailOutcome = { ok: true } | { ok: false; error: string };

const appUrl = () => env.appUrl().replace(/\/+$/, "");

/**
 * ¿Se pueden mandar correos? En producción, no sin Resend configurado ni sin
 * `NEXT_PUBLIC_APP_URL`: los links caerían en el fallback a localhost.
 */
export function accountMailReady(): boolean {
  const urlSet = Boolean(process.env.NEXT_PUBLIC_APP_URL) || process.env.NODE_ENV !== "production";
  return urlSet && applicantMailMode() !== "off";
}

async function deliver(to: string, mail: AccountEmail): Promise<MailOutcome> {
  if (!accountMailReady()) return { ok: false, error: "auth.errMailNotConfigured" };
  const res = await sendEmail({ to, ...mail });
  return res.ok ? { ok: true } : { ok: false, error: "auth.errMailFailed" };
}

/**
 * Link de un solo uso a /auth/confirm. `email_change_new` cambia el email
 * cuando se confirma desde la dirección nueva (con "Secure email change"
 * apagado en Supabase: una sola confirmación).
 */
async function authLink(
  params: { type: "recovery"; email: string } | { type: "email_change_new"; email: string; newEmail: string },
): Promise<string | null> {
  const { data, error } = await createServiceClient().auth.admin.generateLink(params);
  const props = data?.properties;
  // En email_change_new, GoTrue devuelve el hash calculado con el email VIEJO,
  // pero guarda (y verifica) sha224(email nuevo + código): con el que devuelve,
  // verifyOtp responde otp_expired. Se arma con el código, como lo guarda.
  const token =
    params.type === "email_change_new" && props?.email_otp
      ? createHash("sha224").update(params.newEmail + props.email_otp).digest("hex")
      : props?.hashed_token;
  if (error || !token) {
    console.error(`[accountMail] generateLink ${params.type} falló:`, error?.message ?? "sin token");
    return null;
  }
  const type = params.type === "recovery" ? "recovery" : "email_change";
  return `${appUrl()}/auth/confirm?token_hash=${encodeURIComponent(token)}&type=${type}`;
}

/** Contraseña temporal para entrar (alta de la cuenta o reenvío del acceso). */
export function sendAccessMail(input: {
  email: string;
  password: string;
  role: Role;
  resent: boolean;
}): Promise<MailOutcome> {
  return deliver(
    input.email,
    buildAccessEmail({
      appUrl: appUrl(),
      email: input.email,
      password: input.password,
      role: input.role,
      loginUrl: `${appUrl()}${loginPath(portalFor(input.role))}`,
      resent: input.resent,
    }),
  );
}

/** Link para elegir una contraseña nueva. */
export async function sendRecoveryMail(email: string): Promise<MailOutcome> {
  if (!accountMailReady()) return { ok: false, error: "auth.errMailNotConfigured" };
  const link = await authLink({ type: "recovery", email });
  if (!link) return { ok: false, error: "auth.errGeneric" };
  return deliver(email, buildRecoveryEmail({ appUrl: appUrl(), email, link }));
}

/**
 * Cambio de email: link de confirmación a la dirección nueva y aviso (sin
 * link) a la vieja. El aviso es de cortesía: si falla, el cambio sigue.
 */
export async function sendEmailChangeMails(oldEmail: string, newEmail: string): Promise<MailOutcome> {
  if (!accountMailReady()) return { ok: false, error: "auth.errMailNotConfigured" };
  const link = await authLink({ type: "email_change_new", email: oldEmail, newEmail });
  if (!link) return { ok: false, error: "auth.errGeneric" };
  const sent = await deliver(newEmail, buildEmailChangeEmail({ appUrl: appUrl(), oldEmail, newEmail, link }));
  if (!sent.ok) return sent;
  await deliver(oldEmail, buildEmailChangeNoticeEmail({ appUrl: appUrl(), oldEmail, newEmail }));
  return { ok: true };
}

/** Aviso de contraseña cambiada. De cortesía: nunca hace fallar el cambio. */
export async function sendPasswordChangedMail(email: string): Promise<void> {
  const res = await deliver(
    email,
    buildPasswordChangedEmail({ appUrl: appUrl(), email, forgotUrl: `${appUrl()}/auth/forgot` }),
  );
  if (!res.ok) console.warn(`[accountMail] aviso de contraseña cambiada no enviado: ${res.error}`);
}
