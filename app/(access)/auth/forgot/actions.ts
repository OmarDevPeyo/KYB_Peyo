"use server";

import { findAuthUserByEmail } from "@/lib/auth/accounts";
import { isEmail, normalizeEmail } from "@/lib/auth/accountRules";
import { sendRecoveryMail } from "@/lib/auth/accountMail";
import { consumeRate } from "@/lib/auth/rateLimit";
import { verifyTurnstile } from "@/lib/auth/turnstile";
import { clientIp } from "@/lib/request/clientIp";
import { createServiceClient } from "@/lib/supabase/service";

/** Pedidos por minuto: por IP y por email. */
const PER_IP_PER_MIN = 5;
const PER_EMAIL_PER_MIN = 2;

/**
 * "Olvidé mi contraseña". El link lo genera la app y sale por Resend
 * (lib/auth/accountMail.ts), así que el captcha y los límites los pone esta
 * acción: generateLink con service role no los aplica.
 *
 * Misma respuesta exista o no la cuenta: si no, este formulario serviría para
 * averiguar qué emails tienen acceso al panel. Solo se informan los errores que
 * no dependen de la cuenta (captcha, límites). `error` es una clave "auth.*".
 */
export async function requestPasswordResetAction(
  emailInput: string,
  captchaToken: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = normalizeEmail(emailInput);
  if (!isEmail(email)) return { ok: false, error: "auth.errEmailInvalid" };

  const ip = await clientIp();
  if (!(await verifyTurnstile(captchaToken, ip))) return { ok: false, error: "auth.errCaptcha" };
  if (!(await consumeRate(`forgot:ip:${ip}`, PER_IP_PER_MIN)).allowed) {
    return { ok: false, error: "auth.errRateLimit" };
  }
  if (!(await consumeRate(`forgot:email:${email}`, PER_EMAIL_PER_MIN)).allowed) {
    return { ok: false, error: "auth.errEmailRateLimit" };
  }

  const user = await findAuthUserByEmail(email);
  if (!user) return { ok: true };
  // Solo cuentas del panel y no suspendidas: con la cuenta suspendida no hay
  // nada que restablecer hasta que la reactiven.
  const { data: row } = await createServiceClient()
    .from("analysts")
    .select("disabled_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!row || row.disabled_at) return { ok: true };

  const sent = await sendRecoveryMail(email);
  if (!sent.ok) console.error(`[forgot] link no enviado: ${sent.error}`);
  return { ok: true };
}
