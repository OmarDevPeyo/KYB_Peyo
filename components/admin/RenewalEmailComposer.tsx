"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ImagePlus, Mail, Trash2 } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { resolveText, type LocalizedText } from "@/lib/forms/definition";
import { expiryStatus } from "@/lib/forms/expiry";
import { buildRenewalEmail, type RenewalEmailLocale } from "@/lib/mail/renewalTemplate";
import {
  removeOrgLogoAction,
  sendRenewalEmailAction,
  uploadOrgLogoAction,
} from "@/app/admin/(dash)/expirations/actions";

/** Igual que `MailMode` (lib/mail/send.ts, que es server-only). */
type MailMode = "resend" | "log" | "off";

export interface ComposerDocument {
  fieldId: string;
  label: LocalizedText;
  expiresOn: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOTE_MAX = 1000;
const TTL_DAYS = [7, 14, 30];

const inputCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none focus:border-brand focus:ring-2 focus:ring-brand/30";

/**
 * Correo de renovación: el analista elige destinatario, idioma, documentos,
 * vigencia del link y una nota; el preview se arma en vivo con la misma
 * plantilla que usa el servidor. El link real se genera recién al enviar.
 */
export function RenewalEmailComposer({
  requestId,
  orgId,
  orgName,
  companyName,
  contactEmail,
  initialLogoUrl,
  fallbackLogoUrl,
  appUrl,
  documents,
  today,
  mode,
  blocked,
}: {
  requestId: string;
  orgId: string;
  orgName: string;
  companyName: string | null;
  contactEmail: string | null;
  initialLogoUrl: string | null;
  fallbackLogoUrl: string;
  appUrl: string;
  documents: ComposerDocument[];
  today: string;
  mode: MailMode;
  /** Hay una renovación enviada esperando revisión. */
  blocked: boolean;
}) {
  const t = useTranslations("expirations");
  const tAll = useTranslations();
  const uiLocale = useLocale();
  const defaults = useMemo(() => {
    const expired = documents.filter((d) => expiryStatus(d.expiresOn, today) === "expired");
    const pick = expired.length
      ? expired
      : documents.filter((d) => expiryStatus(d.expiresOn, today) === "expiring");
    return new Set(pick.map((d) => d.fieldId));
  }, [documents, today]);

  const [to, setTo] = useState(contactEmail ?? "");
  const [locale, setLocale] = useState<RenewalEmailLocale>(uiLocale === "en" ? "en" : "es");
  const [selected, setSelected] = useState<Set<string>>(defaults);
  const [ttl, setTtl] = useState(14);
  const [note, setNote] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(initialLogoUrl);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ mode: MailMode; url?: string; unconfirmed?: boolean } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  // El vencimiento del link del preview es aproximado: el real lo fija el envío.
  const [previewNow] = useState(() => Date.now());
  const preview = useMemo(
    () =>
      buildRenewalEmail({
        locale,
        orgName,
        logoUrl: logoUrl ?? fallbackLogoUrl,
        companyName,
        documents: documents
          .filter((d) => selected.has(d.fieldId))
          .map((d) => ({ label: resolveText(d.label, locale), expiresOn: d.expiresOn })),
        renewalUrl: `${appUrl}/f/${t("composerPlaceholderToken")}`,
        linkExpiresAt: new Date(previewNow + ttl * 86_400_000).toISOString(),
        note: note || null,
        today,
      }),
    [locale, orgName, logoUrl, fallbackLogoUrl, companyName, documents, selected, appUrl, t, previewNow, ttl, note, today],
  );

  const emailOk = EMAIL_RE.test(to.trim());
  const canSend = !blocked && mode !== "off" && emailOk && selected.size > 0 && !pending;

  async function onLogo(file: File) {
    setLogoError(null);
    setLogoBusy(true);
    const fd = new FormData();
    fd.set("file", file);
    const res = await uploadOrgLogoAction(orgId, fd);
    setLogoBusy(false);
    if (fileRef.current) fileRef.current.value = "";
    if (!res.ok) {
      setLogoError(tAll(res.error));
      return;
    }
    setLogoUrl(res.url);
  }

  async function onRemoveLogo() {
    setLogoError(null);
    setLogoBusy(true);
    const res = await removeOrgLogoAction(orgId);
    setLogoBusy(false);
    if (!res.ok) {
      setLogoError(tAll(res.error));
      return;
    }
    setLogoUrl(null);
  }

  function send() {
    setError(null);
    startTransition(async () => {
      const res = await sendRenewalEmailAction(requestId, {
        to,
        locale,
        fieldIds: [...selected],
        note,
        ttlDays: ttl,
      });
      if (!res.ok) {
        setError(tAll(res.error));
        return;
      }
      setResult({ mode: res.mode, url: res.url, unconfirmed: res.unconfirmed });
    });
  }

  if (result) {
    return (
      <Card className="mx-auto max-w-xl p-6 text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-success/15 text-success">
          <Mail size={20} aria-hidden />
        </span>
        <h2 className="font-display text-xl font-bold text-foreground">
          {result.mode === "log" ? t("composerSentLocalTitle") : t("composerSent", { email: to.trim() })}
        </h2>
        {result.mode === "log" && <p className="mt-2 text-sm text-muted">{t("composerSentLocal")}</p>}
        {result.unconfirmed && <p className="mt-2 text-sm text-foreground">{t("composerUnconfirmed")}</p>}
        {result.url && (
          <input
            readOnly
            value={result.url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={t("linkLabel")}
            className="mt-3 w-full rounded-lg border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-foreground"
          />
        )}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href={`/admin/requests/${requestId}`} className={buttonClass({ variant: "outline", size: "sm" })}>
            {t("viewRequest")}
          </Link>
          <Link href="/admin/expirations" className={buttonClass({ variant: "quiet", size: "sm" })}>
            {t("composerBackToList")}
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <div className="space-y-5">
        {blocked && (
          <p className="rounded-lg border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-foreground">
            {t("composerBlocked")}
          </p>
        )}
        {mode !== "resend" && (
          <p
            className={`rounded-lg border px-3 py-2 text-sm text-foreground ${
              mode === "off" ? "border-danger/40 bg-danger/10" : "border-warning/40 bg-warning/10"
            }`}
          >
            {mode === "off" ? t("composerModeOff") : t("composerModeLog")}
          </p>
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">{t("composerTo")}</span>
          <input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="cliente@empresa.com"
            className={inputCls}
          />
          <span className={`mt-1 block text-xs ${to && !emailOk ? "text-danger" : "text-muted"}`}>
            {to && !emailOk ? tAll("expirations.errEmail") : t("composerToHint")}
          </span>
        </label>

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-foreground">{t("composerLocale")}</legend>
          <div className="inline-flex rounded-lg border border-border p-0.5">
            {(["es", "en"] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={locale === l}
                onClick={() => setLocale(l)}
                className={`rounded-md px-3 py-1 text-sm font-medium ${
                  locale === l ? "bg-brand text-white" : "text-muted hover:text-foreground"
                }`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1 text-sm font-medium text-foreground">{t("composerDocuments")}</legend>
          <ul className="space-y-1.5">
            {documents.map((d) => {
              const status = expiryStatus(d.expiresOn, today);
              return (
                <li key={d.fieldId}>
                  <label className="flex items-start gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-brand"
                      checked={selected.has(d.fieldId)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(d.fieldId);
                        else next.delete(d.fieldId);
                        setSelected(next);
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block">{resolveText(d.label, uiLocale)}</span>
                      <span className="block text-xs text-muted">{t(`status_${status}`)}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">{t("linkTtl")}</span>
          <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className={inputCls}>
            {TTL_DAYS.map((d) => (
              <option key={d} value={d}>
                {t("linkTtlDays", { days: d })}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">{t("composerNote")}</span>
          <textarea
            rows={4}
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("composerNotePlaceholder")}
            className={inputCls}
          />
          <span className="mt-1 block text-xs text-muted">
            {t("composerNoteHint", { count: note.length, max: NOTE_MAX })}
          </span>
        </label>

        <div>
          <span className="mb-1 block text-sm font-medium text-foreground">{t("composerLogo")}</span>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex h-12 min-w-24 items-center justify-center rounded-lg border border-border bg-white px-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- logo de Storage, sin optimizar */}
              <img src={logoUrl ?? fallbackLogoUrl} alt="" className="max-h-9 w-auto" />
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onLogo(f);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={logoBusy}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus size={16} aria-hidden />
              {logoUrl ? t("composerLogoChange") : t("composerLogoUpload")}
            </Button>
            {logoUrl && (
              <Button type="button" size="sm" variant="quiet" disabled={logoBusy} onClick={onRemoveLogo}>
                <Trash2 size={16} aria-hidden />
                {t("composerLogoRemove")}
              </Button>
            )}
          </div>
          <span className={`mt-1 block text-xs ${logoError ? "text-danger" : "text-muted"}`}>
            {logoError ?? t("composerLogoHint", { org: orgName })}
          </span>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="button" disabled={!canSend} onClick={send} className="w-full">
          <Mail size={16} aria-hidden />
          {pending
            ? t("composerSending")
            : mode === "log"
              ? t("composerSendLocal")
              : t("composerSend", { email: emailOk ? to.trim() : "…" })}
        </Button>
      </div>

      <div className="min-w-0">
        <p className="mb-1 text-sm font-medium text-foreground">{t("composerPreview")}</p>
        <p className="mb-2 truncate text-sm text-muted">
          {t("composerSubject")}: <span className="text-foreground">{preview.subject}</span>
        </p>
        {/* Sin permisos: el HTML del correo no corre scripts ni navega. */}
        <iframe
          title={t("composerPreview")}
          sandbox=""
          srcDoc={preview.html}
          className="h-190 w-full rounded-xl border border-border bg-white"
        />
      </div>
    </div>
  );
}
