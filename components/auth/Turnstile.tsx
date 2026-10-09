"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { useLocale } from "next-intl";
import { useTheme } from "next-themes";
import { publicEnv } from "@/lib/env.public";

/**
 * Widget de Cloudflare Turnstile. En el login valida el token Supabase Auth
 * (captcha nativo, ver [auth.captcha] en supabase/config.toml): así la
 * protección cubre también a quien llame a /auth/v1 directo con la anon key,
 * que es pública. En "Olvidé mi contraseña" lo valida la app
 * (lib/auth/turnstile.ts), porque el correo lo manda ella.
 *
 * Sin `NEXT_PUBLIC_TURNSTILE_SITE_KEY` no renderiza nada (captcha apagado).
 */

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<void> | null = null;

/** Carga el script una sola vez por página, aunque haya varios widgets. */
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null; // permite reintentar en el próximo montaje
      reject(new Error("turnstile_script"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export interface TurnstileHandle {
  /** El token es de un solo uso: hay que pedir otro después de cada intento. */
  reset: () => void;
}

export const turnstileEnabled = () => Boolean(publicEnv.turnstileSiteKey());

export function Turnstile({
  onToken,
  ref,
}: {
  /** Token nuevo, o `null` cuando vence, falla o se resetea. */
  onToken: (token: string | null) => void;
  ref?: Ref<TurnstileHandle>;
}) {
  const siteKey = publicEnv.turnstileSiteKey();
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  // El callback cambia en cada render del padre; el widget se crea una vez.
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  });
  const locale = useLocale();
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";

  useImperativeHandle(ref, () => ({
    reset() {
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
      onTokenRef.current(null);
    },
  }));

  // Se vuelve a crear si cambia el tema o el idioma (Turnstile no los cambia en
  // caliente); eso invalida el token, así que se avisa `null`.
  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !container.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(container.current, {
          sitekey: siteKey,
          theme,
          language: locale,
          size: "flexible",
          "refresh-expired": "auto",
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => onTokenRef.current(null));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
      onTokenRef.current(null);
    };
  }, [siteKey, theme, locale]);

  if (!siteKey) return null;
  // Alto reservado: sin él el formulario "salta" cuando carga el widget.
  return <div ref={container} className="min-h-[65px] w-full" />;
}
