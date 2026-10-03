import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireAnalyst } from "@/lib/auth/admin";
import { loadOwnedRequest } from "@/lib/auth/tenant";
import { Card } from "@/components/ui/Card";
import { env } from "@/lib/env";
import { todayUtc } from "@/lib/forms/expiry";
import type { LocalizedText } from "@/lib/forms/definition";
import { loadRequestExpirations } from "@/lib/kyb/expirations";
import { loadRenewals } from "@/lib/kyb/renewals";
import { loadOrgBranding } from "@/lib/kyb/renewalEmail";
import { applicantMailMode } from "@/lib/mail/send";
import { RenewalEmailComposer } from "@/components/admin/RenewalEmailComposer";

export const dynamic = "force-dynamic";

/** Correo de renovación de una solicitud aprobada: preview, logo y envío. */
export default async function RenewalEmailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const analyst = await requireAnalyst();
  const t = await getTranslations("expirations");
  const { id } = await params;
  const req = await loadOwnedRequest(
    analyst,
    id,
    "id, status, external_ref, subject_title, contact_email",
  );
  if (!req) notFound();

  const back = (
    <Link
      href={`/admin/requests/${id}`}
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
    >
      <ArrowLeft size={16} aria-hidden />
      {t("composerBack")}
    </Link>
  );
  const title = (req.subject_title as string | null) || (req.external_ref as string);

  if (req.status !== "approved") {
    return (
      <main className="mx-auto w-full max-w-6xl p-4 sm:p-6">
        {back}
        <Card className="p-6 text-sm text-muted">{t("composerNotApproved")}</Card>
      </main>
    );
  }

  const [expirations, renewals, branding] = await Promise.all([
    loadRequestExpirations(id),
    loadRenewals(id),
    loadOrgBranding(req.org_id as string),
  ]);

  return (
    <main className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      {back}
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold text-foreground">{t("composerTitle")}</h1>
        <p className="mt-0.5 text-sm text-muted">{title}</p>
      </header>
      {expirations.length === 0 ? (
        <Card className="p-6 text-sm text-muted">{t("composerNoDocuments")}</Card>
      ) : (
        <RenewalEmailComposer
          requestId={id}
          orgId={req.org_id as string}
          orgName={branding.name}
          companyName={(req.subject_title as string | null) ?? null}
          contactEmail={(req.contact_email as string | null) ?? null}
          initialLogoUrl={branding.logoUrl}
          // Relativa en el preview: se resuelve contra el panel aunque
          // NEXT_PUBLIC_APP_URL apunte a otro host. El correo real usa la absoluta.
          fallbackLogoUrl="/peyo-logo.png"
          appUrl={env.appUrl()}
          documents={expirations.map((e) => ({
            fieldId: e.field_id,
            label: e.field_label as LocalizedText,
            expiresOn: e.expires_on,
          }))}
          today={todayUtc()}
          mode={applicantMailMode()}
          blocked={renewals.some((r) => r.state === "submitted")}
        />
      )}
    </main>
  );
}
