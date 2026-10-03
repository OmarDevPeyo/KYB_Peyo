import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { resolveText } from "@/lib/forms/definition";
import { todayUtc } from "@/lib/forms/expiry";
import { buildRenewalEmail, type RenewalEmail, type RenewalEmailLocale } from "@/lib/mail/renewalTemplate";
import type { RenewalRow } from "@/lib/kyb/renewals";

/** Bucket público de imágenes del panel (0005): el logo tiene que verse en el correo. */
export const LOGO_BUCKET = "form-assets";

export interface OrgBranding {
  name: string;
  logoUrl: string | null;
  logoPath: string | null;
}

export async function loadOrgBranding(orgId: string): Promise<OrgBranding> {
  const { data } = await createServiceClient()
    .from("organizations")
    .select("name, logo_url, logo_path")
    .eq("id", orgId)
    .maybeSingle();
  return {
    name: (data?.name as string | undefined) ?? "Peyo",
    logoUrl: (data?.logo_url as string | null | undefined) ?? null,
    logoPath: (data?.logo_path as string | null | undefined) ?? null,
  };
}

/** Logo de respaldo: el de Peyo, servido por la app (public/). */
export function fallbackLogoUrl(): string {
  return `${env.appUrl()}/peyo-logo.png`;
}

/** El correo de una ronda, armado con los datos de la base (nunca con HTML del cliente). */
export function renewalEmailFor(
  round: RenewalRow,
  ctx: { branding: OrgBranding; companyName: string | null; url: string },
): RenewalEmail {
  const locale: RenewalEmailLocale = round.locale === "en" ? "en" : "es";
  return buildRenewalEmail({
    locale,
    orgName: ctx.branding.name,
    logoUrl: ctx.branding.logoUrl ?? fallbackLogoUrl(),
    companyName: ctx.companyName,
    documents: round.fields.map((f) => ({
      label: resolveText(f.label, locale) || f.fieldKey,
      expiresOn: f.expiresOn,
    })),
    renewalUrl: ctx.url,
    linkExpiresAt: round.token_expires_at,
    note: round.email_note,
    today: todayUtc(),
  });
}
