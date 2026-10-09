import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Mail, ShieldX } from "lucide-react";
import { getAuthState, loginPathFor } from "@/lib/auth/admin";
import { suspensionInfo } from "@/lib/auth/suspension";
import { signOutAction } from "@/app/admin/actions";
import { authButtonCls } from "@/components/auth/authUi";

export const dynamic = "force-dynamic";

/**
 * Pantalla de cuenta (u organización) suspendida. Se llega después de iniciar
 * sesión: la suspensión no banea en Supabase Auth justamente para poder
 * mostrar esto con el email del admin a contactar (0028_accounts.sql).
 */
export default async function SuspendedPage() {
  const s = await getAuthState();
  if (s.state.kind === "signed_out") redirect(await loginPathFor(null));
  if (s.state.kind === "mfa_pending") redirect("/auth/mfa");
  if (s.state.kind !== "suspended") {
    redirect(s.state.kind === "active" || s.state.kind === "password_setup" ? "/admin" : "/login");
  }

  const t = await getTranslations("auth");
  const { contactEmail, orgName } = await suspensionInfo(s.userId!, s.state.scope);
  const isOrg = s.state.scope === "org";

  return (
    <div className="text-center sm:text-left">
      <span className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-danger/10 text-danger sm:mx-0">
        <ShieldX size={28} aria-hidden />
      </span>
      <h1 className="font-display text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
        {isOrg ? t("suspendedOrgTitle") : t("suspendedTitle")}
      </h1>
      <p className="mt-3 text-base text-muted">
        {isOrg ? t("suspendedOrgBody", { org: orgName ?? "" }) : t("suspendedBody")}
      </p>

      <div className="mt-6 rounded-xl border border-border bg-surface p-4">
        <p className="text-sm text-muted">{t("suspendedContact")}</p>
        {contactEmail ? (
          <a
            href={`mailto:${contactEmail}`}
            className="mt-1 inline-flex items-center gap-2 text-lg font-semibold break-all text-brand hover:underline"
          >
            <Mail size={18} aria-hidden className="shrink-0" />
            {contactEmail}
          </a>
        ) : (
          <p className="mt-1 text-base font-medium text-foreground">{t("suspendedNoContact")}</p>
        )}
      </div>

      <form action={signOutAction} className="mt-6">
        <button className={authButtonCls}>{t("signOut")}</button>
      </form>
      <p className="mt-3 text-xs text-muted">{t("suspendedAs", { email: s.email ?? "" })}</p>
    </div>
  );
}
