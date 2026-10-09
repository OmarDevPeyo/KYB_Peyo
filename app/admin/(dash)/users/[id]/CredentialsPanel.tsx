"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/ui/Field";
import type { AccountRow } from "@/lib/auth/accounts";
import {
  cancelPendingAction,
  changeEmailAction,
  resendAccessAction,
  sendResetLinkAction,
} from "../credentialActions";
import { Feedback, StepUpInput, useAccountAction } from "../formParts";
import { Section } from "./AccountPanels";

/**
 * Credenciales de otra cuenta. Qué se ofrece depende de la cuenta (mismas
 * reglas que canManageAccount, que el server vuelve a aplicar):
 * - nunca entró → reenviar el acceso (contraseña temporal nueva) o cancelarlo;
 * - ya entró → link para restablecer la contraseña (también a otro admin);
 * - usuario (no admin) → cambiar email.
 * La contraseña de otra cuenta nunca la elige ni la ve un admin.
 */
export function CredentialsPanel({ account }: { account: AccountRow }) {
  const isAdmin = account.role === "admin";
  return (
    <>
      <AccessSection account={account} />
      {!isAdmin && <EmailSection account={account} />}
    </>
  );
}

function AccessSection({ account }: { account: AccountRow }) {
  const t = useTranslations("accounts");
  const suspended = account.status === "suspended";
  const isAdmin = account.role === "admin";

  return (
    <Section title={t("accessTitle")} description={t("accessDescription")}>
      <div className="space-y-4">
        {account.pending ? <PendingBlock account={account} /> : <ResetLinkBlock account={account} />}
        {suspended ? (
          <p className="text-sm text-muted">{t("suspendedNote")}</p>
        ) : (
          isAdmin && <p className="text-sm text-muted">{t("otherAdminNote")}</p>
        )}
      </div>
    </Section>
  );
}

function PendingBlock({ account }: { account: AccountRow }) {
  const t = useTranslations("accounts");
  const tAll = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const resend = useAccountAction();
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  async function onCancel() {
    setCancelling(true);
    setCancelError(null);
    const res = await cancelPendingAction(account.userId).catch(() => ({ ok: false as const, error: "auth.errGeneric" }));
    if (res.ok) {
      // La cuenta ya no existe: volver a la lista.
      router.replace("/admin/users");
      return;
    }
    setCancelError(tAll(res.error));
    setCancelling(false);
  }

  return (
    <div>
      <p className="text-sm text-foreground">
        {account.accessSentAt
          ? t("accessPending", { date: format.dateTime(new Date(account.accessSentAt), { dateStyle: "medium", timeStyle: "short" }) })
          : t("accessPendingNoDate")}
      </p>
      {!confirming ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={resend.busy}
            onClick={() => resend.run(() => resendAccessAction(account.userId), t("accessResent"))}
          >
            {t("resendAccess")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            {t("cancelAccess")}
          </Button>
          <Feedback feedback={resend.feedback} />
        </div>
      ) : (
        <div className="mt-3 space-y-3 rounded-lg border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm text-foreground">{t("cancelAccessWarning", { email: account.email })}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="danger" size="sm" disabled={cancelling} onClick={onCancel}>
              {t("cancelAccess")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t("back")}
            </Button>
          </div>
          {cancelError && <Feedback feedback={{ tone: "error", text: cancelError }} />}
        </div>
      )}
    </div>
  );
}

function ResetLinkBlock({ account }: { account: AccountRow }) {
  const t = useTranslations("accounts");
  const action = useAccountAction();
  const suspended = account.status === "suspended";
  return (
    <div>
      <p className="text-sm text-muted">{t("resetLinkHint")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={action.busy || suspended}
          onClick={() =>
            action.run(() => sendResetLinkAction(account.userId), t("resetLinkSent", { email: account.email }))
          }
        >
          {t("sendResetLink")}
        </Button>
        <Feedback feedback={action.feedback} />
      </div>
    </div>
  );
}

function EmailSection({ account }: { account: AccountRow }) {
  const t = useTranslations("accounts");
  const action = useAccountAction();
  const [email, setEmail] = useState("");
  const [stepUpPassword, setStepUpPassword] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = await action.run(
      () => changeEmailAction(account.userId, email, stepUpPassword),
      t("emailChanged"),
    );
    if (ok) {
      setEmail("");
      setStepUpPassword("");
    }
  }

  return (
    <Section
      title={t("emailTitle")}
      description={account.pending ? t("emailPendingDescription") : t("emailDescription")}
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label htmlFor="acc-email" className="mb-1 block text-sm font-medium text-foreground">
            {t("newEmail")}
          </label>
          <input
            id="acc-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={account.email}
            autoComplete="off"
            className={inputCls}
            maxLength={254}
          />
        </div>
        {email.trim() && <StepUpInput id="email-stepup" value={stepUpPassword} onChange={setStepUpPassword} />}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={action.busy || !email.trim() || !stepUpPassword}>
            {t("changeEmail")}
          </Button>
          <Feedback feedback={action.feedback} />
        </div>
      </form>
    </Section>
  );
}
