"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { UserPlus } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { inputCls } from "@/components/ui/Field";
import type { OrgOption } from "@/lib/auth/tenant";
import type { Role } from "@/lib/auth/accountRules";
import { createAccountAction } from "./credentialActions";

type Outcome =
  | { tone: "ok"; text: string; userId: string }
  | { tone: "error"; text: string; userId?: string };

/**
 * Alta de una cuenta. La contraseña la genera el server y le llega a la
 * persona por correo: acá no se pide ni se ve ninguna contraseña.
 */
export function NewAccountPanel({ orgs, defaultOrg }: { orgs: OrgOption[]; defaultOrg: string }) {
  const t = useTranslations("accounts");
  const tAll = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [orgId, setOrgId] = useState(orgs.some((o) => o.id === defaultOrg) ? defaultOrg : (orgs[0]?.id ?? ""));
  const [role, setRole] = useState<Role>("analyst");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setOutcome(null);
    try {
      const res = await createAccountAction({ email, fullName, orgId, role });
      if (!res.ok) {
        setOutcome({ tone: "error", text: tAll(res.error), userId: res.existingUserId });
        return;
      }
      const shown = email.trim().toLowerCase();
      setOutcome({
        tone: "ok",
        text: res.linked ? t("linked", { email: shown }) : t("accessSent", { email: shown }),
        userId: res.userId,
      });
      setEmail("");
      setFullName("");
      setRole("analyst");
      router.refresh();
    } catch {
      setOutcome({ tone: "error", text: tAll("auth.errGeneric") });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={() => setOpen(true)}>
          <UserPlus size={16} aria-hidden />
          {t("newAccount")}
        </Button>
      </div>
    );
  }

  return (
    <Card className="mb-5 p-5">
      <h2 className="font-display text-lg font-semibold text-foreground">{t("newAccount")}</h2>
      <p className="mt-0.5 mb-4 text-sm text-muted">{t("newAccountDescription")}</p>
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="new-email" className="mb-1 block text-sm font-medium text-foreground">
            {t("email")}
          </label>
          <input
            id="new-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            className={inputCls}
            maxLength={254}
            required
          />
        </div>
        <div>
          <label htmlFor="new-name" className="mb-1 block text-sm font-medium text-foreground">
            {t("fullName")}
          </label>
          <input
            id="new-name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="off"
            className={inputCls}
            maxLength={120}
          />
        </div>
        <div>
          <label htmlFor="new-org-select" className="mb-1 block text-sm font-medium text-foreground">
            {t("org")}
          </label>
          <select
            id="new-org-select"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            className={inputCls}
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="new-role" className="mb-1 block text-sm font-medium text-foreground">
            {t("role")}
          </label>
          <select
            id="new-role"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className={inputCls}
          >
            <option value="analyst">{t("roleUser")}</option>
            <option value="admin">{t("roleAdmin")}</option>
          </select>
        </div>
        {role === "admin" && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-sm text-foreground sm:col-span-2">
            {t("promoteWarning")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" size="sm" disabled={busy || !email.trim() || !orgId}>
            {t("createAccount")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t("cancel")}
          </Button>
        </div>
      </form>
      {outcome && (
        <p
          role={outcome.tone === "error" ? "alert" : "status"}
          className={`mt-3 text-sm ${outcome.tone === "error" ? "text-danger" : "text-success"}`}
        >
          {outcome.text}
          {outcome.userId && (
            <>
              {" "}
              <Link href={`/admin/users/${outcome.userId}`} className="font-medium text-brand hover:underline">
                {t("viewAccount")}
              </Link>
            </>
          )}
        </p>
      )}
    </Card>
  );
}
