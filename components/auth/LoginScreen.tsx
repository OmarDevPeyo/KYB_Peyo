import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAuthState } from "@/lib/auth/admin";
import type { Portal } from "@/lib/auth/accountRules";
import { signOutAction } from "@/app/admin/actions";
import { AuthAlert, AuthHeading } from "./authUi";
import { LoginForm } from "./LoginForm";

/**
 * Pantalla de login de un portal: /login (usuarios) o /admin/login (admin).
 * Misma forma; cambian el título y a qué rol acepta (ver postLoginAction).
 */
export async function LoginScreen({
  portal,
  error,
  reset,
}: {
  portal: Portal;
  error?: string;
  reset?: string;
}) {
  // Con sesión y acceso ya no hay nada que hacer acá. Se pregunta por el
  // ANALISTA y no solo por el usuario: alguien autenticado sin fila en
  // `analysts` rebotaba entre /admin y el login sin ver ningún mensaje.
  const { state } = await getAuthState();
  if (state.kind === "mfa_pending") redirect("/auth/mfa");
  if (state.kind === "suspended") redirect("/auth/suspended");
  if (state.kind === "password_setup") redirect("/auth/welcome");
  if (state.kind === "active") redirect("/admin");

  const t = await getTranslations("auth");
  const admin = portal === "admin";

  return (
    <>
      <AuthHeading
        title={admin ? t("adminLoginTitle") : t("loginTitle")}
        subtitle={admin ? t("adminLoginSubtitle") : t("loginSubtitle")}
      />

      {error === "forbidden" && (
        <AuthAlert tone="danger">
          <p>{t("forbidden")}</p>
          <form action={signOutAction} className="mt-2">
            <button className="cursor-pointer font-medium text-brand hover:underline">
              {t("useOtherAccount")}
            </button>
          </form>
        </AuthAlert>
      )}
      {reset === "1" && <AuthAlert tone="success">{t("passwordUpdated")}</AuthAlert>}

      <LoginForm portal={portal} />
    </>
  );
}
