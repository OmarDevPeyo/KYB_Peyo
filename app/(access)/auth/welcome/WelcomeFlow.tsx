"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { AuthAlert, AuthHeading, authButtonCls } from "@/components/auth/authUi";
import { NewPasswordFields, newPasswordReady } from "@/components/auth/NewPasswordFields";
import { signOutAction } from "@/app/admin/actions";
import { setFirstPasswordAction } from "./actions";

/**
 * Los dos pasos del primer ingreso: elegir la contraseña propia y, recién
 * después, la oferta de activar la verificación en dos pasos (opcional).
 */
export function WelcomeFlow({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  const t = useTranslations("auth");
  const tAll = useTranslations();
  const [step, setStep] = useState<"password" | "mfa">("password");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!newPasswordReady(password, confirm)) return;
    setLoading(true);
    setError(null);
    const res = await setFirstPasswordAction(password).catch(() => ({
      ok: false as const,
      error: "auth.errGeneric",
    }));
    setLoading(false);
    if (!res.ok) {
      setError(tAll(res.error));
      return;
    }
    setPassword("");
    setConfirm("");
    setStep("mfa");
  }

  if (step === "mfa") {
    return (
      <>
        <AuthHeading title={t("welcomeMfaTitle")} subtitle={t("welcomeMfaBody")} />
        <div>
          <AuthAlert tone="success">{t("welcomePasswordSaved")}</AuthAlert>
          {isAdmin && <AuthAlert tone="info">{t("welcomeMfaAdmin")}</AuthAlert>}
          <Link href="/admin/security?mfa=1" className={authButtonCls}>
            <ShieldCheck size={18} aria-hidden />
            {t("welcomeMfaNow")}
          </Link>
          <Link
            href="/admin"
            className="mt-4 block text-center text-sm font-medium text-brand hover:underline"
          >
            {t("welcomeMfaLater")}
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <AuthHeading title={t("welcomeTitle")} subtitle={t("welcomeSubtitle", { email })} />
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {error && <AuthAlert tone="danger">{error}</AuthAlert>}
        <NewPasswordFields
          password={password}
          confirm={confirm}
          onPassword={setPassword}
          onConfirm={setConfirm}
        />
        <button
          type="submit"
          disabled={loading || !newPasswordReady(password, confirm)}
          className={authButtonCls}
        >
          {loading ? (
            <LoaderCircle size={18} className="animate-spin" aria-hidden />
          ) : (
            <KeyRound size={18} aria-hidden />
          )}
          {t("savePassword")}
        </button>
      </form>
      <form action={signOutAction} className="mt-6 text-sm">
        <button className="cursor-pointer font-medium text-brand hover:underline">
          {t("useOtherAccount")}
        </button>
      </form>
    </>
  );
}
