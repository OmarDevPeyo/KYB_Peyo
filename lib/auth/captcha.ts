/**
 * TEMPORAL (2026-10-09): Turnstile en pausa en todo el panel (login y
 * "Olvidé mi contraseña"). La site key publicada en producción es inválida
 * (Turnstile responde 400020 y los botones nunca se habilitan) y por ahora no
 * hay acceso a Vercel para corregirla.
 *
 * En pausa no se muestra el widget ni se verifica el token en el server. El
 * login sigue andando porque Supabase Auth de producción no exige captcha; a
 * "Olvidé mi contraseña" lo cubre su rate limit por IP y por email.
 *
 * Para reactivar: cargar en Vercel la Site Key correcta (24 caracteres) en
 * `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, redesplegar y recién ahí poner `false`.
 *
 * Puro (sin `@/`): lo importan el widget (cliente) y la verificación (server).
 */
export const CAPTCHA_PAUSED = true;
