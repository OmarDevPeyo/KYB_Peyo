import "server-only";
import { publicEnv, required } from "./env.public";

/**
 * Acceso centralizado a variables de entorno, SOLO desde el servidor: este
 * módulo expone secretos, así que lleva `server-only` para que importarlo desde
 * un módulo cliente rompa el build en vez de colarse en el bundle.
 *
 * Las `NEXT_PUBLIC_*` viven en `lib/env.public.ts` (que sí puede importar el
 * cliente) y se re-exportan acá para que el servidor siga teniendo un único
 * objeto `env`.
 */
export const env = {
  ...publicEnv,
  supabaseServiceRoleKey: () =>
    required(
      "SUPABASE_SERVICE_ROLE_KEY",
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    ),
  amlProvider: () => process.env.AML_PROVIDER ?? "mock",
  diditApiUrl: () => process.env.DIDIT_API_URL ?? "",
  diditApiKey: () => process.env.DIDIT_API_KEY ?? "",
  diditWebhookSecret: () => process.env.DIDIT_WEBHOOK_SECRET ?? "",
  // Secreto compartido para firmar el webhook saliente hacia el cliente API.
  kybWebhookSecret: () => process.env.KYB_WEBHOOK_SECRET ?? "",
  // Clave (32 bytes base64) para cifrar secretos de webhook por endpoint (AES-256-GCM).
  secretEncKey: () => process.env.KYB_SECRET_ENC_KEY ?? "",
  // Secreto compartido para autorizar los crons (Vercel Cron envía
  // `Authorization: Bearer $CRON_SECRET`). Sin él, las rutas cron responden 401.
  cronSecret: () => process.env.CRON_SECRET ?? "",
  // --- Alertas operativas por correo (Resend) ---
  // Sin `RESEND_API_KEY` las alertas se omiten con un warn: nunca deben tumbar
  // el proceso que las dispara (p. ej. el drenado de webhooks).
  resendApiKey: () => process.env.RESEND_API_KEY ?? "",
  alertEmailFrom: () => process.env.ALERT_EMAIL_FROM ?? "PEYO Forms <onboarding@resend.dev>",
  alertEmailTo: () => process.env.ALERT_EMAIL_TO ?? "",
  // Remitente de los correos al solicitante (renovación de documentos). Tiene
  // que ser de un dominio verificado en Resend: el de prueba (resend.dev) solo
  // entrega al dueño de la cuenta. Sin él, en producción no se envía.
  applicantEmailFrom: () => process.env.APPLICANT_EMAIL_FROM ?? "",
  // Secreta de Cloudflare Turnstile para "Olvidé mi contraseña", que valida el
  // token en el server (el link lo genera la app, no Supabase). Sin ella no se
  // verifica el captcha y queda solo el rate limit.
  turnstileSecretKey: () => process.env.TURNSTILE_SECRET_KEY?.trim() ?? "",
  // --- Traducción con IA (formularios y respuestas) ---
  // `mock` por defecto: un entorno sin configurar nunca gasta tokens.
  translateProvider: () => process.env.TRANSLATE_PROVIDER ?? "mock",
  openaiApiKey: () => process.env.OPENAI_API_KEY ?? "",
  // El glosario carga el peso de la calidad, así que un modelo mini suele
  // alcanzar y sale ~4x más barato. Medí con `npm run i18n:eval` antes de bajar.
  translateModel: () => process.env.OPENAI_TRANSLATE_MODEL ?? "gpt-4.1",
  // --- Generación de PDF (informe de solicitud) ---
  // Solo desarrollo: ruta al Chrome/Edge del sistema. En serverless se usa el
  // binario de `@sparticuz/chromium` y esta variable se deja vacía.
  chromePath: () => process.env.CHROME_EXECUTABLE_PATH ?? "",
  // --- País de la IP del solicitante ---
  // Vercel pone `VERCEL=1` en sus funciones. Solo ahí el header
  // `x-vercel-ip-country` es de fiar: Vercel lo escribe y el cliente no lo elige.
  onVercel: () => process.env.VERCEL === "1",
  // Solo desarrollo: país (alpha-2) que se registra al enviar fuera de Vercel,
  // para ver el dato y la alerta en local. En producción no se lee.
  devIpCountry: () => process.env.KYB_DEV_IP_COUNTRY ?? "",
  // Límite de tasa por defecto (req/min por API key) si la key no fija uno propio.
  apiRateLimitDefault: () => {
    const n = Number(process.env.API_RATE_LIMIT_DEFAULT_PER_MIN);
    return Number.isFinite(n) && n > 0 ? n : 60;
  },
};
