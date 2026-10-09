"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LoaderCircle, LogIn } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { authErrorKey } from "@/lib/auth/authErrors";
import { Turnstile, turnstileEnabled, type TurnstileHandle } from "@/components/auth/Turnstile";
import { PasswordInput } from "@/components/auth/PasswordInput";
import {
  AuthAlert,
  AuthLabel,
  authButtonCls,
  authInputCls,
} from "@/components/auth/authUi";
import type { Portal } from "@/lib/auth/accountRules";
import { postLoginAction } from "@/app/(access)/actions";

export function LoginForm({ portal }: { portal: Portal }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);
  // En pausa por ahora (lib/auth/captcha.ts).
  const needsCaptcha = turnstileEnabled();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (needsCaptcha && !captcha) {
      setError(t("errCaptchaPending"));
      return;
    }
    setLoading(true);
    setError(null);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
      options: captcha ? { captchaToken: captcha } : undefined,
    });
    if (error) {
      setLoading(false);
      setError(t(authErrorKey(error)));
      // El token de Turnstile ya se gastó en este intento.
      turnstile.current?.reset();
      return;
    }

    // El server decide el destino según la cuenta: el panel, el paso del
    // código (2FA), la pantalla de suspendido… o nada, si la cuenta no es de
    // este portal (cada rol entra por su propio login).
    let outcome: Awaited<ReturnType<typeof postLoginAction>>;
    try {
      outcome = await postLoginAction(portal);
    } catch {
      outcome = { error: "forbidden" };
    }
    if ("error" in outcome) {
      // Se cierra la sesión recién creada: por acá no entra.
      await supabase.auth.signOut({ scope: "local" });
      setLoading(false);
      setError(t(outcome.error === "wrongPortal" ? "errWrongPortal" : "forbidden"));
      turnstile.current?.reset();
      return;
    }
    router.replace(outcome.next);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {error && <AuthAlert tone="danger">{error}</AuthAlert>}

      <div>
        <AuthLabel htmlFor="email">{t("email")}</AuthLabel>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={authInputCls}
          placeholder={t("emailPlaceholder")}
          autoComplete="username"
          autoFocus
          required
        />
      </div>

      <div>
        <AuthLabel
          htmlFor="password"
          aside={
            <Link
              // `?p=admin`: el "volver" de esa pantalla regresa a este login.
              href={portal === "admin" ? "/auth/forgot?p=admin" : "/auth/forgot"}
              className="text-sm font-medium text-brand hover:underline"
            >
              {t("forgotLink")}
            </Link>
          }
        >
          {t("password")}
        </AuthLabel>
        <PasswordInput
          id="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      <Turnstile ref={turnstile} onToken={setCaptcha} />

      <button
        type="submit"
        disabled={loading || !email.trim() || !password || (needsCaptcha && !captcha)}
        className={authButtonCls}
      >
        {loading ? (
          <LoaderCircle size={18} className="animate-spin" aria-hidden />
        ) : (
          <LogIn size={18} aria-hidden />
        )}
        {loading ? t("signingIn") : t("signIn")}
      </button>
    </form>
  );
}
