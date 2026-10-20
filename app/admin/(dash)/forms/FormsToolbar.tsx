"use client";

import { useState, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, buttonClass } from "@/components/ui/Button";
import { OrgSelect } from "@/components/admin/OrgSelect";
import type { OrgOption } from "@/lib/auth/tenant";
import { createForm, importFormJson, installSystemFormAction } from "./actions";
import { GLOBALFLOW_KYB_KEY } from "@/lib/forms/system/keys";

export function FormsToolbar({
  showArchived = false,
  orgs = [],
  defaultOrg = "",
  orgParam = "",
}: {
  showArchived?: boolean;
  /** Solo para el admin: en qué org crear. Vacío para un miembro. */
  orgs?: OrgOption[];
  /** Org preseleccionada (la pestaña actual, o la del admin en "Todas"). */
  defaultOrg?: string;
  /** `?org=` actual, para no perder la pestaña al alternar archivados. */
  orgParam?: string;
}) {
  const t = useTranslations("forms");
  const tOrgs = useTranslations("orgs");
  const [showImport, setShowImport] = useState(false);
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [org, setOrg] = useState(defaultOrg);
  const router = useRouter();

  // Solo el admin ve el selector de org, y solo él instala formularios del sistema.
  async function onInstall() {
    setBusy(true);
    setError(null);
    const res = await installSystemFormAction(GLOBALFLOW_KYB_KEY, org || null);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else if (res.id) router.push(`/admin/forms/${res.id}/edit`);
  }

  async function onImport() {
    setBusy(true);
    setError(null);
    const res = await importFormJson(json, org || null);
    setBusy(false);
    if (res && !res.ok) setError(res.error);
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite re-seleccionar el mismo archivo
    if (!file) return;
    setError(null);
    try {
      setJson(await file.text());
    } catch {
      setError(t("readError"));
    }
  }

  const archivedHref = (archived: boolean) => {
    const params = new URLSearchParams();
    if (archived) params.set("archived", "1");
    if (orgParam) params.set("org", orgParam);
    const qs = params.toString();
    return qs ? `/admin/forms?${qs}` : "/admin/forms";
  };

  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      {orgs.length > 0 && (
        <OrgSelect orgs={orgs} label={tOrgs("createIn")} value={org} onChange={setOrg} />
      )}
      <form action={createForm}>
        {org && <input type="hidden" name="org" value={org} />}
        <Button type="submit">{t("newForm")}</Button>
      </form>
      <Button variant="outline" onClick={() => setShowImport((s) => !s)}>
        {t("importJson")}
      </Button>
      {orgs.length > 0 && (
        <Button variant="outline" onClick={onInstall} disabled={busy || !org}>
          {t("installSystem")}
        </Button>
      )}
      {/* Los archivados viven en su propia vista: se llega por query string para
          que el enlace sea compartible y el back del navegador funcione. */}
      <Link
        href={archivedHref(!showArchived)}
        className={buttonClass({ variant: "quiet", size: "sm", className: "ml-auto" })}
      >
        {showArchived ? t("showActive") : t("showArchived")}
      </Link>

      {error && !showImport && <p className="w-full text-sm text-danger">{error}</p>}
      {showImport && (
        <div className="mt-2 w-full">
          <p className="mb-1 text-sm text-muted">{t("importHint")}</p>
          <label className="mb-2 inline-flex cursor-pointer items-center gap-2">
            <span className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover">
              {t("chooseFile")}
            </span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={onFile}
              aria-label={t("chooseFile")}
              className="hidden"
            />
          </label>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder='{ "version": 1, "title": {...}, "sections": [...] }'
            rows={6}
            className="w-full rounded-lg border border-border bg-surface p-2 font-mono text-xs text-foreground outline-none focus:border-brand"
          />
          {error && <p className="mt-1 text-sm text-danger">{error}</p>}
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={onImport} disabled={busy || !json.trim()}>
              {busy ? "…" : t("import")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowImport(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
