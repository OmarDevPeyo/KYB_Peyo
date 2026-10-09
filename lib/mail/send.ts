import "server-only";
import { env } from "@/lib/env";

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

/**
 * Cómo salen los correos de la app (renovación al solicitante y los de las
 * cuentas del panel, ver lib/auth/accountMail.ts):
 * - `resend`: con `RESEND_API_KEY` y `APPLICANT_EMAIL_FROM`.
 * - `log`: fuera de producción sin esa configuración. El correo se imprime en
 *   la consola del servidor (como los providers `mock`), para probar el flujo
 *   en local sin mandar nada.
 * - `off`: producción sin configuración. No se envía.
 */
export type MailMode = "resend" | "log" | "off";

export function applicantMailMode(): MailMode {
  if (env.resendApiKey() && env.applicantEmailFrom()) return "resend";
  return process.env.NODE_ENV === "production" ? "off" : "log";
}

export type SendResult =
  | { ok: true; id: string | null }
  /**
   * `definitive`: Resend respondió y rechazó el correo (no salió). Si es
   * `false` (timeout o red) no se sabe si salió.
   */
  | { ok: false; error: string; definitive: boolean };

/**
 * Correo vía Resend, por `fetch` (sin dependencia npm), como
 * `sendAlert`. **Nunca lanza.** `idempotencyKey` evita un duplicado si se
 * reintenta el mismo envío.
 */
export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  idempotencyKey?: string;
}): Promise<SendResult> {
  const mode = applicantMailMode();
  if (mode === "off") {
    return { ok: false, error: "Falta RESEND_API_KEY o APPLICANT_EMAIL_FROM.", definitive: true };
  }
  if (mode === "log") {
    console.log(
      `[mail] (local, no se envía) para=${input.to} asunto="${input.subject}"\n${input.text}`,
    );
    return { ok: true, id: null };
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.resendApiKey()}`,
        "Content-Type": "application/json",
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: env.applicantEmailFrom(),
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[mail] Resend ${res.status}: ${body.slice(0, 300)}`);
      // Un 5xx puede haber llegado a encolarse: solo un 4xx es un rechazo seguro.
      return {
        ok: false,
        error: `Resend ${res.status}`,
        definitive: res.status < 500,
      };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id ?? null };
  } catch (e) {
    console.error("[mail] fallo al enviar:", e instanceof Error ? e.message : e);
    return { ok: false, error: e instanceof Error ? e.message : String(e), definitive: false };
  }
}
