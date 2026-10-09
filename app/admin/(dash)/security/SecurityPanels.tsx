"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, Copy, LoaderCircle, LogOut, ShieldCheck, ShieldOff } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/ui/Field";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { NewPasswordFields, newPasswordReady } from "@/components/auth/NewPasswordFields";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { authErrorKey } from "@/lib/auth/authErrors";
import {
  changeEmailAction,
  changePasswordAction,
  logMfaChangeAction,
  signOutOthersAction,
  updateProfileAction,
} from "./actions";

/** Mensaje de resultado bajo cada formulario. */
type Feedback = { tone: "ok" | "error"; text: string } | null;

function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p
      role={feedback.tone === "error" ? "alert" : "status"}
      className={`text-sm ${feedback.tone === "error" ? "text-danger" : "text-success"}`}
    >
      {feedback.text}
    </p>
  );
}

function Section({
  id,
  title,
  description,
  aside,
  children,
}: {
  id?: string;
  title: string;
  description: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-4 p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-sm text-muted">{description}</p>
        </div>
        {aside}
      </div>
      {children}
    </Card>
  );
}

function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-foreground">
      {children}
    </label>
  );
}

function Spinner() {
  return <LoaderCircle size={16} className="animate-spin" aria-hidden />;
}

// ---------------------------------------------------------------------------

export function ProfileSection({ fullName }: { fullName: string }) {
  const t = useTranslations("security");
  const tAll = useTranslations();
  const router = useRouter();
  const [name, setName] = useState(fullName);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    const res = await updateProfileAction(name);
    setBusy(false);
    if (!res.ok) return setFeedback({ tone: "error", text: tAll(res.error) });
    setFeedback({ tone: "ok", text: t("profileSaved") });
    router.refresh();
  }

  return (
    <Section title={t("profileTitle")} description={t("profileDescription")}>
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <Label htmlFor="full-name">{t("fullName")}</Label>
          <input
            id="full-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
            maxLength={120}
            autoComplete="name"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={busy || !name.trim() || name.trim() === fullName}>
            {busy && <Spinner />}
            {t("save")}
          </Button>
          <FeedbackLine feedback={feedback} />
        </div>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function EmailSection({ email }: { email: string }) {
  const t = useTranslations("security");
  const tAll = useTranslations();
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    const res = await changeEmailAction(newEmail, password);
    setBusy(false);
    setPassword("");
    if (!res.ok) return setFeedback({ tone: "error", text: tAll(res.error) });
    setFeedback({ tone: "ok", text: t("emailSent", { email: newEmail.trim() }) });
    setOpen(false);
    setNewEmail("");
  }

  return (
    <Section
      title={t("emailTitle")}
      description={t("emailDescription")}
      aside={
        !open && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            {t("changeEmail")}
          </Button>
        )
      }
    >
      <p className="text-sm">
        <span className="text-muted">{t("currentEmail")}: </span>
        <span className="font-medium text-foreground">{email}</span>
      </p>
      {open && (
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div>
            <Label htmlFor="new-email">{t("newEmail")}</Label>
            <input
              id="new-email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className={inputCls}
              autoComplete="email"
              required
            />
          </div>
          <div>
            <Label htmlFor="email-password">{t("currentPassword")}</Label>
            <PasswordInput
              id="email-password"
              size="md"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || !newEmail.trim() || !password}>
              {busy && <Spinner />}
              {t("sendConfirmation")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
      <div className="mt-3">
        <FeedbackLine feedback={feedback} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function PasswordSection() {
  const t = useTranslations("security");
  const tAll = useTranslations();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!newPasswordReady(next, confirm)) return;
    setBusy(true);
    setFeedback(null);
    const res = await changePasswordAction(current, next);
    setBusy(false);
    if (!res.ok) return setFeedback({ tone: "error", text: tAll(res.error) });
    setCurrent("");
    setNext("");
    setConfirm("");
    setFeedback({ tone: "ok", text: t("passwordChanged") });
  }

  return (
    <Section title={t("passwordTitle")} description={t("passwordDescription")}>
      <form onSubmit={onSubmit} className="max-w-md space-y-4">
        <div>
          <Label htmlFor="current-password">{t("currentPassword")}</Label>
          <PasswordInput
            id="current-password"
            size="md"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <NewPasswordFields
          size="md"
          password={next}
          confirm={confirm}
          onPassword={setNext}
          onConfirm={setConfirm}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            size="sm"
            disabled={busy || !current || !newPasswordReady(next, confirm)}
          >
            {busy && <Spinner />}
            {t("changePassword")}
          </Button>
          <FeedbackLine feedback={feedback} />
        </div>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------

type Enrollment = { factorId: string; qr: string; secret: string };

export function MfaSection({
  factor,
  autoStart = false,
}: {
  /** Factor TOTP verificado, si el 2FA está activo. */
  factor: { id: string; createdAt: string } | null;
  /** Arranca el alta al abrir (viene de "Activar ahora" del primer ingreso). */
  autoStart?: boolean;
}) {
  const t = useTranslations("security");
  const tAuth = useTranslations("auth");
  const router = useRouter();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const autoStarted = useRef(false);

  async function start() {
    setBusy(true);
    setError(null);
    const supabase = createBrowserSupabase();
    // Un intento anterior abandonado deja un factor sin verificar: se limpia
    // para que no se acumulen (y no choque el nombre).
    const { data: list } = await supabase.auth.mfa.listFactors();
    for (const f of list?.all ?? []) {
      if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "Peyo KYB",
      issuer: "Peyo KYB",
    });
    setBusy(false);
    if (error || !data) return setError(tAuth(authErrorKey(error)));
    // `qr_code` ya viene como data URL (SVG).
    setEnrollment({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  // Una sola vez (en dev React monta dos veces y serían dos altas).
  useEffect(() => {
    if (!autoStart || factor || autoStarted.current) return;
    autoStarted.current = true;
    document.getElementById("mfa")?.scrollIntoView({ block: "start" });
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al montar
  }, []);

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!enrollment || code.length !== 6) return;
    setBusy(true);
    setError(null);
    const { error } = await createBrowserSupabase().auth.mfa.challengeAndVerify({
      factorId: enrollment.factorId,
      code,
    });
    if (error) {
      setBusy(false);
      setCode("");
      return setError(tAuth(authErrorKey(error)));
    }
    await logMfaChangeAction(true);
    setBusy(false);
    setEnrollment(null);
    setCode("");
    router.refresh();
  }

  async function disable() {
    if (!factor) return;
    setBusy(true);
    setError(null);
    const { error } = await createBrowserSupabase().auth.mfa.unenroll({ factorId: factor.id });
    setConfirmDisable(false);
    if (error) {
      setBusy(false);
      return setError(tAuth(authErrorKey(error)));
    }
    await logMfaChangeAction(false);
    setBusy(false);
    router.refresh();
  }

  const status = factor ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-xs font-semibold text-success">
      <ShieldCheck size={14} aria-hidden />
      {t("mfaOn")}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-muted">
      <ShieldOff size={14} aria-hidden />
      {t("mfaOff")}
    </span>
  );

  return (
    <Section id="mfa" title={t("mfaTitle")} description={t("mfaDescription")} aside={status}>
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}

      {factor && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {t("mfaSince", { date: new Date(factor.createdAt).toLocaleDateString() })}
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmDisable(true)}>
            {t("mfaDisable")}
          </Button>
        </div>
      )}

      {!factor && !enrollment && (
        <Button size="sm" disabled={busy} onClick={start}>
          {busy && <Spinner />}
          {t("mfaEnable")}
        </Button>
      )}

      {!factor && enrollment && (
        <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL generada por Supabase */}
          <img
            src={enrollment.qr}
            alt={t("mfaQrAlt")}
            className="h-44 w-44 rounded-xl border border-border bg-white p-2"
          />
          <div className="min-w-0 space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
              <li>{t("mfaStep1")}</li>
              <li>{t("mfaStep2")}</li>
              <li>{t("mfaStep3")}</li>
            </ol>
            <div>
              <p className="mb-1 text-xs text-muted">{t("mfaSecret")}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-2 py-1.5 font-mono text-xs text-foreground">
                  {enrollment.secret}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={t("copy")}
                  title={t("copy")}
                  onClick={() => {
                    navigator.clipboard?.writeText(enrollment.secret);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                </Button>
              </div>
            </div>
            <form onSubmit={verify} className="flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor="mfa-enroll-code">{t("mfaCode")}</Label>
                <input
                  id="mfa-enroll-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  className={`${inputCls} w-36 text-center font-mono tracking-[0.3em]`}
                />
              </div>
              <Button type="submit" size="sm" disabled={busy || code.length !== 6}>
                {busy && <Spinner />}
                {t("mfaActivate")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEnrollment(null)}>
                {t("cancel")}
              </Button>
            </form>
          </div>
        </div>
      )}

      {confirmDisable && (
        <ConfirmModal
          title={t("mfaDisableTitle")}
          body={t("mfaDisableBody")}
          confirmLabel={t("mfaDisable")}
          cancelLabel={t("cancel")}
          danger
          busy={busy}
          onConfirm={disable}
          onCancel={() => setConfirmDisable(false)}
        />
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function SessionsSection() {
  const t = useTranslations("security");
  const tAll = useTranslations();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function onClick() {
    setBusy(true);
    setFeedback(null);
    const res = await signOutOthersAction();
    setBusy(false);
    setFeedback(
      res.ok ? { tone: "ok", text: t("othersSignedOut") } : { tone: "error", text: tAll(res.error) },
    );
  }

  return (
    <Section title={t("sessionsTitle")} description={t("sessionsDescription")}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={busy} onClick={onClick}>
          {busy ? <Spinner /> : <LogOut size={16} aria-hidden />}
          {t("signOutOthers")}
        </Button>
        <FeedbackLine feedback={feedback} />
      </div>
    </Section>
  );
}
