"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { KeyRound, LoaderCircle } from "lucide-react";
import { AuthAlert, authButtonCls } from "@/components/auth/authUi";
import { NewPasswordFields, newPasswordReady } from "@/components/auth/NewPasswordFields";
import { completePasswordResetAction } from "./actions";

export function ResetForm() {
  const t = useTranslations("auth");
  const tAll = useTranslations();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!newPasswordReady(password, confirm)) return;
    setLoading(true);
    setError(null);
    const res = await completePasswordResetAction(password).catch(() => ({
      ok: false as const,
      error: "auth.errGeneric",
    }));
    if (!res.ok) {
      setLoading(false);
      setError(tAll(res.error));
      return;
    }
    // La sesión del link ya es válida: directo al panel.
    router.replace("/admin");
    router.refresh();
  }

  return (
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
  );
}
