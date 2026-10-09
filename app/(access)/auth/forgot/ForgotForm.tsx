"use client";

import { useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { LoaderCircle, Mail } from "lucide-react";
import { Turnstile, turnstileEnabled, type TurnstileHandle } from "@/components/auth/Turnstile";
import { AuthAlert, AuthLabel, authButtonCls, authInputCls } from "@/components/auth/authUi";
import { requestPasswordResetAction } from "./actions";

/**
 * Pide el correo de recuperación. Lo arma y lo manda la app (Resend); el link
 * lleva a /auth/confirm.
 */
export function ForgotForm() {
  const t = useTranslations("auth");
  const tAll = useTranslations();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle>(null);
  const needsCaptcha = turnstileEnabled();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (needsCaptcha && !captcha) {
      setError(t("errCaptchaPending"));
      return;
    }
    setLoading(true);
    setError(null);
    // La acción responde lo mismo exista o no la cuenta (ver actions.ts).
    const res = await requestPasswordResetAction(email, captcha).catch(() => ({
      ok: false as const,
      error: "auth.errGeneric",
    }));
    setLoading(false);
    turnstile.current?.reset();
    if (!res.ok) {
      setError(tAll(res.error));
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <AuthAlert tone="success">
        <p className="font-medium">{t("forgotSentTitle")}</p>
        <p className="mt-1 text-muted">{t("forgotSentBody", { email: email.trim() })}</p>
      </AuthAlert>
    );
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
      <Turnstile ref={turnstile} onToken={setCaptcha} />
      <button
        type="submit"
        disabled={loading || !email.trim() || (needsCaptcha && !captcha)}
        className={authButtonCls}
      >
        {loading ? (
          <LoaderCircle size={18} className="animate-spin" aria-hidden />
        ) : (
          <Mail size={18} aria-hidden />
        )}
        {t("forgotSubmit")}
      </button>
    </form>
  );
}
