import { getTranslations } from "next-intl/server";
import { CheckCircle2 } from "lucide-react";
import { requireAnalyst } from "@/lib/auth/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import {
  EmailSection,
  MfaSection,
  PasswordSection,
  ProfileSection,
  SessionsSection,
} from "./SecurityPanels";

export const dynamic = "force-dynamic";

/**
 * Seguridad de la propia cuenta: nombre, email, contraseña, 2FA y sesiones.
 * Todo actúa sobre quien está en sesión; ninguna acción recibe un id de usuario.
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; mfa?: string }>;
}) {
  const analyst = await requireAnalyst();
  const t = await getTranslations("security");
  const { email, mfa } = await searchParams;

  // Factores desde el servidor de Auth (no desde la cookie).
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const totp = (user?.factors ?? []).find(
    (f) => f.factor_type === "totp" && f.status === "verified",
  );

  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-0.5 text-sm text-muted">
          {t("subtitle", { org: analyst.orgName })}
        </p>
      </header>

      {email === "changed" && (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-xl border border-success/30 bg-success/10 p-3 text-sm text-foreground"
        >
          <CheckCircle2 size={18} className="shrink-0 text-success" aria-hidden />
          {t("emailChanged", { email: analyst.email })}
        </div>
      )}

      <div className="space-y-4">
        <ProfileSection fullName={analyst.fullName ?? ""} />
        <EmailSection email={analyst.email} />
        <PasswordSection />
        <MfaSection
          factor={totp ? { id: totp.id, createdAt: totp.created_at } : null}
          autoStart={mfa === "1"}
        />
        <SessionsSection />
      </div>
    </main>
  );
}
