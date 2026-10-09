import "server-only";
import { env } from "@/lib/env";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 8_000;

/**
 * Valida en el server un token de Turnstile. Lo usan las pantallas cuyo
 * correo arma la app (Olvidé mi contraseña): ahí Supabase no ve el captcha.
 * El login sigue validándolo Supabase (captcha nativo).
 *
 * Sin `TURNSTILE_SECRET_KEY` no se verifica (captcha apagado del lado del
 * server; queda el rate limit).
 */
export async function verifyTurnstile(token: string | null, ip: string | null): Promise<boolean> {
  const secret = env.turnstileSecretKey();
  if (!secret) return true;
  if (!token) return false;
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean };
    return data.success === true;
  } catch (e) {
    console.error("[turnstile] verificación falló:", e instanceof Error ? e.message : e);
    return false;
  }
}
